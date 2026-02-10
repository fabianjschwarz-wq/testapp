#!/usr/bin/env python3
import json
import mimetypes
import os
import re
import sqlite3
import ssl
import threading
from datetime import datetime, timezone
from email import message_from_bytes
from email.message import EmailMessage
from email.utils import parsedate_to_datetime
import imaplib
import smtplib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).parent
DB_PATH = ROOT / "mailchat.db"
STATIC_DIR = ROOT / "static"
DB_LOCK = threading.Lock()

NOREPLY_RE = re.compile(r"(?i)(^|[._-])(no[._-]?reply|noreply|do[._-]?not[._-]?reply|mailer-daemon|newsletter|marketing)([._-]|$)")


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def init_db() -> None:
    with DB_LOCK, sqlite3.connect(DB_PATH) as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS accounts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                email TEXT NOT NULL UNIQUE,
                imap_host TEXT NOT NULL,
                imap_port INTEGER NOT NULL,
                smtp_host TEXT NOT NULL,
                smtp_port INTEGER NOT NULL,
                password TEXT NOT NULL,
                use_ssl INTEGER NOT NULL DEFAULT 1,
                smtp_security TEXT NOT NULL DEFAULT 'auto',
                created_at TEXT NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                account_id INTEGER NOT NULL,
                contact_email TEXT NOT NULL,
                direction TEXT NOT NULL CHECK(direction IN ('inbound', 'outbound')),
                subject TEXT,
                body TEXT NOT NULL,
                body_html TEXT,
                sent_at TEXT NOT NULL,
                external_message_id TEXT,
                created_at TEXT NOT NULL,
                UNIQUE(account_id, external_message_id),
                FOREIGN KEY(account_id) REFERENCES accounts(id)
            )
            """
        )
        cols = {row[1] for row in conn.execute("PRAGMA table_info(accounts)").fetchall()}
        if "smtp_security" not in cols:
            conn.execute("ALTER TABLE accounts ADD COLUMN smtp_security TEXT NOT NULL DEFAULT 'auto'")
        mcols = {row[1] for row in conn.execute("PRAGMA table_info(messages)").fetchall()}
        if "body_html" not in mcols:
            conn.execute("ALTER TABLE messages ADD COLUMN body_html TEXT")


def db_fetch_all(query: str, params=()):
    with DB_LOCK, sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        return [dict(r) for r in conn.execute(query, params).fetchall()]


def db_execute(query: str, params=()):
    with DB_LOCK, sqlite3.connect(DB_PATH) as conn:
        cur = conn.execute(query, params)
        conn.commit()
        return cur.lastrowid


def json_response(handler: BaseHTTPRequestHandler, data, status=200):
    body = json.dumps(data).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def parse_json_body(handler: BaseHTTPRequestHandler):
    length = int(handler.headers.get("Content-Length", "0"))
    raw = handler.rfile.read(length)
    return json.loads(raw) if raw else {}


def decode_payload(part) -> str:
    payload = part.get_payload(decode=True) or b""
    charset = part.get_content_charset() or "utf-8"
    return payload.decode(charset, errors="replace").strip()


def extract_bodies(msg) -> tuple[str, str | None]:
    text = ""
    html = None
    if msg.is_multipart():
        for part in msg.walk():
            ctype = part.get_content_type()
            dispo = part.get("Content-Disposition") or ""
            if "attachment" in dispo.lower():
                continue
            if ctype == "text/plain" and not text:
                text = decode_payload(part)
            elif ctype == "text/html" and not html:
                html = decode_payload(part)
    else:
        ctype = msg.get_content_type()
        if ctype == "text/html":
            html = decode_payload(msg)
        else:
            text = decode_payload(msg)
    if not text and html:
        text = re.sub(r"<[^>]+>", " ", html)
        text = re.sub(r"\s+", " ", text).strip()
    return text, html


def get_sender_email(from_header: str) -> str:
    if "<" in from_header and ">" in from_header:
        return from_header.split("<")[-1].split(">")[0].strip().lower()
    return from_header.strip().lower()


def should_skip_message(sender: str, subject: str, msg) -> bool:
    sender_l = sender.lower()
    subject_l = (subject or "").lower()
    list_id = (msg.get("List-ID") or "").lower()
    precedence = (msg.get("Precedence") or "").lower()
    auto_sub = (msg.get("Auto-Submitted") or "").lower()

    if NOREPLY_RE.search(sender_l):
        return True
    if any(k in subject_l for k in ["newsletter", "angebot", "sale", "rabatt", "unsubscribe", "werbung", "promo"]):
        return True
    if list_id or precedence in {"bulk", "list", "junk"} or auto_sub not in {"", "no"}:
        return True
    return False


def smtp_send_with_security(account, msg: EmailMessage):
    security = (account.get("smtp_security") or "auto").lower()
    host = account["smtp_host"]
    port = int(account["smtp_port"])

    def send_ssl():
        with smtplib.SMTP_SSL(host, port, timeout=20) as server:
            server.login(account["email"], account["password"])
            server.send_message(msg)

    def send_starttls():
        with smtplib.SMTP(host, port, timeout=20) as server:
            server.ehlo()
            server.starttls()
            server.ehlo()
            server.login(account["email"], account["password"])
            server.send_message(msg)

    def send_plain():
        with smtplib.SMTP(host, port, timeout=20) as server:
            server.login(account["email"], account["password"])
            server.send_message(msg)

    if security == "ssl":
        return send_ssl()
    if security == "starttls":
        return send_starttls()
    if security == "plain":
        return send_plain()

    # auto: robust fallback for WRONG_VERSION_NUMBER and provider differences
    if port == 465:
        methods = [send_ssl, send_starttls, send_plain]
    else:
        methods = [send_starttls, send_ssl, send_plain]
    last_error = None
    for method in methods:
        try:
            return method()
        except (ssl.SSLError, smtplib.SMTPException, OSError) as err:
            last_error = err
            continue
    raise ValueError(f"SMTP Versand fehlgeschlagen: {last_error}")


def sync_account(account_id: int):
    rows = db_fetch_all("SELECT * FROM accounts WHERE id = ?", (account_id,))
    if not rows:
        raise ValueError("Konto wurde nicht gefunden.")
    account = rows[0]

    client = imaplib.IMAP4_SSL(account["imap_host"], account["imap_port"]) if account["use_ssl"] else imaplib.IMAP4(account["imap_host"], account["imap_port"])
    try:
        client.login(account["email"], account["password"])
        client.select("INBOX")
        status, msg_ids = client.search(None, "ALL")
        if status != "OK":
            return 0
        saved = 0
        for msg_id in msg_ids[0].split()[-200:]:
            status, payload = client.fetch(msg_id, "(RFC822)")
            if status != "OK" or not payload or payload[0] is None:
                continue
            msg = message_from_bytes(payload[0][1])
            sender = get_sender_email(msg.get("From", ""))
            if not sender or sender == account["email"].lower():
                continue
            subject = msg.get("Subject", "")
            if should_skip_message(sender, subject, msg):
                continue
            body, body_html = extract_bodies(msg)
            if not body and not body_html:
                continue
            try:
                sent_at = parsedate_to_datetime(msg.get("Date")).astimezone(timezone.utc).isoformat()
            except Exception:
                sent_at = utc_now_iso()
            try:
                db_execute(
                    """
                    INSERT INTO messages(account_id, contact_email, direction, subject, body, body_html, sent_at, external_message_id, created_at)
                    VALUES (?, ?, 'inbound', ?, ?, ?, ?, ?, ?)
                    """,
                    (account_id, sender, subject, body or "", body_html, sent_at, msg.get("Message-ID"), utc_now_iso()),
                )
                saved += 1
            except sqlite3.IntegrityError:
                continue
        return saved
    finally:
        try:
            client.logout()
        except Exception:
            pass


def send_message(account_id: int, to_email: str, body: str, is_html: bool = False):
    rows = db_fetch_all("SELECT * FROM accounts WHERE id = ?", (account_id,))
    if not rows:
        raise ValueError("Konto wurde nicht gefunden.")
    account = rows[0]

    msg = EmailMessage()
    msg["From"] = account["email"]
    msg["To"] = to_email
    msg["Subject"] = "Chat-Nachricht"
    if is_html:
        text_fallback = re.sub(r"<[^>]+>", " ", body)
        text_fallback = re.sub(r"\s+", " ", text_fallback).strip()
        msg.set_content(text_fallback or "HTML Nachricht")
        msg.add_alternative(body, subtype="html")
    else:
        msg.set_content(body)

    smtp_send_with_security(account, msg)

    db_execute(
        """
        INSERT INTO messages(account_id, contact_email, direction, subject, body, body_html, sent_at, external_message_id, created_at)
        VALUES (?, ?, 'outbound', 'Chat-Nachricht', ?, ?, ?, ?, ?)
        """,
        (account_id, to_email, re.sub(r"<[^>]+>", " ", body).strip() if is_html else body, body if is_html else None, utc_now_iso(), msg["Message-ID"], utc_now_iso()),
    )


class AppHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path in ("/", "/index.html"):
            return self.serve_file(STATIC_DIR / "index.html", "text/html; charset=utf-8")
        if parsed.path.startswith("/static/"):
            return self.serve_file(STATIC_DIR / parsed.path.replace("/static/", "", 1))
        if parsed.path == "/api/accounts":
            return json_response(
                self,
                db_fetch_all("SELECT id, name, email, imap_host, imap_port, smtp_host, smtp_port, use_ssl, smtp_security, created_at FROM accounts ORDER BY id DESC"),
            )
        if parsed.path == "/api/chats":
            params = parse_qs(parsed.query)
            account_id = int((params.get("account_id") or ["0"])[0])
            chats = db_fetch_all(
                """
                SELECT contact_email,
                       MAX(sent_at) AS last_at,
                       (SELECT body FROM messages m2 WHERE m2.account_id = m1.account_id AND m2.contact_email = m1.contact_email ORDER BY sent_at DESC, id DESC LIMIT 1) AS last_body
                FROM messages m1
                WHERE account_id = ?
                GROUP BY contact_email
                ORDER BY last_at DESC
                """,
                (account_id,),
            )
            return json_response(self, chats)
        if parsed.path == "/api/messages":
            params = parse_qs(parsed.query)
            account_id = int((params.get("account_id") or ["0"])[0])
            contact = (params.get("contact") or [""])[0]
            messages = db_fetch_all(
                """
                SELECT id, direction, body, body_html, sent_at
                FROM messages
                WHERE account_id = ? AND contact_email = ?
                ORDER BY sent_at ASC, id ASC
                """,
                (account_id, contact),
            )
            return json_response(self, messages)
        if not parsed.path.startswith("/api/"):
            return self.serve_file(STATIC_DIR / "index.html", "text/html; charset=utf-8")
        self.send_error(404, "Not Found")

    def do_POST(self):
        parsed = urlparse(self.path)
        try:
            if parsed.path == "/api/accounts":
                data = parse_json_body(self)
                required = ["name", "email", "imap_host", "imap_port", "smtp_host", "smtp_port", "password"]
                missing = [k for k in required if not data.get(k)]
                if missing:
                    return json_response(self, {"error": f"Fehlende Felder: {', '.join(missing)}"}, 400)
                account_id = db_execute(
                    """
                    INSERT INTO accounts(name, email, imap_host, imap_port, smtp_host, smtp_port, password, use_ssl, smtp_security, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        data["name"], data["email"], data["imap_host"], int(data["imap_port"]), data["smtp_host"], int(data["smtp_port"]),
                        data["password"], 1 if data.get("use_ssl", True) else 0, data.get("smtp_security", "auto"), utc_now_iso(),
                    ),
                )
                return json_response(self, {"id": account_id}, 201)
            if parsed.path == "/api/sync":
                return json_response(self, {"saved": sync_account(int(parse_json_body(self)["account_id"]))})
            if parsed.path == "/api/send":
                data = parse_json_body(self)
                send_message(int(data["account_id"]), data["to_email"], data["body"], bool(data.get("is_html")))
                return json_response(self, {"ok": True}, 201)
        except Exception as e:
            return json_response(self, {"error": str(e)}, 500)
        self.send_error(404, "Not Found")

    def serve_file(self, file_path: Path, content_type: str | None = None):
        if not file_path.exists() or not file_path.is_file():
            return self.send_error(404, "Not Found")
        raw = file_path.read_bytes()
        if content_type is None:
            content_type = mimetypes.guess_type(str(file_path))[0] or "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)


if __name__ == "__main__":
    init_db()
    server = ThreadingHTTPServer(("0.0.0.0", int(os.getenv("PORT", "8000"))), AppHandler)
    print("MailChat läuft auf http://localhost:8000")
    server.serve_forever()

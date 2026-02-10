#!/usr/bin/env python3
import json
import os
import sqlite3
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
                sent_at TEXT NOT NULL,
                external_message_id TEXT,
                created_at TEXT NOT NULL,
                UNIQUE(account_id, external_message_id),
                FOREIGN KEY(account_id) REFERENCES accounts(id)
            )
            """
        )


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
    if not raw:
        return {}
    return json.loads(raw)


def extract_text_body(msg) -> str:
    if msg.is_multipart():
        for part in msg.walk():
            if part.get_content_type() == "text/plain" and "attachment" not in (part.get("Content-Disposition") or ""):
                payload = part.get_payload(decode=True) or b""
                charset = part.get_content_charset() or "utf-8"
                return payload.decode(charset, errors="replace").strip()
        return ""
    payload = msg.get_payload(decode=True) or b""
    charset = msg.get_content_charset() or "utf-8"
    return payload.decode(charset, errors="replace").strip()


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
        for msg_id in msg_ids[0].split()[-150:]:
            status, payload = client.fetch(msg_id, "(RFC822)")
            if status != "OK" or not payload or payload[0] is None:
                continue
            raw = payload[0][1]
            msg = message_from_bytes(raw)
            from_addr = msg.get("From", "")
            sender = from_addr.split("<")[-1].replace(">", "").strip() if "@" in from_addr else from_addr
            if sender.lower() == account["email"].lower():
                continue
            ext_id = msg.get("Message-ID")
            body = extract_text_body(msg)
            if not body:
                continue
            try:
                sent_at = parsedate_to_datetime(msg.get("Date")).astimezone(timezone.utc).isoformat()
            except Exception:
                sent_at = utc_now_iso()
            try:
                db_execute(
                    """
                    INSERT INTO messages(account_id, contact_email, direction, subject, body, sent_at, external_message_id, created_at)
                    VALUES (?, ?, 'inbound', ?, ?, ?, ?, ?)
                    """,
                    (account_id, sender, msg.get("Subject", ""), body, sent_at, ext_id, utc_now_iso()),
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


def send_message(account_id: int, to_email: str, body: str):
    rows = db_fetch_all("SELECT * FROM accounts WHERE id = ?", (account_id,))
    if not rows:
        raise ValueError("Konto wurde nicht gefunden.")
    account = rows[0]

    msg = EmailMessage()
    msg["From"] = account["email"]
    msg["To"] = to_email
    msg["Subject"] = "Chat-Nachricht"
    msg.set_content(body)

    if account["use_ssl"]:
        server = smtplib.SMTP_SSL(account["smtp_host"], account["smtp_port"], timeout=20)
    else:
        server = smtplib.SMTP(account["smtp_host"], account["smtp_port"], timeout=20)
    try:
        if not account["use_ssl"]:
            server.starttls()
        server.login(account["email"], account["password"])
        server.send_message(msg)
    finally:
        server.quit()

    db_execute(
        """
        INSERT INTO messages(account_id, contact_email, direction, subject, body, sent_at, external_message_id, created_at)
        VALUES (?, ?, 'outbound', 'Chat-Nachricht', ?, ?, ?, ?)
        """,
        (account_id, to_email, body, utc_now_iso(), msg["Message-ID"], utc_now_iso()),
    )


class AppHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path in ("/", "/index.html"):
            return self.serve_file(STATIC_DIR / "index.html", "text/html; charset=utf-8")
        if parsed.path.startswith("/static/"):
            rel = parsed.path.replace("/static/", "", 1)
            file_path = STATIC_DIR / rel
            return self.serve_file(file_path)
        if parsed.path == "/api/accounts":
            accounts = db_fetch_all(
                "SELECT id, name, email, imap_host, imap_port, smtp_host, smtp_port, use_ssl, created_at FROM accounts ORDER BY id DESC"
            )
            return json_response(self, accounts)
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
                SELECT id, direction, body, sent_at
                FROM messages
                WHERE account_id = ? AND contact_email = ?
                ORDER BY sent_at ASC, id ASC
                """,
                (account_id, contact),
            )
            return json_response(self, messages)

        # Fallback: bei direktem Aufruf unbekannter Pfade trotzdem die App ausliefern
        # (verhindert ein "Not Found" auf einfachen Hosting-Plattformen).
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
                    INSERT INTO accounts(name, email, imap_host, imap_port, smtp_host, smtp_port, password, use_ssl, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        data["name"],
                        data["email"],
                        data["imap_host"],
                        int(data["imap_port"]),
                        data["smtp_host"],
                        int(data["smtp_port"]),
                        data["password"],
                        1 if data.get("use_ssl", True) else 0,
                        utc_now_iso(),
                    ),
                )
                return json_response(self, {"id": account_id}, 201)
            if parsed.path == "/api/sync":
                data = parse_json_body(self)
                count = sync_account(int(data["account_id"]))
                return json_response(self, {"saved": count})
            if parsed.path == "/api/send":
                data = parse_json_body(self)
                send_message(int(data["account_id"]), data["to_email"], data["body"])
                return json_response(self, {"ok": True}, 201)
        except Exception as e:
            return json_response(self, {"error": str(e)}, 500)

        self.send_error(404, "Not Found")

    def serve_file(self, file_path: Path, content_type: str | None = None):
        if not file_path.exists() or not file_path.is_file():
            return self.send_error(404, "Not Found")
        raw = file_path.read_bytes()
        if content_type is None:
            import mimetypes
            guessed, _ = mimetypes.guess_type(str(file_path))
            content_type = guessed or "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)


if __name__ == "__main__":
    init_db()
    port = int(os.getenv("PORT", "8000"))
    server = ThreadingHTTPServer(("0.0.0.0", port), AppHandler)
    print(f"MailChat läuft auf http://localhost:{port}")
    server.serve_forever()

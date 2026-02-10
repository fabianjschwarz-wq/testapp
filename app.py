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
from email.utils import getaddresses, parsedate_to_datetime
import imaplib
import smtplib
import base64
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).parent
DB_PATH = ROOT / "mailchat.db"
STATIC_DIR = ROOT / "static"
DB_LOCK = threading.Lock()

NOREPLY_RE = re.compile(r"(?i)(^|[._-])(no[._-]?reply|noreply|do[._-]?not[._-]?reply|mailer-daemon|newsletter|marketing)([._-]|$)")
PROMO_SUBJECT_RE = re.compile(r"(?i)(newsletter|angebot|sale|rabatt|unsubscribe|werbung|promo)")

DEFAULT_SETTINGS = {
    "poll_interval_ms": "1000",
    "auto_sync_enabled": "1",
    "filter_noreply": "1",
    "filter_info_addresses": "1",
    "filter_promotions": "1",
    "strip_replies": "1",
    "mark_read_on_open": "1",
}


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def init_db() -> None:
    with DB_LOCK, sqlite3.connect(DB_PATH) as conn:
        conn.execute("""
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
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS contacts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                account_id INTEGER NOT NULL,
                email TEXT NOT NULL,
                display_name TEXT,
                UNIQUE(account_id, email)
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS chat_groups (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                account_id INTEGER NOT NULL,
                name TEXT NOT NULL,
                created_at TEXT NOT NULL,
                UNIQUE(account_id, name)
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS group_members (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                group_id INTEGER NOT NULL,
                email TEXT NOT NULL,
                UNIQUE(group_id, email)
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS group_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                account_id INTEGER NOT NULL,
                group_id INTEGER NOT NULL,
                direction TEXT NOT NULL CHECK(direction IN ('inbound', 'outbound')),
                sender_email TEXT,
                body TEXT NOT NULL,
                body_html TEXT,
                sent_at TEXT NOT NULL
            )
        """)
        conn.execute("""
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
                UNIQUE(account_id, external_message_id)
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS sync_state (
                account_id INTEGER PRIMARY KEY,
                last_uid INTEGER NOT NULL DEFAULT 0,
                updated_at TEXT NOT NULL
            )
        """)
        cols = {row[1] for row in conn.execute("PRAGMA table_info(messages)").fetchall()}
        if "body_html" not in cols:
            conn.execute("ALTER TABLE messages ADD COLUMN body_html TEXT")
        if "attachments_json" not in cols:
            conn.execute("ALTER TABLE messages ADD COLUMN attachments_json TEXT")
        if "in_reply_to_message_id" not in cols:
            conn.execute("ALTER TABLE messages ADD COLUMN in_reply_to_message_id TEXT")
        if "delivery_status" not in cols:
            conn.execute("ALTER TABLE messages ADD COLUMN delivery_status TEXT NOT NULL DEFAULT 'sent'")
        if "is_read" not in cols:
            conn.execute("ALTER TABLE messages ADD COLUMN is_read INTEGER NOT NULL DEFAULT 0")
        if "read_at" not in cols:
            conn.execute("ALTER TABLE messages ADD COLUMN read_at TEXT")
        ac_cols = {row[1] for row in conn.execute("PRAGMA table_info(accounts)").fetchall()}
        if "smtp_security" not in ac_cols:
            conn.execute("ALTER TABLE accounts ADD COLUMN smtp_security TEXT NOT NULL DEFAULT 'auto'")
        for k, v in DEFAULT_SETTINGS.items():
            conn.execute("INSERT OR IGNORE INTO settings(key, value) VALUES(?,?)", (k, v))


def db_fetch_all(query: str, params=()):
    with DB_LOCK, sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        return [dict(r) for r in conn.execute(query, params).fetchall()]


def db_fetch_one(query: str, params=()):
    rows = db_fetch_all(query, params)
    return rows[0] if rows else None


def db_execute(query: str, params=()):
    with DB_LOCK, sqlite3.connect(DB_PATH) as conn:
        cur = conn.execute(query, params)
        conn.commit()
        return cur.lastrowid


def get_settings() -> dict:
    settings = {r["key"]: r["value"] for r in db_fetch_all("SELECT key, value FROM settings")}
    merged = dict(DEFAULT_SETTINGS)
    merged.update(settings)
    return merged


def setting_bool(settings: dict, key: str) -> bool:
    return str(settings.get(key, "0")).strip().lower() in {"1", "true", "yes", "on"}


def json_response(handler: BaseHTTPRequestHandler, data, status=200):
    body = json.dumps(data).encode("utf-8")
    try:
        handler.send_response(status)
        handler.send_header("Content-Type", "application/json; charset=utf-8")
        handler.send_header("Content-Length", str(len(body)))
        handler.end_headers()
        handler.wfile.write(body)
    except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError, OSError):
        # Client connection dropped before the response could be written.
        return False
    return True


def parse_json_body(handler: BaseHTTPRequestHandler):
    length = int(handler.headers.get("Content-Length", "0"))
    raw = handler.rfile.read(length)
    return json.loads(raw) if raw else {}


def decode_payload(part) -> str:
    payload = part.get_payload(decode=True) or b""
    charset = part.get_content_charset() or "utf-8"
    return payload.decode(charset, errors="replace").strip()


def strip_quoted_text(text: str) -> str:
    lines = text.splitlines()
    cut_tokens = [
        r"^On .+wrote:$",
        r"^Am .+schrieb.+:$",
        r"^From:\s",
        r"^Von:\s",
        r"^>+",
        r"^-{2,}\s*Original Message\s*-{2,}",
    ]
    for i, line in enumerate(lines):
        if any(re.search(pat, line.strip(), re.IGNORECASE) for pat in cut_tokens):
            lines = lines[:i]
            break
    cleaned = "\n".join(lines).strip()
    return cleaned


def extract_bodies(msg, strip_replies=True) -> tuple[str, str | None]:
    text = ""
    html = None
    if msg.is_multipart():
        for part in msg.walk():
            ctype = part.get_content_type()
            dispo = (part.get("Content-Disposition") or "").lower()
            if "attachment" in dispo:
                continue
            if ctype == "text/plain" and not text:
                text = decode_payload(part)
            elif ctype in {"text/html", "application/xhtml+xml"} and not html:
                html = decode_payload(part)
    else:
        ctype = msg.get_content_type()
        if ctype in {"text/html", "application/xhtml+xml"}:
            html = decode_payload(msg)
        else:
            text = decode_payload(msg)

    if not text and html:
        text = re.sub(r"<[^>]+>", " ", html)
        text = re.sub(r"\s+", " ", text).strip()
    if strip_replies and text:
        text = strip_quoted_text(text)
    return text, html


def extract_attachments(msg) -> list[dict]:
    files = []
    for part in msg.walk() if msg.is_multipart() else []:
        filename = part.get_filename()
        dispo = (part.get("Content-Disposition") or "").lower()
        if not filename and "attachment" not in dispo:
            continue
        payload = part.get_payload(decode=True) or b""
        if not payload:
            continue
        files.append({
            "name": filename or "attachment",
            "content_type": part.get_content_type() or "application/octet-stream",
            "size": len(payload),
        })
    return files


def maybe_process_read_receipt(account_id: int, msg) -> bool:
    ctype = (msg.get_content_type() or "").lower()
    subject = (msg.get("Subject") or "")
    subject_l = subject.lower()
    body, _ = extract_bodies(msg, strip_replies=False)
    body_l = (body or "").lower()
    attachment_names = [((p.get_filename() or "").lower()) for p in (msg.walk() if msg.is_multipart() else [])]

    is_mdn = (
        "disposition-notification" in ctype
        or "multipart/report" in ctype
        or "empfangsbestätigung" in subject_l
        or "lesebestätigung" in subject_l
        or "read receipt" in subject_l
        or "original-message-id" in body_l
        or any("mdn" in name for name in attachment_names)
    )
    if not is_mdn:
        return False

    candidates = []
    if msg.get("Original-Message-ID"):
        candidates.append(msg.get("Original-Message-ID"))
    for line in (body or "").splitlines():
        if "original-message-id" in line.lower():
            _, _, v = line.partition(":")
            if v.strip():
                candidates.append(v.strip())

    for mid in candidates:
        existing = db_fetch_one("SELECT id FROM messages WHERE account_id=? AND direction='outbound' AND external_message_id=?", (account_id, mid.strip()))
        if not existing:
            continue
        db_execute(
            "UPDATE messages SET delivery_status='read', read_at=COALESCE(read_at, ?) WHERE id=?",
            (utc_now_iso(), existing["id"]),
        )
        return True
    # Even when we cannot map the receipt to a message-id, keep it out of chat history.
    return True


def parse_from_header(from_header: str) -> tuple[str, str | None]:
    parsed = getaddresses([from_header])
    if parsed and parsed[0][1]:
        name, addr = parsed[0]
        return addr.lower().strip(), (name.strip() or None)
    return from_header.lower().strip(), None


def should_skip_message(sender: str, subject: str, msg, settings: dict) -> bool:
    sender_l = sender.lower().strip()
    subject_l = (subject or "").lower()
    list_id = (msg.get("List-ID") or "").lower()
    precedence = (msg.get("Precedence") or "").lower()
    auto_sub = (msg.get("Auto-Submitted") or "").lower()

    if setting_bool(settings, "filter_noreply") and NOREPLY_RE.search(sender_l):
        return True
    if setting_bool(settings, "filter_info_addresses") and sender_l.startswith("info@"):
        return True
    if setting_bool(settings, "filter_promotions"):
        if PROMO_SUBJECT_RE.search(subject_l):
            return True
        if list_id or precedence in {"bulk", "list", "junk"} or auto_sub not in {"", "no"}:
            return True
    return False


def upsert_contact(account_id: int, email: str, display_name: str | None = None):
    db_execute("INSERT OR IGNORE INTO contacts(account_id, email, display_name) VALUES(?,?,?)", (account_id, email, display_name))
    if display_name:
        db_execute("UPDATE contacts SET display_name=? WHERE account_id=? AND email=?", (display_name, account_id, email))


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

    methods = [send_ssl, send_starttls, send_plain] if port == 465 else [send_starttls, send_ssl, send_plain]
    last_error = None
    for method in methods:
        try:
            return method()
        except (ssl.SSLError, smtplib.SMTPException, OSError) as err:
            last_error = err
    raise ValueError(f"SMTP Versand fehlgeschlagen: {last_error}")


def sync_account(account_id: int):
    account = db_fetch_one("SELECT * FROM accounts WHERE id=?", (account_id,))
    if not account:
        raise ValueError("Konto wurde nicht gefunden.")
    settings = get_settings()

    state = db_fetch_one("SELECT last_uid FROM sync_state WHERE account_id=?", (account_id,))
    last_uid = int(state["last_uid"]) if state else 0

    client = imaplib.IMAP4_SSL(account["imap_host"], account["imap_port"]) if account["use_ssl"] else imaplib.IMAP4(account["imap_host"], account["imap_port"])
    try:
        client.login(account["email"], account["password"])
        client.select("INBOX")

        uid_range = f"{last_uid + 1}:*" if last_uid > 0 else "1:*"
        status, uid_data = client.uid("search", None, f"UID {uid_range}")
        if status != "OK":
            return 0
        uids = [u for u in (uid_data[0] or b"").split() if u]
        if not uids:
            return 0

        saved = 0
        max_uid = last_uid
        for uid in uids[-200:]:
            uid_int = int(uid)
            if uid_int > max_uid:
                max_uid = uid_int
            status, payload = client.uid("fetch", uid, "(RFC822)")
            if status != "OK" or not payload or payload[0] is None:
                continue
            raw = payload[0][1] if isinstance(payload[0], tuple) else None
            if not raw:
                continue

            msg = message_from_bytes(raw)
            if maybe_process_read_receipt(account_id, msg):
                continue
            sender, sender_name = parse_from_header(msg.get("From", ""))
            if not sender or sender == account["email"].lower():
                continue

            subject = msg.get("Subject", "")
            if should_skip_message(sender, subject, msg, settings):
                continue

            body, body_html = extract_bodies(msg, strip_replies=setting_bool(settings, "strip_replies"))
            attachments = extract_attachments(msg)
            if not body and not body_html and not attachments:
                continue

            try:
                sent_at = parsedate_to_datetime(msg.get("Date")).astimezone(timezone.utc).isoformat()
            except Exception:
                sent_at = utc_now_iso()

            upsert_contact(account_id, sender, sender_name)
            try:
                db_execute(
                    """
                    INSERT INTO messages(account_id, contact_email, direction, subject, body, body_html, sent_at, external_message_id, created_at)
                    VALUES (?, ?, 'inbound', ?, ?, ?, ?, ?, ?)
                    """,
                    (account_id, sender, subject, body or "", body_html, sent_at, msg.get("Message-ID"), utc_now_iso()),
                )
                db_execute("UPDATE messages SET attachments_json=?, in_reply_to_message_id=?, delivery_status='sent', is_read=0 WHERE account_id=? AND external_message_id=?", (json.dumps(attachments), msg.get("In-Reply-To"), account_id, msg.get("Message-ID")))
                saved += 1
            except sqlite3.IntegrityError:
                continue

        db_execute(
            "INSERT INTO sync_state(account_id,last_uid,updated_at) VALUES(?,?,?) ON CONFLICT(account_id) DO UPDATE SET last_uid=excluded.last_uid, updated_at=excluded.updated_at",
            (account_id, max_uid, utc_now_iso()),
        )
        return saved
    finally:
        try:
            client.logout()
        except Exception:
            pass


def send_message(account_id: int, to_email: str, body: str, is_html: bool = False, attachments=None, reply_to_message_id: str | None = None):
    account = db_fetch_one("SELECT * FROM accounts WHERE id=?", (account_id,))
    if not account:
        raise ValueError("Konto wurde nicht gefunden.")

    to_email = to_email.lower().strip()
    now = utc_now_iso()

    msg = EmailMessage()
    msg["From"] = account["email"]
    msg["To"] = to_email
    msg["Subject"] = "Chat-Nachricht"
    msg["Disposition-Notification-To"] = account["email"]
    msg["Return-Receipt-To"] = account["email"]
    if reply_to_message_id:
        msg["In-Reply-To"] = reply_to_message_id
        msg["References"] = reply_to_message_id
    if is_html:
        text_fallback = re.sub(r"<[^>]+>", " ", body)
        text_fallback = re.sub(r"\s+", " ", text_fallback).strip()
        msg.set_content(text_fallback or "HTML Nachricht")
        msg.add_alternative(body, subtype="html")
    else:
        msg.set_content(body)

    safe_attachments = []
    for a in (attachments or []):
        raw = base64.b64decode((a.get("data") or "").encode("utf-8"))
        if not raw:
            continue
        mime = (a.get("content_type") or "application/octet-stream").split("/", 1)
        maintype = mime[0] if len(mime) > 1 else "application"
        subtype = mime[1] if len(mime) > 1 else "octet-stream"
        fname = a.get("name") or "attachment"
        msg.add_attachment(raw, maintype=maintype, subtype=subtype, filename=fname)
        safe_attachments.append({"name": fname, "content_type": f"{maintype}/{subtype}", "size": len(raw)})

    smtp_send_with_security(account, msg)
    upsert_contact(account_id, to_email, None)

    msg_id = db_execute(
        """
        INSERT INTO messages(account_id, contact_email, direction, subject, body, body_html, sent_at, external_message_id, created_at)
        VALUES (?, ?, 'outbound', 'Chat-Nachricht', ?, ?, ?, ?, ?)
        """,
        (account_id, to_email, re.sub(r"<[^>]+>", " ", body).strip() if is_html else body, body if is_html else None, now, msg["Message-ID"], now),
    )
    db_execute("UPDATE messages SET attachments_json=?, in_reply_to_message_id=?, delivery_status='sent', is_read=1 WHERE id=?", (json.dumps(safe_attachments), reply_to_message_id, msg_id))
    return {
        "id": msg_id,
        "direction": "outbound",
        "body": re.sub(r"<[^>]+>", " ", body).strip() if is_html else body,
        "body_html": body if is_html else None,
        "sent_at": now,
        "delivery_status": "sent",
        "attachments": safe_attachments,
        "external_message_id": msg["Message-ID"],
    }


def send_group_message(account_id: int, group_id: int, body: str, is_html=False, attachments=None, reply_to_message_id: str | None = None):
    account = db_fetch_one("SELECT * FROM accounts WHERE id=?", (account_id,))
    group = db_fetch_one("SELECT * FROM chat_groups WHERE id=? AND account_id=?", (group_id, account_id))
    if not account or not group:
        raise ValueError("Gruppe oder Konto nicht gefunden.")
    members = db_fetch_all("SELECT email FROM group_members WHERE group_id=?", (group_id,))
    if not members:
        raise ValueError("Gruppe hat keine Mitglieder.")

    for m in members:
        send_message(account_id, m["email"], body, is_html, attachments or [], reply_to_message_id)

    now = utc_now_iso()
    msg_id = db_execute(
        "INSERT INTO group_messages(account_id, group_id, direction, sender_email, body, body_html, sent_at) VALUES(?,?,'outbound',?,?,?,?)",
        (account_id, group_id, account["email"], re.sub(r"<[^>]+>", " ", body).strip() if is_html else body, body if is_html else None, now),
    )
    return {
        "id": msg_id,
        "direction": "outbound",
        "body": re.sub(r"<[^>]+>", " ", body).strip() if is_html else body,
        "body_html": body if is_html else None,
        "sent_at": now,
    }


class AppHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path in ("/", "/index.html"):
            return self.serve_file(STATIC_DIR / "index.html", "text/html; charset=utf-8")
        if parsed.path.startswith("/static/"):
            return self.serve_file(STATIC_DIR / parsed.path.replace("/static/", "", 1))

        if parsed.path == "/api/accounts":
            return json_response(self, db_fetch_all("SELECT id, name, email, imap_host, imap_port, smtp_host, smtp_port, use_ssl, smtp_security, created_at FROM accounts ORDER BY id DESC"))
        if parsed.path == "/api/settings":
            return json_response(self, get_settings())
        if parsed.path == "/api/contacts":
            account_id = int((parse_qs(parsed.query).get("account_id") or ["0"])[0])
            return json_response(self, db_fetch_all("SELECT email, COALESCE(display_name,'') AS display_name FROM contacts WHERE account_id=? ORDER BY COALESCE(display_name,email)", (account_id,)))
        if parsed.path == "/api/groups":
            account_id = int((parse_qs(parsed.query).get("account_id") or ["0"])[0])
            groups = db_fetch_all("""
                SELECT g.id, g.name, COUNT(m.id) AS members
                FROM chat_groups g LEFT JOIN group_members m ON m.group_id=g.id
                WHERE g.account_id=?
                GROUP BY g.id
                ORDER BY g.name
            """, (account_id,))
            return json_response(self, groups)
        if parsed.path == "/api/group_messages":
            params = parse_qs(parsed.query)
            account_id = int((params.get("account_id") or ["0"])[0])
            group_id = int((params.get("group_id") or ["0"])[0])
            since_id = int((params.get("since_id") or ["0"])[0])
            rows = db_fetch_all("SELECT id, direction, body, body_html, sent_at, sender_email FROM group_messages WHERE account_id=? AND group_id=? AND id>? ORDER BY sent_at ASC,id ASC", (account_id, group_id, since_id))
            return json_response(self, rows)
        if parsed.path == "/api/chats":
            account_id = int((parse_qs(parsed.query).get("account_id") or ["0"])[0])
            chats = db_fetch_all(
                """
                SELECT m.contact_email,
                       COALESCE(c.display_name, m.contact_email) AS display_name,
                       MAX(m.sent_at) AS last_at,
                       (SELECT body FROM messages m2 WHERE m2.account_id = m.account_id AND m2.contact_email = m.contact_email ORDER BY sent_at DESC, id DESC LIMIT 1) AS last_body,
                       SUM(CASE WHEN m.direction='inbound' AND COALESCE(m.is_read,0)=0 THEN 1 ELSE 0 END) AS unread_count
                FROM messages m
                LEFT JOIN contacts c ON c.account_id=m.account_id AND c.email=m.contact_email
                WHERE m.account_id=?
                GROUP BY m.contact_email
                ORDER BY last_at DESC
                """,
                (account_id,),
            )
            return json_response(self, chats)
        if parsed.path == "/api/messages":
            params = parse_qs(parsed.query)
            account_id = int((params.get("account_id") or ["0"])[0])
            contact = (params.get("contact") or [""])[0].lower().strip()
            since_id = int((params.get("since_id") or ["0"])[0])
            rows = db_fetch_all(
                """
                SELECT m.id, m.direction, m.body, m.body_html, m.sent_at, COALESCE(c.display_name, m.contact_email) AS display_name
                       ,COALESCE(m.attachments_json, '[]') AS attachments_json, m.external_message_id, COALESCE(m.in_reply_to_message_id,'') AS in_reply_to_message_id,
                       COALESCE(m.delivery_status,'sent') AS delivery_status, COALESCE(m.is_read,0) AS is_read
                FROM messages m
                LEFT JOIN contacts c ON c.account_id=m.account_id AND c.email=m.contact_email
                WHERE m.account_id=? AND m.contact_email=? AND m.id>?
                ORDER BY m.sent_at ASC, m.id ASC
                """,
                (account_id, contact, since_id),
            )
            mark_read = (params.get("mark_read") or ["0"])[0]
            if mark_read == "1":
                db_execute("UPDATE messages SET is_read=1, read_at=COALESCE(read_at, ?) WHERE account_id=? AND contact_email=? AND direction='inbound'", (utc_now_iso(), account_id, contact))
                for r in rows:
                    if r["direction"] == "inbound":
                        r["is_read"] = 1
            for r in rows:
                try:
                    r["attachments"] = json.loads(r.get("attachments_json") or "[]")
                except Exception:
                    r["attachments"] = []
                r.pop("attachments_json", None)
            return json_response(self, rows)

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
                    "INSERT INTO accounts(name,email,imap_host,imap_port,smtp_host,smtp_port,password,use_ssl,smtp_security,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
                    (data["name"], data["email"], data["imap_host"], int(data["imap_port"]), data["smtp_host"], int(data["smtp_port"]), data["password"], 1 if data.get("use_ssl", True) else 0, data.get("smtp_security", "auto"), utc_now_iso()),
                )
                return json_response(self, {"id": account_id}, 201)
            if parsed.path == "/api/sync":
                return json_response(self, {"saved": sync_account(int(parse_json_body(self)["account_id"]))})
            if parsed.path == "/api/send":
                data = parse_json_body(self)
                message = send_message(int(data["account_id"]), data["to_email"], data["body"], bool(data.get("is_html")), data.get("attachments") or [], data.get("reply_to_message_id"))
                return json_response(self, {"ok": True, "message": message}, 201)
            if parsed.path == "/api/send_group":
                data = parse_json_body(self)
                message = send_group_message(int(data["account_id"]), int(data["group_id"]), data["body"], bool(data.get("is_html")), data.get("attachments") or [], data.get("reply_to_message_id"))
                return json_response(self, {"ok": True, "message": message}, 201)
            if parsed.path == "/api/contacts":
                data = parse_json_body(self)
                upsert_contact(int(data["account_id"]), data["email"].lower().strip(), data.get("display_name") or None)
                return json_response(self, {"ok": True}, 201)
            if parsed.path == "/api/groups":
                data = parse_json_body(self)
                group_id = db_execute("INSERT INTO chat_groups(account_id,name,created_at) VALUES(?,?,?)", (int(data["account_id"]), data["name"], utc_now_iso()))
                for email in data.get("members", []):
                    db_execute("INSERT OR IGNORE INTO group_members(group_id,email) VALUES(?,?)", (group_id, email.lower().strip()))
                return json_response(self, {"id": group_id}, 201)
            if parsed.path == "/api/settings":
                data = parse_json_body(self)
                for k, v in data.items():
                    if k in DEFAULT_SETTINGS:
                        db_execute("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (k, str(v)))
                return json_response(self, {"ok": True}, 200)
            if parsed.path == "/api/messages/read":
                data = parse_json_body(self)
                db_execute("UPDATE messages SET is_read=1, read_at=COALESCE(read_at, ?) WHERE id=? AND account_id=? AND direction='inbound'", (utc_now_iso(), int(data["id"]), int(data["account_id"])))
                return json_response(self, {"ok": True}, 200)
        except Exception as e:
            try:
                return json_response(self, {"error": str(e)}, 500)
            except Exception:
                return
        self.send_error(404, "Not Found")

    def do_DELETE(self):
        parsed = urlparse(self.path)
        try:
            if parsed.path == "/api/contacts":
                params = parse_qs(parsed.query)
                account_id = int((params.get("account_id") or ["0"])[0])
                email = (params.get("email") or [""])[0].strip().lower()
                db_execute("DELETE FROM contacts WHERE account_id=? AND email=?", (account_id, email))
                db_execute("DELETE FROM messages WHERE account_id=? AND contact_email=?", (account_id, email))
                return json_response(self, {"ok": True}, 200)
            if parsed.path == "/api/groups":
                params = parse_qs(parsed.query)
                account_id = int((params.get("account_id") or ["0"])[0])
                group_id = int((params.get("id") or ["0"])[0])
                db_execute("DELETE FROM group_members WHERE group_id=?", (group_id,))
                db_execute("DELETE FROM group_messages WHERE account_id=? AND group_id=?", (account_id, group_id))
                db_execute("DELETE FROM chat_groups WHERE id=? AND account_id=?", (group_id, account_id))
                return json_response(self, {"ok": True}, 200)
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
        try:
            self.end_headers()
            self.wfile.write(raw)
        except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError, OSError):
            return


if __name__ == "__main__":
    init_db()
    server = ThreadingHTTPServer(("0.0.0.0", int(os.getenv("PORT", "8000"))), AppHandler)
    print("MailChat läuft auf http://localhost:8000")
    server.serve_forever()

# MailChat

MailChat zeigt E-Mail-Verkehr als Chat-Ansicht (ähnlich Messenger):

- **Jeder Kontakt = ein Chat**
- **Im Verlauf wird nur der Nachrichten-Inhalt angezeigt** (keine langen Mail-Header)
- **Eigene Mail-Konten konfigurierbar** (IMAP + SMTP)
- Gegenüber braucht **keine App**: Nachrichten werden als normale E-Mails versendet.

## Start

```bash
python app.py
```

Dann im Browser öffnen: `http://localhost:8000`

## Hinweise

- Für viele Provider wird ein **App-Passwort** statt normalem Passwort benötigt.
- Zugangsdaten werden in dieser Demo lokal in `mailchat.db` gespeichert.
- Bei unverschlüsselten SMTP-Ports versucht die App `STARTTLS`.

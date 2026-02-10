# MailChat

MailChat zeigt E-Mail-Verkehr als Chat-Ansicht (ähnlich Messenger):

- **Jeder Kontakt = ein Chat**
- **Im Verlauf werden Inhalte inkl. HTML angezeigt** (bereinigt/sanitized)
- **Datums-/Uhrzeit-Anzeige pro Bubble**
- **Filter für Werbe-/No-Reply-Mails**
- **SMTP-Sicherheitsmodus (Auto / SSL / STARTTLS / Plain)**
- **Mobile-Ansicht per Switch**

## Start

```bash
python app.py
```

Dann im Browser öffnen: `http://localhost:8000`

## Hinweise

- Für viele Provider wird ein **App-Passwort** statt normalem Passwort benötigt.
- Zugangsdaten werden in dieser Demo lokal in `mailchat.db` gespeichert.
- Bei SMTP-Problemen `SMTP Sicherheit` im Konto auf **Auto** lassen oder explizit den passenden Modus setzen.

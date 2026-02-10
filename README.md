# MailChat

MailChat zeigt E-Mail-Verkehr als Chat-Ansicht (ähnlich Messenger):

- **Kontakte mit Namen verknüpfen**
- **Gruppen erstellen und als Broadcast senden**
- **HTML-Inhalte anzeigen (sanitized)**
- **Antwort-Zitate automatisch ausblenden**
- **No-Reply / info@ / Werbe-Mails filterbar**
- **Einstellungsdialog für Polling und Filter**
- **Schnelle Realtime-Aktualisierung + Browser-Benachrichtigungen**
- **Mobile/Desktop-Switch mit dynamischem Label und Zurück-Button**

## Start

```bash
python app.py
```

Dann im Browser öffnen: `http://localhost:8000`

## Hinweise

- Für viele Provider wird ein **App-Passwort** statt normalem Passwort benötigt.
- Zugangsdaten werden lokal in `mailchat.db` gespeichert.
- Für schnellere Synchronisation kann das Polling-Intervall in den Einstellungen reduziert werden.

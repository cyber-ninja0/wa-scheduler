# WhatsApp Scheduler

Schedule WhatsApp messages to be sent at any time — even when your phone is offline. Supports one-time and recurring messages, optional encryption at rest, a REST API, and a simple web UI.

> ⚠️ **Disclaimer:** This project uses [Baileys](https://github.com/WhiskeySockets/Baileys), an unofficial WhatsApp Web client. Using unofficial clients violates WhatsApp's Terms of Service and may result in account suspension. Use it for personal messages at your own risk — never for bulk sending or spam. For production use cases, consider the official WhatsApp Business API.

## Features

- **Scheduled delivery** — queue a message for any future date and time
- **Recurring messages** — daily or weekly repeats with no time drift
- **Encryption at rest** — message bodies stored with AES-256-GCM (optional)
- **REST API** — integrate with scripts or other tools
- **Web UI** — schedule and manage messages from the browser
- **Reliable dispatch** — duplicate-send protection and crash recovery
- **Zero external services** — single Node.js process with a local SQLite database

## Requirements

- Node.js 18 or newer
- A WhatsApp account on your phone (for one-time QR pairing)

## Quick Start

```bash
git clone https://github.com/cyber-ninja0/wa-scheduler.git
cd cyber-ninja0
npm install
cp .env.example .env
```

Edit `.env` and set a strong `ADMIN_KEY` (this protects the API and the UI). To enable encryption, generate a key and set `ENCRYPTION_KEY`:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Start the server:

```bash
node index.js
```

Scan the QR code shown in the terminal with your phone: **WhatsApp → Settings → Linked Devices → Link a Device**. Once you see `WhatsApp connection OPEN`, the session is saved in the `auth/` folder — no need to scan again.

Open the UI at `http://localhost:8787/ui`, enter your `ADMIN_KEY`, and schedule your first message.

### Run in the background (optional)

```bash
npm i -g pm2
pm2 start index.js --name wa-scheduler
pm2 save && pm2 startup
```

## Configuration

All settings live in `.env`:

| Variable | Default | Description |
|---|---|---|
| `ADMIN_KEY` | — | Required. Bearer token for the API and UI. Use a long random string. |
| `ENCRYPTION_KEY` | empty | Optional. 64 hex chars (32 bytes). Enables AES-256-GCM encryption of message bodies in the database. |
| `PORT` | `8787` | HTTP port. |
| `HOST` | `127.0.0.1` | Bind address. Set to `0.0.0.0` to access the UI from other devices on your network. |

## API Reference

All endpoints except `/health` require the header `Authorization: Bearer <ADMIN_KEY>`.

### `GET /health`

Returns server and WhatsApp connection status.

### `GET /messages`

Returns the 200 most recent messages with their statuses.

### `POST /schedule`

```json
{
  "to": "+15551234567",
  "body": "Hello!",
  "send_at_iso": "2026-11-12T20:30:00-05:00",
  "repeat": "none"
}
```

`to` must be in E.164 format. Time is accepted as `send_at_iso` (ISO 8601 with timezone) or `send_at_epoch` (Unix seconds) and must be in the future. `repeat` is one of `none`, `daily`, `weekly`.

### `POST /cancel`

```json
{ "id": "message-uuid" }
```

Cancels a pending message.

### `POST /reschedule`

```json
{ "id": "message-uuid", "new_send_at_iso": "2026-11-13T09:00:00-05:00" }
```

Moves a message to a new time and returns it to the queue (works for cancelled and failed messages too).

### Message statuses

`pending` → `processing` → `sent` / `failed`, plus `cancelled`. Recurring messages return to `pending` with the next occurrence after each send.

## Security Notes

- Keep `.env`, the `auth/` folder, and `data.sqlite` private — they are excluded from git via `.gitignore`.
- The server binds to `127.0.0.1` by default. If you expose it to your network, prefer a VPN such as Tailscale or WireGuard over opening ports to the internet.
- If the log ever shows `Logged out`, delete the `auth/` folder and pair the device again.
- Back up `auth/` and `data.sqlite` if you want to survive reinstalls without re-pairing.

## How It Works

Messages are stored in a local SQLite database. A dispatcher wakes up every 10 seconds, atomically claims due messages (preventing duplicate sends even across restarts), delivers them through the linked WhatsApp session, and either marks them as sent or schedules the next occurrence for recurring messages. Recurrence is calculated from the original scheduled time, so a daily 9:00 message stays at 9:00 regardless of processing delays or downtime.

## License

[MIT](LICENSE)

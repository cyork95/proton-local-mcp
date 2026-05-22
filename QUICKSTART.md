# Proton Bridge + Standard Notes MCP — Quick Start

## How it works

```
Proton servers (encrypted)
        ↓
Proton Bridge  ← running on your PC, decrypts mail locally
        ↓  IMAP on 127.0.0.1:1143
        ↓
Proton Calendar share link  ← standard ICS URL, fetched directly
        ↓
MCP server (server.js)
        ↓  stdio
Claude Code
```

Your credentials never leave your machine.

---

## Step 1 — Get your Bridge IMAP password

1. Open the **Proton Bridge** app (system tray icon)
2. Click your account name
3. Copy the **IMAP/SMTP password** shown — this is NOT your Proton login password
4. Note the **IMAP port** (usually `1143`)

---

## Step 2 — Get your Calendar ICS share link

Do this for each Proton calendar you want included in the daily briefing:

1. Open **Proton Calendar** in your browser
2. In the left sidebar, hover over a calendar name and click the **⚙ gear icon**
3. Go to **Share** → **Create link**
4. Copy the link — it looks like `https://calendar.proton.me/api/calendar/v1/url/...`

Repeat for each calendar. You can add multiple links comma-separated in `.env`.

---

## Step 3 — Configure credentials

```powershell
Copy-Item .env.example .env
notepad .env
```

| Variable | Value |
|---|---|
| `BRIDGE_EMAIL` | Your full Proton email (`you@proton.me`) |
| `BRIDGE_PASSWORD` | The Bridge-generated password |
| `BRIDGE_IMAP_HOST` | `127.0.0.1` |
| `BRIDGE_IMAP_PORT` | Port shown in Bridge (usually `1143`) |
| `PROTON_CALENDAR_ICS_URLS` | Your ICS share link(s), comma-separated |
| `STANDARD_NOTES_EMAIL` | Your Standard Notes login email |
| `STANDARD_NOTES_PASSWORD` | Your Standard Notes password |

---

## Step 4 — Install dependencies

```powershell
npm install
```

> **If `argon2` fails to compile** (needed for Standard Notes), you need the Visual C++ Build Tools.
> Run as Administrator:
> ```powershell
> npm install --global windows-build-tools
> npm install
> ```

---

## Step 5 — Smoke test

```powershell
node test-server.js
```

All checks should show ✓.

---

## Step 6 — Register with Claude Code

```powershell
claude mcp add proton-standard-notes -- node "C:\path\to\proton-local-mcp\server.js"
```

Restart Claude Code. The MCP server will appear as connected.

---

## Daily briefing

The main use case. Just ask:

```
Give me my daily briefing
```

Claude will call `daily_briefing` and return:
- All of today's calendar events (times, locations, descriptions)
- All unread email from the last 24 hours (sender, subject, time)

You can then ask follow-up questions like:
- "Read me the email from Sarah"
- "What's the first meeting about?"
- "Save a note with my priorities for today"

### Other useful prompts

```
What's on my calendar this week?
Search my email for "invoice"
Show me my last 10 emails
List my Standard Notes notes
Search my notes for "architecture"
Create a note titled "Today's priorities" with ...
```

---

## File overview

| File | Purpose |
|---|---|
| `server.js` | MCP server — all tools |
| `sn-crypto.js` | Standard Notes 004 crypto (Argon2id + AES-256-CBC) |
| `test-server.js` | Pre-flight checks |
| `.env` | Your credentials (never commit this file) |

---

## Troubleshooting

**Bridge IMAP connection fails**
- Confirm Bridge is running (system tray icon)
- Use the Bridge-generated password, not your Proton account password
- Check the port matches what Bridge shows

**Calendar returns no events**
- Make sure the ICS link was generated with "Create link" (not just "Copy link" for sharing with a person)
- The link should start with `https://calendar.proton.me/api/calendar/v1/url/`

**argon2 fails to compile**
- Run as Administrator: `npm install --global node-gyp windows-build-tools`
- Then `npm install` again

**Bridge disconnects mid-use**
- Normal — the server reconnects on the next request automatically.

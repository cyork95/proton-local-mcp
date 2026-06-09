# Personal MCP — Quick Start

## How it works

```
Google APIs (Gmail, Calendar, Drive, Tasks, Health)
        ↓  OAuth 2.0
        ↓
MCP server (server.js)
        ↓  stdio
Claude Desktop / Claude Code
```

Your credentials stay on your machine. The server runs locally and is spawned by Claude Desktop on startup.

---

## Step 1 — Create a Google Cloud project

1. Go to [https://console.cloud.google.com/](https://console.cloud.google.com/) and create a new project
2. Enable these APIs (search each in the API Library):
   - **Gmail API**
   - **Google Calendar API**
   - **Google Drive API**
   - **Tasks API**
   - **Google Health API** (search "Google Health Connect REST API")
3. Go to **OAuth consent screen** → External → fill in app name → **Add your Google account email as a Test User**
4. Go to **APIs & Services → Credentials** → **Create credentials → OAuth 2.0 Client ID**
   - Application type: **Web application**
   - Authorized redirect URI: `http://127.0.0.1:8890/callback`
5. Copy the **Client ID** and **Client Secret**

---

## Step 2 — Configure credentials

```powershell
cd "C:\path\to\personal-mcp"
Copy-Item .env.example .env
notepad .env
```

Fill in at minimum:

| Variable | Value |
|---|---|
| `GOOGLE_CLIENT_ID` | From Google Cloud Console |
| `GOOGLE_CLIENT_SECRET` | From Google Cloud Console |
| `STANDARD_NOTES_BACKUP_PATH` | Path to your SN local backup folder |

---

## Step 3 — Install dependencies

```powershell
npm install
```

---

## Step 4 — Authorize Google (one-time)

```powershell
node --dns-result-order=ipv4first health-auth.js
```

A URL will be printed. Open it in your browser, sign in with your Google account, and approve all permissions. The script prints your refresh token — paste it into `.env`:

```
GOOGLE_REFRESH_TOKEN=paste_token_here
```

---

## Step 5 — Register with Claude Desktop

Add to `%APPDATA%\Claude\claude_desktop_config.json` under `mcpServers`:

```json
{
  "mcpServers": {
    "personal-mcp": {
      "command": "node",
      "args": ["--dns-result-order=ipv4first", "C:\\path\\to\\personal-mcp\\server.js"]
    }
  }
}
```

Then **restart Claude Desktop**. The tools will appear automatically.

---

## Step 6 — Smoke test

```powershell
node --dns-result-order=ipv4first test-server.js
```

---

## What to ask Claude

```
Give me my daily briefing
What's on my calendar today?
Search my email for "invoice"
Show me my recent Gmail messages
What files did I modify in Drive today?
What tasks do I have open in Google Tasks?
How many steps did I take today?
What did I play on Steam today?
Give me the bitcoin price and fear/greed index
```

---

## File overview

| File | Purpose |
|---|---|
| `server.js` | MCP server — all tools (~4000 lines) |
| `health-auth.js` | One-time Google OAuth token generator |
| `spotify-auth.js` | One-time Spotify OAuth token generator |
| `test-server.js` | Pre-flight checks |
| `.env` | Your credentials (never commit this file) |
| `.env.example` | Template — copy to `.env` and fill in |

---

## Troubleshooting

**Google API returns 401**
- Your refresh token may have expired (happens in "Testing" mode after 7 days)
- Re-run `health-auth.js` to get a new token
- To get long-lived tokens: publish your Google Cloud app to "Production" in the OAuth consent screen

**Google API returns 403**
- The API isn't enabled in your Cloud project — go to API Library and enable it
- Your account isn't added as a Test User in the OAuth consent screen

**Tools don't appear in Claude**
- Make sure `server.js` path in `claude_desktop_config.json` is correct
- Restart Claude Desktop after any config or code change
- Check Claude Desktop logs: `%APPDATA%\Claude\logs\`

# Proton Local MCP

A self-hosted [Model Context Protocol](https://modelcontextprotocol.io) server that connects Claude to your personal productivity stack — Proton Mail, Proton Calendar, Standard Notes, Spotify, health data, Steam, crypto mining, and more. Everything runs on your machine. Your credentials never leave it.

Built for [Claude Desktop](https://claude.ai/download) and [Claude Code](https://claude.ai/code).

---

## What it connects

| Category | Source | How |
|---|---|---|
| **Email** | Proton Mail | Proton Bridge IMAP on `127.0.0.1` |
| **Calendar** | Proton Calendar | ICS share links |
| **Notes** | Standard Notes | Local plaintext backup folder |
| **Files** | Proton Drive | Local sync folder walk |
| **Photos** | Ente Photos | Local sync folder walk |
| **Music** | Spotify | OAuth refresh-token flow |
| **Health** | Google Health API | OAuth (steps, sleep, HR, calories) |
| **Gaming** | Steam | Public API (recent games, achievements) |
| **Workouts** | Hevy | Public API (sets, volume, PRs) |
| **Language** | Duolingo | Public API (streak, XP, courses) |
| **Browser** | Vivaldi | Local SQLite history + Notes JSON |
| **App usage** | Windows Activity History | Local SQLite (`ActivitiesCache.db`) |
| **PC hardware** | NVIDIA GPU + CPU/RAM | `nvidia-smi` + PowerShell CIM |
| **Bitcoin** | CoinGecko + mempool.space | Public APIs |
| **Crypto portfolio** | CoinGecko | Holdings in `.env`, prices live |
| **Mining** | BitAxe (local) + Braiins + Public Pool | Local REST + pool APIs |
| **Web3 wallet** | mempool.space | Address balance lookup |
| **GitHub** | GitHub public events | Public API (no auth needed) |
| **Weather** | Open-Meteo → wttr.in fallback | Public APIs |
| **Air quality** | Open-Meteo AQ + AirNow (Indiana) | Public APIs |
| **NWS alerts** | National Weather Service | Public API |
| **Fear & Greed** | alternative.me | Public API |
| **News** | Hacker News + Reddit | Public APIs |
| **Mood** | Standard Notes | Reads `Mood YYYY-MM-DD` notes |
| **Email receipts** | Proton Mail | Subject-line parser |

---

## Tools exposed to Claude

`daily_briefing` · `end_of_day_data` · `weekly_summary` · `monthly_summary` · `yearly_summary`
`health_day` · `hevy_workouts` · `steam_status` · `duolingo_status`
`spotify_recently_played` · `spotify_currently_playing` · `spotify_recommendations`
`btc_data` · `mempool_stats` · `wallet_balance` · `crypto_portfolio` · `fear_and_greed`
`bitaxe_status` · `braiins_stats` · `public_pool_stats`
`pc_hardware` · `activity_history` · `vivaldi_history` · `vivaldi_notes`
`get_weather` · `air_quality` · `airnow_pollen` · `nws_alerts`
`github_activity` · `mood_note` · `package_deliveries` · `email_receipts`
`drive_recent_files` · `drive_search` · `ente_recent_media`
`proton_list_mailboxes` · `proton_list_messages` · `proton_get_message`
`proton_list_events`
`sn_list_notes` · `sn_search_notes` · `sn_get_note` · `sn_create_note`
`hacker_news` · `reddit_posts` · `ryan_hall_blog`
`word_of_day` · `this_day_in_history`

---

## Automated end-of-day analysis

Four Claude Desktop scheduled tasks replace any manual reporting:

| Task | Fires | Output |
|---|---|---|
| **Nightly analysis** | 11:50 PM daily | `Desktop/Analysis/Daily/YYYY-MM-DD-analysis.md` |
| **Weekly review** | 11:55 PM Sunday | `Desktop/Analysis/Weekly/YYYY-W##-analysis.md` |
| **Monthly review** | 11:52 PM, last day of month | `Desktop/Analysis/Monthly/YYYY-MM-analysis.md` |
| **Yearly review** | 11:54 PM, Dec 31 | `Desktop/Analysis/Yearly/YYYY-analysis.md` |

The nightly task calls `end_of_day_data`, then Claude writes a 400–600 word prose analysis covering body, mind, entertainment, productivity, finance, and anything notable. Weekly/monthly/yearly tasks aggregate daily snapshots into progressively broader retrospectives. All analyses also save to Standard Notes.

**Claude Desktop must be running** for scheduled tasks to fire.

---

## Prerequisites

- **Windows 10/11** (Activity History, nvidia-smi, and some paths are Windows-specific)
- **[Node.js](https://nodejs.org/) 20+**
- **[Claude Desktop](https://claude.ai/download)**
- **[Proton Bridge](https://proton.me/mail/bridge)** — running, with your account signed in
- The services you want to use (Spotify, Steam, Hevy, etc.) — each is optional; missing ones fail gracefully

---

## Setup

See **[QUICKSTART.md](QUICKSTART.md)** for the step-by-step walkthrough.

Short version:

```powershell
# 1. Clone and install
git clone https://github.com/YOUR_USERNAME/proton-local-mcp.git
cd proton-local-mcp
npm install

# 2. Configure credentials
Copy-Item .env.example .env
notepad .env          # fill in your credentials

# 3. Smoke test
npm test

# 4. Register with Claude Desktop
# Add to %APPDATA%\Claude\claude_desktop_config.json:
#   "mcpServers": {
#     "proton-standard-notes": {
#       "command": "node",
#       "args": ["--dns-result-order=ipv4first", "C:\\path\\to\\proton-local-mcp\\server.js"]
#     }
#   }

# 5. Restart Claude Desktop
```

After restarting, the tools appear automatically. Try asking Claude: *"Give me my daily briefing."*

---

## Auth setup helpers

Several services need one-time OAuth token generation:

```powershell
# Spotify
node --dns-result-order=ipv4first spotify-auth.js

# Google Health
node --dns-result-order=ipv4first health-auth.js
```

Each script opens a browser, completes the OAuth flow, and prints the refresh token to paste into `.env`.

---

## Environment variables

Copy `.env.example` to `.env` and fill in your values. Key variables:

| Variable | Purpose |
|---|---|
| `BRIDGE_EMAIL` / `BRIDGE_PASSWORD` | Proton Bridge IMAP credentials (Bridge-generated password, not your Proton login) |
| `PROTON_CALENDAR_ICS_URLS` | Comma-separated ICS share links from Proton Calendar |
| `STANDARD_NOTES_BACKUP_PATH` | Path to your Standard Notes local backup folder |
| `PROTON_DRIVE_PATH` | Path to the `My files` subfolder of your Proton Drive sync |
| `SPOTIFY_CLIENT_ID/SECRET/REFRESH_TOKEN` | From Spotify Developer Dashboard + `spotify-auth.js` |
| `GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN` | From Google Cloud Console + `health-auth.js` |
| `STEAM_API_KEY` / `STEAM_USER_ID` | From [steamcommunity.com/dev/apikey](https://steamcommunity.com/dev/apikey) |
| `HEVY_API_KEY` | From Hevy app → Settings → API |
| `CRYPTO_HOLDINGS` | `TICKER:amount,...` e.g. `BTC:0.05,ETH:1.2` |
| `BITAXE_IPS` | Comma-separated LAN IPs of your BitAxe miners |
| `GITHUB_USERNAME` | Your GitHub username (public events, no auth needed) |
| `WISDOM_BUILDER_PATH` | Path to a [WisdomBuilder](https://github.com/YOUR_USERNAME/wisdom-builder) project folder (optional) |

All variables are optional — any source that fails or is unconfigured returns a safe null and never crashes the briefing.

---

## Architecture

Single-file ESM server (`server.js`, ~3,500 lines). All data sources run in parallel with individual timeouts via `Promise.race` — one slow or broken API never blocks the rest. SQLite databases (Vivaldi history, Windows Activity History) are accessed via temp-file copies to bypass app locks.

See [CLAUDE.md](CLAUDE.md) for the full architecture reference used by Claude Code when working in this repo.

---

## Privacy

- All credential handling is local. Nothing is sent anywhere except to the services you explicitly configure.
- Proton Mail is read through Proton Bridge — the MCP server speaks plain IMAP to Bridge on localhost; Bridge handles the end-to-end decryption.
- Standard Notes backup is read and written to a local folder only — it becomes visible in the SN app after a manual import.
- `.env` is in `.gitignore` and should never be committed.

---

## License

MIT

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

A self-hosted MCP server (`server.js`) that connects Claude to the user's local Proton and productivity stack. All data stays on-machine except for a handful of external API calls (Spotify, Open-Meteo/wttr.in weather, Proton Calendar ICS links, CoinGecko, and various free public APIs).

**Data sources wired up:**
- **Proton Mail** — via Proton Bridge IMAP (localhost TLS, self-signed cert)
- **Proton Calendar** — via ICS share links fetched with axios
- **Standard Notes** — via local plaintext backup folder (read/write)
- **Proton Drive** — via local sync folder recursive walk
- **Ente Photos** — via local sync folder, filtered to photo/video extensions
- **Spotify** — OAuth refresh-token flow; recommendations use audio feature targeting
- **Google Health API** — steps, calories, active minutes, resting HR, sleep (replaced Fitbit May 2026)
- **Weather** — Open-Meteo primary, wttr.in automatic fallback; both return the same shape
- **PC Hardware** — GPU via `nvidia-smi.exe`, CPU load + RAM via PowerShell CIM
- **Windows Activity History** — SQLite at `%LOCALAPPDATA%\ConnectedDevicesPlatform\*\ActivitiesCache.db` (folder auto-detected), read via `better-sqlite3` with temp-copy to bypass lock
- **Vivaldi History** — Chromium SQLite at `%LOCALAPPDATA%\Vivaldi\User Data\Default\History`, same temp-copy approach
- **Vivaldi Notes** — JSON file at `%LOCALAPPDATA%\Vivaldi\User Data\Default\Notes`, Chromium µs-since-1601 timestamps
- **Steam** — player summary, recent games, achievements unlocked today
- **Hevy** — workout history with volume, sets, PRs
- **Duolingo** — streak, XP, course progress (public API, no auth)
- **BitAxe miners** — local REST API at each miner's IP
- **Braiins pool + Public Pool** — mining pool APIs
- **Crypto portfolio** — holdings in `.env`, prices from CoinGecko; silver spot from frankfurter.app
- **Bitcoin/mempool** — CoinGecko price, mempool.space fees + difficulty + wallet balance
- **GitHub** — public events API (no auth needed)
- **AirNow** — Indiana IDEM real sensor RSS feed (no API key)
- **Air quality** — Open-Meteo AQ API (AQI, PM2.5, PM10, ozone)
- **NWS** — severe weather alerts for Bloomington IN
- **Ryan Hall Y'all** — weather blog RSS feed
- **Reddit, Hacker News** — hot posts and front page
- **Fear & Greed Index** — alternative.me API
- **Mood notes** — reads `Mood YYYY-MM-DD` notes from SN backup folder
- **Package deliveries** — email subject scanner for UPS/FedEx/USPS/Amazon/Walmart/DHL
- **Email receipts** — broader order/transaction scanner across all subjects
- **Daily fun** — fact, joke, quote, word of the day (curated list + dictionaryapi.dev), this day in history, moon phase

## Commands

```powershell
# Install dependencies
npm install

# Run smoke tests (checks env vars, IMAP connection, dependencies)
node --dns-result-order=ipv4first test-server.js

# Run the server manually (Claude Desktop does this automatically)
npm start

# Generate a new Spotify refresh token (one-time setup)
node --dns-result-order=ipv4first spotify-auth.js

# Generate a new Google Health refresh token (one-time setup)
node --dns-result-order=ipv4first health-auth.js

# Run the daily briefing standalone (interactive use only — Task Scheduler job was retired)
node --dns-result-order=ipv4first run-briefing.js
```

The `--dns-result-order=ipv4first` flag is required on Windows — without it, Node resolves `api.spotify.com` to an IPv6 address that times out through Proton VPN.

## MCP registration

The server is registered in `%APPDATA%\Claude\claude_desktop_config.json` under `mcpServers`. Claude Desktop spawns `server.js` as a child process on startup using stdio transport. Any code change requires a full Claude Desktop restart to take effect.

**Critical:** `dotenv` is loaded with an explicit path (`dirname(fileURLToPath(import.meta.url))`) so `.env` is always found regardless of what CWD Claude Desktop uses when spawning the process. Do not revert to `import "dotenv/config"` — that breaks scheduled tasks and any spawn from a different working directory.

## Architecture of server.js

Single-file ESM module (~3500 lines). Rough layout top-to-bottom:

1. **Imports + dotenv** — explicit `__dirname`-relative dotenv load (see above).

2. **IMAP helpers** (`makeImapClient`, `withImap`, `listMailboxes`, `fetchMessages`, `fetchRecentUnread`, `fetchMessageBody`) — every call opens a fresh connection and logs out when done. Bridge disconnects are expected and handled gracefully.

3. **Calendar helpers** (`fetchCalendarEvents`) — fetches all `PROTON_CALENDAR_ICS_URLS` in parallel, parses with `node-ical`, filters to the requested date window.

4. **Ente + Drive helpers** (`walkDrive`, `driveRecentFiles`, `driveSearch`, `enteRecentMedia`) — shared recursive walker, depth-guarded at 6. Ente filters by `PHOTO_EXTS`.

5. **Weather** (`fetchWeatherWttr`, `fetchWeather`) — `fetchWeather` tries Open-Meteo first; on any failure it silently falls back to `fetchWeatherWttr` (wttr.in). Both return identical object shapes so no caller changes are needed when the fallback fires.

6. **Standard Notes helpers** (`snGetAllNotes`, `snGetRecentNotes`, `snReadNote`, `snCreateNote`) — reads `STANDARD_NOTES_BACKUP_PATH`. Filenames: `{title}-{uuid}_txt` (no extension). `snCreateNote(title, text, subfolder?)` writes new files; briefings go into `Daily Briefing/`.

7. **Day commentary** (`generateDayCommentary`) — pure function, produces a paragraph-style journal entry from all gathered data. No I/O.

8. **Spotify helpers** — access token cached in module scope, refreshed on expiry. `fetchSpotifyRecommendations` is the context-aware Phase 2 call (see daily_briefing below).

9. **Google Health helpers** — OAuth token cached in module scope.

10. **Steam** (`fetchSteamData`) — player summary + recent games + achievements unlocked today (checks up to 5 games played in the last 48 h).

11. **All other helpers** — one function per source: `fetchDuolingo`, `fetchVivaldiHistory`, `fetchVivaldiNotes`, `fetchActivityHistory`, `fetchPcHardware`, `fetchAllBitaxe`, `fetchBraiinsStats`, `fetchPublicPoolStats`, `fetchHevyWorkouts`, `fetchAllReceipts`, `fetchPackageDeliveries`, `getMoonPhase`, `fetchBtcData`, `fetchMempoolStats`, `fetchWalletBalance`, `fetchHackerNews`, `fetchRedditPosts`, `fetchThisDayInHistory`, `fetchWordOfDay`, `fetchAirQuality`, `fetchAirNowPollen`, `fetchNwsAlerts`, `fetchMoodNote`, `fetchFearAndGreed`, `fetchCryptoPortfolio`, `fetchGithubActivity`, `fetchRyanHallBlog`, `fetchDailyFact`, `fetchDailyJoke`, `fetchDailyQuote`, `fetchWisdomBuilder`.

`fetchWisdomBuilder(dateStr)` — reads `WISDOM_BUILDER_PATH` (defaults to `Documents\Claude\Claude Code\WisdomBuilder`). Returns the master profile (MBTI, Big5, political compass, top values, notable patterns) plus any session completed today (session number, question count, session summary). Always resolves — returns null if the path doesn't exist. Included in `end_of_day_data` only (not in `daily_briefing`).

12. **Data snapshot helpers** (`saveDataSnapshot`, `loadDataSnapshots`) — saves a JSON file to `SN_BACKUP_ROOT/Daily Briefing/snapshot-YYYY-MM-DD.json` for monthly/yearly aggregation. Both `daily_briefing` and `end_of_day_data` write snapshots to this same location. The enhanced snapshot saved by `end_of_day_data` adds: `crypto_total_usd`, `crypto_btc_change_24h`, `fear_greed_value`, `github_commits`, `github_repos_active`, `activity_top_app`, `activity_total_min`, `pc_gpu_temp_c`, `pc_cpu_load_pct`, `wisdom_session_today`.

13. **Monthly + yearly summary generators** (`generateMonthlySummary`, `generateYearlySummary`) — read accumulated snapshot JSON files, aggregate health/gaming/music/mining/spending metrics. Used by `monthly_summary` and `yearly_summary` tools (Claude formats the output; these generators return Markdown strings).

14. **`TOOLS` array** — all tool schemas as plain objects.

15. **`handleTool(name, args)`** — single switch/case dispatcher.

16. **`daily_briefing` case** — the main event. Two-phase `Promise.all`:
    - **Phase 1** (39 parallel calls): all independent data sources, each wrapped in `withTimeout(promise, ms, fallback)`. `withTimeout` catches both rejections and timeouts — a failing source always resolves to its fallback value and never crashes the briefing.
    - **Phase 2** (after Phase 1 resolves): `fetchSpotifyRecommendations` receives the real weather/mood/health/steam/hevy data as context to tune audio feature targets (energy, valence, acousticness, tempo).
    - Builds a Markdown `lines` array, saves a JSON snapshot, saves to SN backup, returns the full Markdown.

17. **MCP bootstrap** — `StdioServerTransport`, two `setRequestHandler` calls.

## Key patterns

**`withTimeout(promise, ms, fallback)`** — defined inside the `daily_briefing` handler. Uses `Promise.race` with `.catch(() => fallback)` on the promise side so rejections are absorbed. A single bad API never takes down the briefing. Sources that were added before this pattern was hardened use `.catch(()=>null)` at the call site — both work.

**SQLite access** — Vivaldi history, Vivaldi Notes (JSON not SQLite), and Activity History all require file copies to bypass app locks. Pattern: `copyFile` to `tmpdir()`, open with `better-sqlite3` (required via `createRequire` since it's CJS), close, `unlink` in a `finally` block.

**Spotify token** — module-scope `spotifyAccessToken` / `spotifyTokenExpiry`, refreshed automatically on first call and when expired.

**Date handling** — bare `YYYY-MM-DD` strings are UTC midnight; the server appends `T12:00:00` before constructing `Date` objects so Indiana timezone (UTC-4/5) never rolls the display date back a day.

**Word of the Day** — uses a hardcoded `WORD_LIST` array (~250 words) picked deterministically by day-of-year. External API (`dictionaryapi.dev`) is only used for the definition/example, with a 10-word fallback chain if any definition lookup fails.

## Environment variables

All credentials live in `.env` (never committed). Key variables beyond what's obvious from the source list:

| Variable | Purpose |
|---|---|
| `BRIDGE_IMAP_HOST/PORT/SECURE` | Always `127.0.0.1` / `1143` / `true` |
| `BRIDGE_EMAIL / BRIDGE_PASSWORD` | Bridge-generated password, not Proton login |
| `PROTON_CALENDAR_ICS_URLS` | Comma-separated ICS share links |
| `PROTON_DRIVE_PATH` | Full path to the `My files` subfolder |
| `STANDARD_NOTES_BACKUP_PATH` | Full path to SN plaintext backup folder |
| `CRYPTO_HOLDINGS` | `TICKER:amount,...` — update amounts when buying/selling |
| `CRYPTO_SILVER_XAG` | Silver oz held (priced via frankfurter.app) |
| `BITAXE_IPS` | Comma-separated LAN IPs of all miners |
| `REDDIT_SUBREDDITS` | Comma-separated subreddits for the briefing |
| `GITHUB_USERNAME` | Public events API — no auth needed |
| `WISDOM_BUILDER_PATH` | Full path to WisdomBuilder project folder — defaults to `Documents\Claude\Claude Code\WisdomBuilder` |

## Scheduled automation

Four Claude Desktop scheduled tasks replace the old Windows Task Scheduler job (which ran `run-briefing.js` at 6 PM and has been deleted):

| Task ID | Schedule | What it does |
|---|---|---|
| `nightly-analysis` | 11:50 PM daily | Calls `end_of_day_data`, writes ~400–600 word AI analysis to `Desktop\Analysis\Daily\YYYY-MM-DD-analysis.md` |
| `weekly-review` | 11:55 PM Sunday | Calls `weekly_summary`, writes week-in-review to `Desktop\Analysis\Weekly\YYYY-W##-analysis.md` |
| `monthly-review` | 11:52 PM days 28–31 | Checks if it's the last day of the month; if so, calls `monthly_summary` and writes to `Desktop\Analysis\Monthly\YYYY-MM-analysis.md` |
| `yearly-review` | 11:54 PM Dec 31 | Calls `yearly_summary`, writes year-in-review to `Desktop\Analysis\Yearly\YYYY-analysis.md` |

All tasks also save a copy to Standard Notes via `sn_create_note`. **Claude Desktop must be running** for these to fire. Tasks stored in `%USERPROFILE%\.claude\scheduled-tasks\`.

The `end_of_day_data` tool saves an enhanced daily snapshot to the same `Daily Briefing/` folder in SN backup that `daily_briefing` uses, so `monthly_summary` and `yearly_summary` accumulate data from both paths.

A separate Claude Code scheduled task runs a BTC market check-in daily at 10 AM using `btc_data`, `fear_and_greed`, `wallet_balance`, and `crypto_portfolio` tools.

## Known constraints

- **Standard Notes writes go to the backup folder only** — visible in the SN app only after Preferences → Backups → Import Backup.
- **Proton Bridge must be running** for any IMAP tool to work.
- **Claude Desktop MCP timeout** — the 12 s per-source timeout keeps total briefing time under the Claude Desktop limit. Claude Code sessions are more lenient.
- **Activity History** requires Windows Settings → Privacy & security → Activity history to be enabled. ActivityType 5 = foreground app sessions.
- **PC hardware temp** — CPU temperature is not reliably available via standard WMI without admin rights; the field is omitted rather than attempted.
- **`better-sqlite3` is CJS** — must be loaded via `createRequire(import.meta.url)` inside async functions; cannot be top-level imported in ESM.

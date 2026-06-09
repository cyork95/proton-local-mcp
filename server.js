import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readdir, stat } from "node:fs/promises";
import { join, extname, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config as dotenvConfig } from "dotenv";

// Load .env from the script's own directory — not process.cwd() — so env vars
// are always found regardless of how Claude Desktop spawns this process.
const __dirname = dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: join(__dirname, ".env") });

// ---------------------------------------------------------------------------
// Gmail API helpers (replaces Proton Bridge IMAP)
// ---------------------------------------------------------------------------

function gmailHeader(msg, name) {
  return msg.payload?.headers?.find(h => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function decodeGmailBody(payload) {
  if (!payload) return "";
  if (payload.body?.data) return Buffer.from(payload.body.data, "base64url").toString("utf-8");
  const parts = payload.parts ?? [];
  for (const part of parts) {
    if (part.mimeType === "text/plain" && part.body?.data)
      return Buffer.from(part.body.data, "base64url").toString("utf-8");
  }
  for (const part of parts) {
    if (part.mimeType === "text/html" && part.body?.data)
      return Buffer.from(part.body.data, "base64url").toString("utf-8");
    if (part.mimeType?.startsWith("multipart/")) {
      const nested = decodeGmailBody(part);
      if (nested) return nested;
    }
  }
  return "";
}

async function fetchGmailUnread(hours = 24) {
  const after = Math.floor((Date.now() - hours * 3_600_000) / 1000);
  const q = encodeURIComponent(`is:unread in:inbox after:${after}`);
  const list = await googleGet(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${q}&maxResults=50`);
  const ids = (list.messages ?? []).map(m => m.id);
  if (ids.length === 0) return [];
  const msgs = await Promise.all(ids.slice(0, 30).map(id =>
    googleGet(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From,Subject,Date`).catch(() => null)
  ));
  return msgs.filter(Boolean).map(msg => ({
    id: msg.id,
    subject: gmailHeader(msg, "Subject") || "(no subject)",
    from: gmailHeader(msg, "From"),
    date: gmailHeader(msg, "Date"),
    snippet: msg.snippet ?? "",
  })).sort((a, b) => new Date(b.date) - new Date(a.date));
}

async function fetchGmailMessages(query = "", limit = 20) {
  const q = encodeURIComponent(query || "in:inbox");
  const list = await googleGet(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${q}&maxResults=${Math.min(limit, 50)}`);
  const ids = (list.messages ?? []).map(m => m.id);
  if (ids.length === 0) return [];
  const msgs = await Promise.all(ids.map(id =>
    googleGet(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From,To,Subject,Date`).catch(() => null)
  ));
  return msgs.filter(Boolean).map(msg => ({
    id: msg.id,
    subject: gmailHeader(msg, "Subject") || "(no subject)",
    from: gmailHeader(msg, "From"),
    to: gmailHeader(msg, "To"),
    date: gmailHeader(msg, "Date"),
    snippet: msg.snippet ?? "",
    labels: msg.labelIds ?? [],
  }));
}

async function fetchGmailMessageBody(messageId) {
  const msg = await googleGet(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=full`);
  return {
    id: msg.id,
    subject: gmailHeader(msg, "Subject") || "(no subject)",
    from: gmailHeader(msg, "From"),
    to: gmailHeader(msg, "To"),
    date: gmailHeader(msg, "Date"),
    body: decodeGmailBody(msg.payload).slice(0, 5000),
    snippet: msg.snippet ?? "",
  };
}

async function fetchGmailLabels() {
  const res = await googleGet("https://gmail.googleapis.com/gmail/v1/users/me/labels");
  return (res.labels ?? []).map(l => ({ id: l.id, name: l.name, type: l.type }));
}

// ---------------------------------------------------------------------------
// Google Calendar API (replaces Proton Calendar ICS)
// ---------------------------------------------------------------------------

async function fetchGoogleCalendarEvents(startDate, endDate) {
  // Fetch all non-hidden calendars
  const calList = await googleGet("https://www.googleapis.com/calendar/v3/users/me/calendarList?showHidden=false&minAccessRole=reader");
  const calendars = (calList.items ?? []).filter(c => c.selected !== false);

  const timeMin = encodeURIComponent(startDate.toISOString());
  const timeMax = encodeURIComponent(endDate.toISOString());

  const allEvents = [];
  await Promise.all(calendars.map(async (cal) => {
    try {
      const evRes = await googleGet(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal.id)}/events?timeMin=${timeMin}&timeMax=${timeMax}&singleEvents=true&orderBy=startTime&maxResults=50`
      );
      for (const ev of evRes.items ?? []) {
        const start = ev.start?.dateTime ?? ev.start?.date;
        const end   = ev.end?.dateTime   ?? ev.end?.date;
        if (!start) continue;
        allEvents.push({
          summary:     ev.summary ?? "(no title)",
          start:       new Date(start).toISOString(),
          end:         end ? new Date(end).toISOString() : null,
          location:    ev.location ?? null,
          description: ev.description ? ev.description.slice(0, 300) : null,
          calendar:    cal.summary ?? cal.id,
          all_day:     !ev.start?.dateTime,
        });
      }
    } catch { /* skip calendars we can't read */ }
  }));

  return allEvents.sort((a, b) => new Date(a.start) - new Date(b.start));
}

// ---------------------------------------------------------------------------
// Ente Photos (local sync folder)
// ---------------------------------------------------------------------------

const ENTE_ROOT = process.env.ENTE_PHOTOS_PATH ?? "C:\\Users\\coyof\\Pictures\\Ente";
const PHOTO_EXTS = new Set([
  ".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic", ".heif",
  ".bmp", ".tiff", ".tif", ".raw", ".cr2", ".nef", ".arw",
  ".mp4", ".mov", ".avi", ".mkv", ".m4v",
]);

async function enteRecentMedia(since, limit = 50) {
  const all = await walkDrive(ENTE_ROOT); // reuses the same recursive walker
  return all
    .filter((f) => PHOTO_EXTS.has(f.ext) && new Date(f.modified) >= since)
    .sort((a, b) => new Date(b.modified) - new Date(a.modified))
    .slice(0, limit)
    .map((f) => {
      const parts = f.path.split("/");
      return {
        file: parts[parts.length - 1],
        album: parts.length > 1 ? parts[0] : "(root)",
        modified: f.modified,
        size_bytes: f.size_bytes,
      };
    });
}

// ---------------------------------------------------------------------------
// walkDrive — recursive folder walker (used by Ente Photos)
// ---------------------------------------------------------------------------

// Recursively walk a folder, collect files with their stats.
// Still used by enteRecentMedia — do not remove.
async function walkDrive(dir, results = [], depth = 0) {
  if (depth > 6) return results; // guard against deeply nested trees
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkDrive(fullPath, results, depth + 1);
    } else if (entry.isFile()) {
      try {
        const s = await stat(fullPath);
        results.push({
          path: relative(dir, fullPath).replace(/\\/g, "/"),
          size_bytes: s.size,
          modified: s.mtime.toISOString(),
          ext: extname(entry.name).toLowerCase(),
        });
      } catch {
        // skip files we can't stat
      }
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Google Drive API (replaces Proton Drive local folder walk)
// ---------------------------------------------------------------------------

async function fetchGoogleDriveRecent(since, limit = 20) {
  const fields  = encodeURIComponent("files(id,name,mimeType,modifiedTime,size,webViewLink)");
  const q       = encodeURIComponent(`modifiedTime>'${since.toISOString()}' and trashed=false`);
  const res = await googleGet(
    `https://www.googleapis.com/drive/v3/files?q=${q}&orderBy=modifiedTime+desc&fields=${fields}&pageSize=${Math.min(limit, 100)}`
  );
  return (res.files ?? []).map(f => ({
    name: f.name,
    type: f.mimeType?.split(".").pop() ?? f.mimeType,
    modified: f.modifiedTime,
    size_bytes: f.size ? parseInt(f.size) : null,
    url: f.webViewLink ?? null,
  }));
}

async function searchGoogleDrive(query) {
  const q      = encodeURIComponent(`name contains '${query.replace(/'/g, "\\'")}' and trashed=false`);
  const fields  = encodeURIComponent("files(id,name,mimeType,modifiedTime,size,webViewLink)");
  const res = await googleGet(
    `https://www.googleapis.com/drive/v3/files?q=${q}&orderBy=modifiedTime+desc&fields=${fields}&pageSize=30`
  );
  return (res.files ?? []).map(f => ({
    name: f.name,
    type: f.mimeType?.split(".").pop() ?? f.mimeType,
    modified: f.modifiedTime,
    size_bytes: f.size ? parseInt(f.size) : null,
    url: f.webViewLink ?? null,
  }));
}

// ---------------------------------------------------------------------------
// Weather (Open-Meteo, no API key required)
// Bloomington, Indiana: 39.1653° N, 86.5264° W
// ---------------------------------------------------------------------------

const BLOOMINGTON = { lat: 39.1653, lon: -86.5264 };

const WMO_CODES = {
  0: "Clear sky", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
  45: "Foggy", 48: "Icy fog",
  51: "Light drizzle", 53: "Moderate drizzle", 55: "Dense drizzle",
  61: "Slight rain", 63: "Moderate rain", 65: "Heavy rain",
  71: "Slight snow", 73: "Moderate snow", 75: "Heavy snow", 77: "Snow grains",
  80: "Slight showers", 81: "Moderate showers", 82: "Violent showers",
  85: "Slight snow showers", 86: "Heavy snow showers",
  95: "Thunderstorm", 96: "Thunderstorm with hail", 99: "Thunderstorm with heavy hail",
};

// Fallback weather from wttr.in — free, no key, single call, very reliable.
// Returns the same shape as fetchWeather() so callers don't need to change.
async function fetchWeatherWttr() {
  const res = await fetch(
    `https://wttr.in/${BLOOMINGTON.lat},${BLOOMINGTON.lon}?format=j1`,
    { headers: { "User-Agent": "personal-mcp/1.0" }, signal: AbortSignal.timeout(8000) }
  );
  if (!res.ok) throw new Error(`wttr.in error: ${res.status}`);
  const d = await res.json();

  const cur = d.current_condition?.[0] ?? {};
  const days = d.weather ?? [];

  const condition = cur.weatherDesc?.[0]?.value ?? "Unknown";

  return {
    location: "Bloomington, Indiana",
    source: "wttr.in (fallback)",
    current: {
      condition,
      temperature_f: parseFloat(cur.temp_F ?? 0),
      feels_like_f:  parseFloat(cur.FeelsLikeF ?? 0),
      humidity_pct:  parseFloat(cur.humidity ?? 0),
      wind_mph:      parseFloat(cur.windspeedMiles ?? 0),
      precipitation_in: parseFloat((cur.precipMM ?? 0) / 25.4),
    },
    today_sunrise: days[0]?.astronomy?.[0]?.sunrise ?? null,
    today_sunset:  days[0]?.astronomy?.[0]?.sunset  ?? null,
    forecast: days.slice(0, 3).map(day => {
      const hourly = day.hourly ?? [];
      const rainChance = hourly.length
        ? Math.max(...hourly.map(h => parseInt(h.chanceofrain ?? 0)))
        : null;
      return {
        date:              day.date,
        condition:         day.hourly?.[4]?.weatherDesc?.[0]?.value ?? "Unknown",
        high_f:            parseFloat(day.maxtempF ?? 0),
        low_f:             parseFloat(day.mintempF ?? 0),
        precip_chance_pct: rainChance,
        precip_in:         null,
        uv_index_max:      parseFloat(day.uvIndex ?? 0),
        sunrise:           day.astronomy?.[0]?.sunrise ?? null,
        sunset:            day.astronomy?.[0]?.sunset  ?? null,
      };
    }),
  };
}

async function fetchWeather() {
  // Primary: Open-Meteo (more precise, structured WMO codes)
  // Fallback: wttr.in (no auth, extremely reliable, same output shape)
  try {
    const url = new URL("https://api.open-meteo.com/v1/forecast");
    url.searchParams.set("latitude", BLOOMINGTON.lat);
    url.searchParams.set("longitude", BLOOMINGTON.lon);
    url.searchParams.set("current", [
      "temperature_2m", "apparent_temperature", "weather_code",
      "wind_speed_10m", "relative_humidity_2m", "precipitation",
    ].join(","));
    url.searchParams.set("daily", [
      "weather_code", "temperature_2m_max", "temperature_2m_min",
      "precipitation_sum", "precipitation_probability_max",
      "sunrise", "sunset", "uv_index_max",
    ].join(","));
    url.searchParams.set("temperature_unit", "fahrenheit");
    url.searchParams.set("wind_speed_unit", "mph");
    url.searchParams.set("precipitation_unit", "inch");
    url.searchParams.set("forecast_days", "3");
    url.searchParams.set("timezone", "America/Indiana/Indianapolis");

    const res = await fetch(url.toString(), { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`Open-Meteo error: ${res.status}`);
    const data = await res.json();

    const c = data.current;
    const d = data.daily;

    return {
      location: "Bloomington, Indiana",
      current: {
        condition: WMO_CODES[c.weather_code] ?? `Code ${c.weather_code}`,
        temperature_f: c.temperature_2m,
        feels_like_f: c.apparent_temperature,
        humidity_pct: c.relative_humidity_2m,
        wind_mph: c.wind_speed_10m,
        precipitation_in: c.precipitation,
      },
      today_sunrise: d.sunrise?.[0] ?? null,
      today_sunset:  d.sunset?.[0]  ?? null,
      forecast: d.time.map((date, i) => ({
        date,
        condition: WMO_CODES[d.weather_code[i]] ?? `Code ${d.weather_code[i]}`,
        high_f: d.temperature_2m_max[i],
        low_f: d.temperature_2m_min[i],
        precip_chance_pct: d.precipitation_probability_max[i],
        precip_in: d.precipitation_sum[i],
        uv_index_max: d.uv_index_max?.[i] ?? null,
        sunrise: d.sunrise?.[i] ?? null,
        sunset:  d.sunset?.[i]  ?? null,
      })),
    };
  } catch {
    // Open-Meteo failed — silently fall back to wttr.in
    return fetchWeatherWttr();
  }
}

// ---------------------------------------------------------------------------
// Standard Notes — local plaintext backup reader
// Reads from the desktop app's automatic plaintext backup folder.
// Structure: <root>/<Notebook>/<Note Title-XXXX_txt>
// ---------------------------------------------------------------------------

const SN_BACKUP_ROOT = process.env.STANDARD_NOTES_BACKUP_PATH ??
  "C:\\Users\\coyof\\Documents\\Standard Note Backup\\coyofroyos@proton.me\\Plaintext Backups";

// Parse note title from backup filename (strips the trailing -XXXX_txt hash)
function snParseTitle(filename) {
  return filename.replace(/-[0-9a-f]{4}_txt$/i, "").trim();
}

async function snGetAllNotes() {
  const notes = [];
  let notebooks;
  try {
    notebooks = await readdir(SN_BACKUP_ROOT, { withFileTypes: true });
  } catch {
    return notes;
  }

  for (const nb of notebooks) {
    if (!nb.isDirectory() || nb.name.startsWith(".")) continue;
    const nbPath = join(SN_BACKUP_ROOT, nb.name);
    let files;
    try { files = await readdir(nbPath, { withFileTypes: true }); } catch { continue; }

    for (const f of files) {
      if (!f.isFile()) continue;
      const fullPath = join(nbPath, f.name);
      try {
        const s = await stat(fullPath);
        notes.push({
          id: f.name,
          title: snParseTitle(f.name),
          notebook: nb.name,
          modified: s.mtime.toISOString(),
          path: fullPath,
        });
      } catch { /* skip */ }
    }
  }

  return notes.sort((a, b) => new Date(b.modified) - new Date(a.modified));
}

async function snReadNote(notePath) {
  const { readFile } = await import("node:fs/promises");
  return (await readFile(notePath, "utf-8")).trim();
}

async function snGetRecentNotes(since) {
  const notes = await snGetAllNotes();
  return notes
    .filter((n) => new Date(n.modified) >= since)
    .map((n) => ({ id: n.id, title: n.title, notebook: n.notebook, modified: n.modified }));
}

async function snCreateNote(title, text, subfolder = null) {
  const { writeFile, mkdir } = await import("node:fs/promises");
  const slug = title.replace(/[^a-z0-9]/gi, "_").slice(0, 40);
  const hash = Math.random().toString(16).slice(2, 6);
  const filename = `${slug}-${hash}_txt`;
  const dir = subfolder ? join(SN_BACKUP_ROOT, subfolder) : SN_BACKUP_ROOT;
  await mkdir(dir, { recursive: true });
  const dest = join(dir, filename);
  await writeFile(dest, text, "utf-8");
  return { saved: true, file: filename, folder: subfolder ?? "root" };
}

// ---------------------------------------------------------------------------
// Day commentary — journal-style narrative summary of the day
// ---------------------------------------------------------------------------

function generateDayCommentary({ date, weather, moonPhase, events, unread, spotifyTracks,
  nowPlaying, enteMedia, driveFiles, health, steam, duolingo, vivaldiHistory,
  hevyWorkouts, miners, btcData, receipts, recentNotes }) {

  const paragraphs = [];

  // ── Paragraph 1: Scene ────────────────────────────────────────────────────
  const w = weather?.current;
  const dayName = date
    ? date.toLocaleDateString("en-US", { weekday: "long", timeZone: "America/Indiana/Indianapolis" })
    : "Today";
  let scene = `${dayName} in Bloomington`;
  if (w) {
    scene += ` — ${(w.condition ?? "").toLowerCase()} and ${w.temperature_f}°F`;
    if (w.wind_mph > 20) scene += `, gusty at ${w.wind_mph} mph`;
  }
  if (moonPhase) scene += `, ${moonPhase.emoji} ${moonPhase.phase}`;
  paragraphs.push(scene + ".");

  // ── Paragraph 2: What you did ─────────────────────────────────────────────
  const did = [];
  if (steam?.currently_playing)
    did.push(`currently in a ${steam.currently_playing.name} session`);
  else if (steam?.recently_played?.[0])
    did.push(`${steam.recently_played[0].playtime_2weeks_h}h in ${steam.recently_played[0].name} recently`);
  if (hevyWorkouts?.length > 0) {
    const wo = hevyWorkouts[0];
    did.push(`logged a ${wo.title} workout${wo.duration_min ? ` (${wo.duration_min} min)` : ""}`);
    if (wo.prs.length > 0) did.push(`hit a PR on ${wo.prs[0]}`);
  }
  if (enteMedia.length >= 20) did.push(`synced ${enteMedia.length} photos/videos to Ente`);
  else if (enteMedia.length > 0) did.push(`added ${enteMedia.length} photo${enteMedia.length > 1 ? "s" : ""} to Ente`);
  if (driveFiles.length > 0) did.push(`updated ${driveFiles.length} file${driveFiles.length > 1 ? "s" : ""} on Google Drive`);
  if (recentNotes?.length > 0) did.push(`wrote ${recentNotes.length} note${recentNotes.length > 1 ? "s" : ""}`);
  const orders = receipts?.filter(r => r.type === "order") ?? [];
  if (orders.length > 0) {
    const stores = [...new Set(orders.map(o => o.store))].slice(0, 2).join(" & ");
    did.push(`${orders.length === 1 ? "an order" : `${orders.length} orders`} from ${stores}`);
  }
  if (did.length > 0) paragraphs.push(`Activity: ${did.join(", ")}.`);

  // ── Paragraph 3: Music vibe ───────────────────────────────────────────────
  const artists = [...new Set(spotifyTracks.map(t => t.artist?.split(",")[0].trim()).filter(Boolean))];
  if (nowPlaying)
    paragraphs.push(`Currently listening to ${nowPlaying.artist} — "${nowPlaying.track}".`);
  else if (artists.length > 0) {
    const count = spotifyTracks.length;
    if (count >= 20)      paragraphs.push(`Heavy Spotify day — ${count} tracks, leaning hard on ${artists[0]}.`);
    else if (count >= 5)  paragraphs.push(`Decent listening session, mostly ${artists.slice(0, 2).join(" and ")}.`);
    else                  paragraphs.push(`Light Spotify day — a few tracks including ${artists[0]}.`);
  } else {
    paragraphs.push(`Quiet on Spotify today — either focused or fully offline.`);
  }

  // ── Paragraph 4: Body & mind ──────────────────────────────────────────────
  const body = [];
  if (health?.steps > 0) {
    if (health.steps >= 10000)     body.push(`strong step count (${health.steps.toLocaleString()})`);
    else if (health.steps >= 5000) body.push(`decent movement at ${health.steps.toLocaleString()} steps`);
    else                            body.push(`mostly desk-bound at ${health.steps.toLocaleString()} steps`);
  }
  if (health?.sleep?.duration_h) {
    const h = health.sleep.duration_h;
    if (h >= 7.5)    body.push(`well-rested (${h}h sleep)`);
    else if (h >= 6) body.push(`${h}h of sleep — decent`);
    else             body.push(`short on sleep (only ${h}h)`);
  }
  if (health?.resting_hr) body.push(`resting HR ${health.resting_hr} bpm`);
  if (duolingo) {
    if (duolingo.streak_active) body.push(`Duolingo streak extended to ${duolingo.streak} days`);
    else if (duolingo.streak > 0) body.push(`Duolingo ${duolingo.streak}-day streak at risk`);
  }
  if (body.length > 0) paragraphs.push(body.join(", ") + ".");

  // ── Paragraph 5: Social context ───────────────────────────────────────────
  const social = [];
  if (unread.length === 0)      social.push("inbox zero");
  else if (unread.length <= 5)  social.push(`${unread.length} unread emails — quiet`);
  else if (unread.length <= 15) social.push(`${unread.length} unread emails`);
  else                           social.push(`${unread.length} unread emails piling up`);
  if (events.length === 0)      social.push("no calendar commitments");
  else if (events.length === 1) social.push(`one event: ${events[0].summary}`);
  else                           social.push(`${events.length} calendar events`);
  if (vivaldiHistory?.top_domains?.[0]) {
    const top = vivaldiHistory.top_domains[0];
    social.push(`lots of time on ${top.domain} (${top.visits} visits)`);
  }
  if (social.length > 0) paragraphs.push(social.join("; ") + ".");

  // ── Paragraph 6: Mining & BTC ─────────────────────────────────────────────
  const miningBits = [];
  if (btcData) {
    const arrow  = btcData.change_24h_pct >= 0 ? "📈" : "📉";
    const change = btcData.change_24h_pct >= 0 ? `+${btcData.change_24h_pct}%` : `${btcData.change_24h_pct}%`;
    miningBits.push(`BTC at $${btcData.price_usd.toLocaleString()} ${arrow} ${change}`);
  }
  const activeMiners = miners?.filter(m => !m.error) ?? [];
  if (activeMiners.length > 0) {
    const totalGh = activeMiners.reduce((s, m) => s + m.hashrate_gh, 0).toFixed(0);
    miningBits.push(`miners at ${totalGh} GH/s combined`);
  }
  if (miningBits.length > 0) paragraphs.push(miningBits.join(", ") + ".");

  return paragraphs.join(" ");
}

// ---------------------------------------------------------------------------
// Spotify
// ---------------------------------------------------------------------------

let spotifyAccessToken = null;
let spotifyTokenExpiry = 0;

async function spotifyRefreshToken() {
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  const refreshToken = process.env.SPOTIFY_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error("Spotify credentials not set. See QUICKSTART.md for setup instructions.");
  }

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });
  if (!res.ok) throw new Error(`Spotify token refresh failed: ${res.status}`);
  const data = await res.json();
  spotifyAccessToken = data.access_token;
  spotifyTokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return spotifyAccessToken;
}

async function spotifyGet(path, params = {}) {
  if (!spotifyAccessToken || Date.now() >= spotifyTokenExpiry) {
    await spotifyRefreshToken();
  }
  const url = new URL(`https://api.spotify.com/v1${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${spotifyAccessToken}` },
  });
  if (!res.ok) throw new Error(`Spotify API error ${res.status}: ${path}`);
  return res.json();
}

async function spotifyRecentlyPlayed(limit = 50) {
  const data = await spotifyGet("/me/player/recently-played", { limit });
  return (data.items ?? []).map((item) => ({
    track: item.track.name,
    artist: item.track.artists.map((a) => a.name).join(", "),
    album: item.track.album.name,
    played_at: item.played_at,
  }));
}

async function spotifyCurrentlyPlaying() {
  try {
    const data = await spotifyGet("/me/player/currently-playing");
    if (!data || !data.item) return null;
    return {
      track: data.item.name,
      artist: data.item.artists.map((a) => a.name).join(", "),
      album: data.item.album.name,
      is_playing: data.is_playing,
      progress_ms: data.progress_ms,
      duration_ms: data.item.duration_ms,
    };
  } catch {
    return null; // nothing playing
  }
}

async function fetchSpotifyRecommendations({ weather, mood, health, steam, hevyWorkouts } = {}) {
  // ── Seed tracks from recently played (need IDs, not in spotifyRecentlyPlayed) ──
  const recentData = await spotifyGet("/me/player/recently-played", { limit: 10 });
  const seedIds = (recentData.items ?? [])
    .map(i => i.track?.id)
    .filter(Boolean)
    .slice(0, 3);  // Spotify allows max 5 seeds total
  if (seedIds.length === 0) return [];

  // ── Context → audio feature targets ────────────────────────────────────────
  let energy      = 0.5;
  let valence     = 0.55; // slight positive bias
  let acousticness = 0.35;
  let tempo       = 110;  // BPM
  const reasons   = [];

  // Time of day
  const hour = new Date().getHours();
  if (hour >= 5 && hour < 9) {
    energy -= 0.1; acousticness += 0.15; tempo -= 15;
    reasons.push("gentle morning energy");
  } else if (hour >= 9 && hour < 17) {
    energy += 0.1; valence += 0.05;
    reasons.push("daytime focus");
  } else if (hour >= 21 || hour < 2) {
    energy -= 0.2; acousticness += 0.2; valence -= 0.05; tempo -= 20;
    reasons.push("late-night wind-down");
  }

  // Weather
  const cond = (weather?.current?.condition ?? "").toLowerCase();
  if (cond.includes("rain") || cond.includes("shower") || cond.includes("drizzle")) {
    acousticness += 0.2; energy -= 0.1; valence -= 0.05;
    reasons.push("rainy day vibes");
  } else if (cond.includes("clear") || cond.includes("sunny")) {
    valence += 0.1; energy += 0.05;
    reasons.push("clear sky mood lift");
  } else if (cond.includes("snow") || cond.includes("fog")) {
    acousticness += 0.15; energy -= 0.15; tempo -= 10;
    reasons.push("cozy weather");
  }

  // Mood note
  if (mood?.mood) {
    const score = parseFloat(mood.mood); // e.g. "4/5" → 4
    if (!isNaN(score)) {
      valence  += (score - 3) * 0.08;  // above 3 = happier
      energy   += (score - 3) * 0.04;
    }
    const energyScore = mood.energy ? parseFloat(mood.energy) : null;
    if (energyScore != null) energy += (energyScore - 3) * 0.06;
  }

  // Workout today → pump it up
  if (hevyWorkouts?.length > 0) {
    energy += 0.15; tempo += 15; valence += 0.05;
    reasons.push("post-workout energy");
  }

  // Health steps
  if ((health?.steps ?? 0) > 8000) {
    energy += 0.05;
    reasons.push("active day");
  }

  // Current game context → genre influence via explicit genre seeds
  const steamGame = (steam?.currently_playing?.name ?? steam?.recently_played?.[0]?.name ?? "").toLowerCase();
  const genreHints = [];
  if (/fallout|skyrim|elder scrolls|rpg|witcher/i.test(steamGame))   genreHints.push("ambient", "folk");
  if (/dead rising|resident evil|horror|zombie/i.test(steamGame))    genreHints.push("metal", "industrial");
  if (/civ|cities|strategy|simulator/i.test(steamGame))              genreHints.push("classical", "ambient");
  if (/stardew|animal crossing|cozy/i.test(steamGame))               genreHints.push("indie", "folk");

  // Clamp all values
  energy       = Math.max(0.1, Math.min(0.95, energy));
  valence      = Math.max(0.1, Math.min(0.95, valence));
  acousticness = Math.max(0.05, Math.min(0.95, acousticness));
  tempo        = Math.max(60, Math.min(180, tempo));

  // ── Build request ────────────────────────────────────────────────────────
  const params = {
    seed_tracks:           seedIds.join(","),
    limit:                 8,
    target_energy:         energy.toFixed(2),
    target_valence:        valence.toFixed(2),
    target_acousticness:   acousticness.toFixed(2),
    target_tempo:          Math.round(tempo),
    min_popularity:        20,
  };

  const data = await spotifyGet("/recommendations", params);

  return {
    tracks: (data.tracks ?? []).map(t => ({
      name:    t.name,
      artist:  t.artists.map(a => a.name).join(", "),
      album:   t.album?.name ?? null,
      url:     t.external_urls?.spotify ?? null,
      preview: t.preview_url ?? null,
    })),
    context: {
      energy:       parseFloat(energy.toFixed(2)),
      valence:      parseFloat(valence.toFixed(2)),
      acousticness: parseFloat(acousticness.toFixed(2)),
      tempo:        Math.round(tempo),
      reasons,
    },
  };
}

// ---------------------------------------------------------------------------
// Google API — unified OAuth token (Health, Gmail, Calendar, Drive, Tasks)
// ---------------------------------------------------------------------------

let googleAccessToken = null;
let googleTokenExpiry = 0;

async function googleRefreshToken() {
  const clientId     = process.env.GOOGLE_CLIENT_ID     ?? process.env.GOOGLE_HEALTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET ?? process.env.GOOGLE_HEALTH_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN ?? process.env.GOOGLE_HEALTH_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken)
    throw new Error("Google credentials not configured. Run health-auth.js to set up.");
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret,
      refresh_token: refreshToken, grant_type: "refresh_token" }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Google token refresh failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  googleAccessToken = data.access_token;
  googleTokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return googleAccessToken;
}

async function googleGet(url) {
  if (!googleAccessToken || Date.now() >= googleTokenExpiry) await googleRefreshToken();
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${googleAccessToken}` },
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`Google API ${res.status}: ${url}`);
  return res.json();
}

async function googlePost(url, body) {
  if (!googleAccessToken || Date.now() >= googleTokenExpiry) await googleRefreshToken();
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${googleAccessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`Google API ${res.status}: ${url}`);
  return res.json();
}

function healthDayRange(dateStr) {
  // dateStr: "YYYY-MM-DD"
  const [year, month, day] = dateStr.split("-").map(Number);
  return {
    start: { date: { year, month, day }, time: { hours: 0, minutes: 0, seconds: 0, nanos: 0 } },
    end:   { date: { year, month, day }, time: { hours: 23, minutes: 59, seconds: 59, nanos: 999999999 } },
  };
}

async function fetchHealthDay(dateStr) {
  const BASE = "https://health.googleapis.com/v4/users/me/dataTypes";
  const range = healthDayRange(dateStr);
  const body  = { range, windowSizeDays: 1 };

  const [stepsRes, calsRes, activeRes, hrRes, sleepRes] = await Promise.allSettled([
    googlePost(`${BASE}/steps/dataPoints:dailyRollUp`, body),
    googlePost(`${BASE}/total-calories/dataPoints:dailyRollUp`, body),
    googlePost(`${BASE}/active-minutes/dataPoints:dailyRollUp`, body),
    googlePost(`${BASE}/heart-rate/dataPoints:dailyRollUp`, body),
    // Sleep uses list, not dailyRollUp
    googleGet(`${BASE}/sleep/dataPoints?startTime=${dateStr}T00:00:00&endTime=${dateStr}T23:59:59`),
  ]);

  const val = (res, path) => {
    if (res.status !== "fulfilled") return null;
    const pt = res.value?.rollupDataPoints?.[0];
    if (!pt) return null;
    return path.split(".").reduce((o, k) => o?.[k], pt) ?? null;
  };

  const steps    = val(stepsRes,  "steps.countSum")           ?? 0;
  const calories = val(calsRes,   "totalCalories.kcalSum")    ?? 0;
  const active   = val(activeRes, "activeMinutes.minuteSum")  ?? 0;
  const restingHr= val(hrRes,     "heartRate.bpmAverage");

  // Parse sleep sessions
  let sleep = null;
  if (sleepRes.status === "fulfilled") {
    const sessions = sleepRes.value?.dataPoints ?? [];
    const longest  = sessions.reduce((best, s) => {
      const dur = (new Date(s.endTime) - new Date(s.startTime));
      return dur > (best?.dur ?? 0) ? { s, dur } : best;
    }, null);
    if (longest) {
      const s = longest.s;
      sleep = {
        duration_h: parseFloat((longest.dur / 3_600_000).toFixed(1)),
        start:      s.startTime,
        end:        s.endTime,
      };
    }
  }

  return { steps, calories_burned: Math.round(calories), active_minutes: Math.round(active), resting_hr: restingHr ? Math.round(restingHr) : null, sleep };
}

// ---------------------------------------------------------------------------
// Steam
// ---------------------------------------------------------------------------

async function fetchSteamData() {
  const apiKey  = process.env.STEAM_API_KEY;
  const steamId = process.env.STEAM_ID;
  if (!apiKey || !steamId) throw new Error("STEAM_API_KEY and STEAM_ID required in .env");

  const base = "https://api.steampowered.com";

  const [summaryRes, recentRes] = await Promise.all([
    fetch(`${base}/ISteamUser/GetPlayerSummaries/v2/?key=${apiKey}&steamids=${steamId}`).then(r => r.json()),
    fetch(`${base}/IPlayerService/GetRecentlyPlayedGames/v1/?key=${apiKey}&steamid=${steamId}&count=10&format=json`).then(r => r.json()),
  ]);

  const player = summaryRes?.response?.players?.[0] ?? {};
  const currentGame = player.gameextrainfo ? { name: player.gameextrainfo, appid: player.gameid } : null;

  // Get game names via GetOwnedGames with include_appinfo — single API call, no store scraping
  const recent = recentRes?.response?.games ?? [];
  const top8   = recent.slice(0, 8);
  let nameMap  = {};
  if (top8.length > 0) {
    try {
      const params = new URLSearchParams({ key: apiKey, steamid: steamId, include_appinfo: 1 });
      top8.forEach((g, i) => params.append(`appids_filter[${i}]`, g.appid));
      const ownedRes  = await fetch(`${base}/IPlayerService/GetOwnedGames/v1/?${params}`, { signal: AbortSignal.timeout(8000) });
      const ownedData = await ownedRes.json();
      for (const g of ownedData?.response?.games ?? []) nameMap[g.appid] = g.name;
    } catch { /* fall back to App XXXXX */ }
  }

  const withNames = top8.map((g) => ({
    name:              nameMap[g.appid] ?? `App ${g.appid}`,
    appid:             g.appid,
    playtime_2weeks_h: parseFloat((g.playtime_2weeks / 60).toFixed(1)),
    playtime_total_h:  parseFloat((g.playtime_forever / 60).toFixed(1)),
    last_played:       g.rtime_last_played ? new Date(g.rtime_last_played * 1000).toISOString() : null,
  }));

  // Check for achievements unlocked today — only look at games played in the last 48h
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const recentAppIds = withNames
    .filter(g => g.last_played && (Date.now() - new Date(g.last_played).getTime()) < 48 * 3600 * 1000)
    .slice(0, 5)
    .map(g => g.appid);

  const achievementsToday = [];
  await Promise.all(recentAppIds.map(async (appid) => {
    try {
      const res = await fetch(
        `${base}/ISteamUserStats/GetPlayerAchievements/v1/?key=${apiKey}&steamid=${steamId}&appid=${appid}&l=english`,
        { signal: AbortSignal.timeout(8000) }
      );
      if (!res.ok) return;
      const data = await res.json();
      const gameName = nameMap[appid] ?? `App ${appid}`;
      for (const ach of data?.playerstats?.achievements ?? []) {
        if (ach.achieved && ach.unlocktime * 1000 >= todayStart.getTime()) {
          achievementsToday.push({
            game:        gameName,
            name:        ach.displayname ?? ach.apiname,
            description: ach.description?.slice(0, 150) ?? null,
            unlocked_at: new Date(ach.unlocktime * 1000).toISOString(),
          });
        }
      }
    } catch { /* non-fatal */ }
  }));
  achievementsToday.sort((a, b) => new Date(a.unlocked_at) - new Date(b.unlocked_at));

  return { currently_playing: currentGame, recently_played: withNames, achievements_today: achievementsToday };
}

// ---------------------------------------------------------------------------
// Duolingo
// ---------------------------------------------------------------------------

async function fetchDuolingo() {
  const username = process.env.DUOLINGO_USERNAME ?? "COYOMCFROYO";
  const res = await fetch(
    `https://www.duolingo.com/2017-06-30/users?username=${encodeURIComponent(username)}`,
    { headers: { "User-Agent": "Mozilla/5.0 (compatible; personal-mcp/1.0)" } }
  );
  if (!res.ok) throw new Error(`Duolingo API ${res.status}`);
  const data = await res.json();
  const user = data.users?.[0];
  if (!user) throw new Error("Duolingo user not found");

  const courses = (user.courses ?? []).map(c => ({
    language:        c.title,
    xp:              c.xp,
    level:           c.level,
    crowns:          c.crowns,
    fluency_percent: c.fluencyScore ? Math.round(c.fluencyScore * 100) : null,
  }));

  return {
    streak:        user.streak ?? 0,
    total_xp:      user.totalXp ?? 0,
    xp_today:      user.xpToday ?? 0,
    xp_goal:       user.xpGoal ?? 50,
    streak_active: (user.xpToday ?? 0) >= (user.xpGoal ?? 1),
    courses,
  };
}

// ---------------------------------------------------------------------------
// Vivaldi history
// ---------------------------------------------------------------------------

async function fetchVivaldiHistory(since, limit = 30) {
  const { tmpdir } = await import("node:os");
  const { copyFile, unlink } = await import("node:fs/promises");
  const { createRequire } = await import("node:module");

  const historyPath = process.env.VIVALDI_HISTORY_PATH
    ?? `${process.env.LOCALAPPDATA}\\Vivaldi\\User Data\\Default\\History`;

  // Copy the DB — Vivaldi holds a lock on the original while running
  const tmpPath = join(tmpdir(), `vivaldi-history-${Date.now()}.db`);
  await copyFile(historyPath, tmpPath);

  let rows = [];
  try {
    // better-sqlite3 is a CommonJS module — load via createRequire
    const require = createRequire(import.meta.url);
    const Database = require("better-sqlite3");
    const db = new Database(tmpPath, { readonly: true, fileMustExist: true });

    // Chromium timestamps: microseconds since 1601-01-01
    const chromiumEpochOffset = 11644473600n * 1_000_000n;
    const sinceChrome = BigInt(since.getTime()) * 1000n + chromiumEpochOffset;

    rows = db.prepare(`
      SELECT u.url, u.title, COUNT(*) AS visits
      FROM visits v
      JOIN urls u ON v.url = u.id
      WHERE v.visit_time >= ?
      GROUP BY u.url
      ORDER BY visits DESC
      LIMIT ?
    `).all(sinceChrome.toString(), limit);

    db.close();
  } finally {
    await unlink(tmpPath).catch(() => {});
  }

  // Group by domain
  const byDomain = {};
  for (const row of rows) {
    try {
      const domain = new URL(row.url).hostname.replace(/^www\./, "");
      byDomain[domain] = (byDomain[domain] ?? 0) + row.visits;
    } catch { /* skip malformed URLs */ }
  }

  const domains = Object.entries(byDomain)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([domain, visits]) => ({ domain, visits }));

  return { total_visits: rows.reduce((s, r) => s + r.visits, 0), top_domains: domains };
}

// ---------------------------------------------------------------------------
// Vivaldi Notes (JSON file in Vivaldi profile)
// ---------------------------------------------------------------------------

async function fetchVivaldiNotes(limit = 20) {
  const { readFile } = await import("node:fs/promises");
  const notesPath = process.env.VIVALDI_NOTES_PATH
    ?? join(
      process.env.LOCALAPPDATA ?? `C:\\Users\\${process.env.USERNAME}\\AppData\\Local`,
      "Vivaldi", "User Data", "Default", "Notes"
    );

  let raw;
  try { raw = await readFile(notesPath, "utf-8"); } catch { return null; }
  let data;
  try { data = JSON.parse(raw); } catch { return null; }

  const notes = [];
  const CHROMIUM_EPOCH_OFFSET_MS = 11644473600000; // ms between 1601 and 1970 epochs

  const walk = (node, folderName) => {
    if (!node || typeof node !== "object") return;
    if (node.type === "note") {
      let addedAt = null;
      if (node.date_added) {
        try {
          // Vivaldi/Chromium timestamps: microseconds since 1601-01-01
          const ms = Number(BigInt(node.date_added) / 1000n) - CHROMIUM_EPOCH_OFFSET_MS;
          addedAt = new Date(ms).toISOString();
        } catch { /* ignore */ }
      }
      notes.push({
        id:       node.id ?? null,
        title:    (node.name ?? "").slice(0, 100) || "(untitled)",
        folder:   folderName,
        content:  (node.content ?? "").slice(0, 300),
        added_at: addedAt,
      });
    } else if (Array.isArray(node.children)) {
      const nextFolder = (node.type === "folder" && node.name) ? node.name : folderName;
      for (const child of node.children) walk(child, nextFolder);
    }
  };

  const roots = data.roots ?? {};
  for (const [rootKey, rootNode] of Object.entries(roots)) {
    if (rootKey === "trash" || rootKey === "sync_transaction_version") continue;
    if (rootNode && typeof rootNode === "object") walk(rootNode, "Notes");
  }

  notes.sort((a, b) => {
    if (!a.added_at && !b.added_at) return 0;
    if (!a.added_at) return 1;
    if (!b.added_at) return -1;
    return new Date(b.added_at) - new Date(a.added_at);
  });

  return { total: notes.length, notes: notes.slice(0, limit) };
}

// ---------------------------------------------------------------------------
// Windows Activity History (ConnectedDevicesPlatform SQLite DB)
// Tracks time spent per app — requires Activity History enabled in Settings.
// ---------------------------------------------------------------------------

async function fetchActivityHistory(since, limit = 15) {
  const { copyFile, unlink } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { createRequire } = await import("node:module");

  // Auto-detect the DB — the folder name under ConnectedDevicesPlatform is user-specific
  const cdpBase = join(
    process.env.LOCALAPPDATA ?? `C:\\Users\\${process.env.USERNAME}\\AppData\\Local`,
    "ConnectedDevicesPlatform"
  );
  let dbPath = null;
  try {
    const folders = await readdir(cdpBase, { withFileTypes: true });
    for (const f of folders) {
      if (!f.isDirectory()) continue;
      const candidate = join(cdpBase, f.name, "ActivitiesCache.db");
      try { await stat(candidate); dbPath = candidate; break; } catch {}
    }
  } catch { return null; }
  if (!dbPath) return null;

  const tmpPath = join(tmpdir(), `activity-cache-${Date.now()}.db`);
  try { await copyFile(dbPath, tmpPath); } catch { return null; }

  let apps = [];
  try {
    const require = createRequire(import.meta.url);
    const Database = require("better-sqlite3");
    const db = new Database(tmpPath, { readonly: true, fileMustExist: true });

    // ActivityType 5 = app activity; StartTime/EndTime are Unix timestamps (seconds)
    const sinceTs = Math.floor(since.getTime() / 1000);
    const rows = db.prepare(`
      SELECT AppId, StartTime, EndTime
      FROM Activities
      WHERE ActivityType = 5
        AND StartTime >= ?
        AND EndTime > StartTime
        AND EndTime - StartTime < 86400
      ORDER BY StartTime DESC
      LIMIT 500
    `).all(sinceTs);
    db.close();

    // Parse app name from the JSON AppId field
    const parseAppName = (appIdStr) => {
      try {
        const arr = JSON.parse(appIdStr);
        const entry = Array.isArray(arr) ? arr[0] : arr;
        const id = String(entry?.application ?? entry?.packageFamilyName ?? entry ?? appIdStr);
        if (id.includes("\\")) return id.split("\\").pop().replace(/\.exe$/i, "");
        if (id.includes("_8wekyb3d8bbwe")) return id.split("_")[0].replace(/^Microsoft\./i, "");
        if (id.includes("_")) return id.split("_")[0];
        return id.slice(0, 50);
      } catch {
        const s = String(appIdStr).replace(/[[\]"]/g, "");
        if (s.includes("\\")) return s.split("\\").pop().replace(/\.exe$/i, "");
        return s.slice(0, 50);
      }
    };

    const timeByApp = {};
    for (const row of rows) {
      const name = parseAppName(row.AppId);
      if (!name || name.startsWith("{")) continue;
      const secs = Math.min(row.EndTime - row.StartTime, 7200); // cap at 2h per session
      timeByApp[name] = (timeByApp[name] ?? 0) + secs;
    }

    apps = Object.entries(timeByApp)
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([app, secs]) => ({
        app,
        duration_min: parseFloat((secs / 60).toFixed(1)),
      }));
  } finally {
    await unlink(tmpPath).catch(() => {});
  }

  return { since: since.toISOString(), apps };
}

// ---------------------------------------------------------------------------
// PC hardware stats — GPU via nvidia-smi, CPU + RAM via PowerShell CIM
// ---------------------------------------------------------------------------

async function fetchPcHardware() {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);

  const result = { gpus: null, cpu: null, ram: null };

  // ── GPU via nvidia-smi ────────────────────────────────────────────────────
  try {
    const { stdout } = await execFileAsync(
      "C:\\Windows\\System32\\nvidia-smi.exe",
      [
        "--query-gpu=name,utilization.gpu,utilization.memory,temperature.gpu,memory.used,memory.total,power.draw",
        "--format=csv,noheader,nounits",
      ],
      { timeout: 8000 }
    );
    result.gpus = stdout.trim().split("\n").map(line => {
      const p = line.split(", ").map(s => s.trim());
      const n = (s, fn = parseInt) => (s && s !== "[Not Supported]" && s !== "N/A") ? fn(s) : null;
      return {
        name:                p[0] ?? "Unknown GPU",
        gpu_utilization_pct: n(p[1]),
        mem_utilization_pct: n(p[2]),
        temperature_c:       n(p[3]),
        vram_used_mb:        n(p[4]),
        vram_total_mb:       n(p[5]),
        power_w:             n(p[6], parseFloat),
      };
    });
  } catch { /* nvidia-smi not found or GPU absent */ }

  // ── CPU + RAM via PowerShell CIM ──────────────────────────────────────────
  try {
    // Single semicolon-separated command so we pay only one powershell startup cost
    const psCmd = "$cpu=(Get-CimInstance Win32_Processor|Measure-Object LoadPercentage -Average).Average; $os=Get-CimInstance Win32_OperatingSystem; $cs=Get-CimInstance Win32_ComputerSystem; $cn=(Get-CimInstance Win32_Processor|Select-Object -First 1).Name; [PSCustomObject]@{cpu_load=[int]$cpu; cpu_name=$cn; ram_total_gb=[math]::Round($cs.TotalPhysicalMemory/1GB,1); ram_free_gb=[math]::Round($os.FreePhysicalMemory/1MB,1); ram_used_pct=[math]::Round((1-$os.FreePhysicalMemory*1KB/$cs.TotalPhysicalMemory)*100,1)}|ConvertTo-Json";
    const { stdout: psOut } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", psCmd],
      { timeout: 15000 }
    );
    const parsed = JSON.parse(psOut.trim());
    result.cpu = {
      name:     (parsed.cpu_name ?? "").replace(/\(R\)/g, "®").replace(/\(TM\)/g, "™").trim(),
      load_pct: parsed.cpu_load,
    };
    result.ram = {
      total_gb: parsed.ram_total_gb,
      free_gb:  parsed.ram_free_gb,
      used_pct: parsed.ram_used_pct,
    };
  } catch { /* PowerShell unavailable */ }

  return result;
}

// ---------------------------------------------------------------------------
// BitAxe miners (local REST API)
// ---------------------------------------------------------------------------

async function fetchBitaxe(ip) {
  const res = await fetch(`http://${ip}/api/system/info`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`BitAxe ${ip}: HTTP ${res.status}`);
  const d = await res.json();
  return {
    ip,
    hostname:         d.hostname ?? ip,
    model:            d.ASICModel ?? d.chipModel ?? "Unknown",
    hashrate_gh:      parseFloat((d.hashRate ?? 0).toFixed(2)),
    temp_c:           d.temp ?? null,
    power_w:          d.power != null ? parseFloat(d.power.toFixed(1)) : null,
    efficiency_j_th:  (d.power && d.hashRate) ? parseFloat((d.power / (d.hashRate / 1000)).toFixed(2)) : null,
    best_diff:        d.bestDiff ?? null,
    best_session_diff:d.bestSessionDiff ?? null,
    shares_accepted:  d.sharesAccepted ?? 0,
    shares_rejected:  d.sharesRejected ?? 0,
    uptime_h:         d.uptimeSeconds != null ? parseFloat((d.uptimeSeconds / 3600).toFixed(1)) : null,
    frequency_mhz:    d.frequency ?? null,
    stratum_url:      d.stratumURL ?? null,
  };
}

async function fetchAllBitaxe() {
  const ips = (process.env.BITAXE_IPS ?? "192.168.1.78,192.168.1.178").split(",").map(s => s.trim()).filter(Boolean);
  const results = await Promise.allSettled(ips.map(ip => fetchBitaxe(ip)));
  return results.map((r, i) =>
    r.status === "fulfilled" ? r.value : { ip: ips[i], error: r.reason?.message ?? "unreachable" }
  );
}

// ---------------------------------------------------------------------------
// Mining pools
// ---------------------------------------------------------------------------

async function fetchBraiinsStats() {
  const username = process.env.BRAIINS_USERNAME ?? "CoYo";
  const apiToken = process.env.BRAIINS_API_TOKEN; // Generate at: pool.braiins.com → Account → API Access
  if (!apiToken) throw new Error("BRAIINS_API_TOKEN not set. Generate one at pool.braiins.com → Account → API Access, then add it to .env");

  const res = await fetch(
    `https://pool.braiins.com/accounts/profile/json/btc/`,
    {
      headers: {
        "User-Agent":    "Mozilla/5.0 (compatible; personal-mcp/1.0)",
        "X-SlushPool-Auth-Token": apiToken,
      },
      signal: AbortSignal.timeout(8000),
    }
  );
  if (!res.ok) throw new Error(`Braiins API ${res.status}: ${await res.text().then(t => t.slice(0, 100))}`);
  const d = await res.json();
  const btc = d.btc ?? {};
  return {
    username,
    hash_rate_5m:    btc.hash_rate_5m   != null ? parseFloat(parseFloat(btc.hash_rate_5m).toFixed(2))  : null,
    hash_rate_60m:   btc.hash_rate_60m  != null ? parseFloat(parseFloat(btc.hash_rate_60m).toFixed(2)) : null,
    hash_rate_24h:   btc.hash_rate_24h  != null ? parseFloat(parseFloat(btc.hash_rate_24h).toFixed(2)) : null,
    workers_ok:      btc.ok_workers          ?? null,
    workers_total:   btc.all_workers         ?? null,
    unconfirmed_btc: btc.unconfirmed_reward  ?? null,
    confirmed_btc:   btc.confirmed_reward    ?? null,
    all_time_btc:    btc.all_time_reward     ?? null,
  };
}

async function fetchPublicPoolStats() {
  const address = process.env.PUBLIC_POOL_ADDRESS ?? "bc1qpkay8mq57cey8k5sk24s4kklg072zr2jt33d0n";
  // public-pool.io REST API
  const base = process.env.PUBLIC_POOL_API ?? "https://public-pool.io:40557";
  const res = await fetch(`${base}/api/client/${address}`, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; personal-mcp/1.0)" },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Public Pool API ${res.status}`);
  const d = await res.json();
  // API returns array of workers or a stats object depending on version
  const workers = Array.isArray(d) ? d : (d.workers ?? []);
  const totalHash = workers.reduce((s, w) => s + (w.hashrate ?? w.currentHashrate ?? 0), 0);
  const bestDiff  = workers.reduce((best, w) => {
    const b = w.bestDifficulty ?? w.bestDiff ?? 0;
    return b > best ? b : best;
  }, 0);
  return {
    address: address.slice(0, 12) + "…",
    workers: workers.length,
    hashrate_gh: parseFloat((totalHash / 1e9).toFixed(2)),
    best_difficulty: bestDiff > 0 ? bestDiff : null,
    blocks_found: d.blockCount ?? d.blocksFound ?? null,
  };
}

// ---------------------------------------------------------------------------
// Daily fun content — fact, joke, quote
// ---------------------------------------------------------------------------

async function fetchDailyFact() {
  const res = await fetch("https://uselessfacts.jsph.pl/api/v2/facts/random?language=en", {
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) throw new Error(`Facts API ${res.status}`);
  const d = await res.json();
  return d.text ?? null;
}

async function fetchDailyJoke() {
  const res = await fetch(
    "https://v2.jokeapi.dev/joke/Any?blacklistFlags=nsfw,racist,sexist,explicit&type=twopart",
    { signal: AbortSignal.timeout(6000) }
  );
  if (!res.ok) throw new Error(`Joke API ${res.status}`);
  const d = await res.json();
  if (d.error) throw new Error(d.message);
  return { setup: d.setup, punchline: d.delivery };
}

async function fetchDailyQuote() {
  const res = await fetch("https://zenquotes.io/api/random", { signal: AbortSignal.timeout(6000) });
  if (!res.ok) throw new Error(`Quote API ${res.status}`);
  const [d] = await res.json();
  return { quote: d.q, author: d.a };
}

// ---------------------------------------------------------------------------
// Hevy workout tracker
// ---------------------------------------------------------------------------

async function fetchHevyWorkouts({ since = null, limit = 10 } = {}) {
  const apiKey = process.env.HEVY_API_KEY;
  if (!apiKey) throw new Error("HEVY_API_KEY not set in .env");

  const res = await fetch(
    `https://api.hevyapp.com/v1/workouts?page=1&pageSize=${limit}`,
    { headers: { "api-key": apiKey }, signal: AbortSignal.timeout(8000) }
  );
  if (!res.ok) throw new Error(`Hevy API ${res.status}`);
  const data = await res.json();

  const workouts = (data.workouts ?? []).map(w => {
    const totalSets  = w.exercises?.reduce((s, e) => s + (e.sets?.length ?? 0), 0) ?? 0;
    const totalVolume = w.exercises?.reduce((vol, e) =>
      vol + (e.sets ?? []).reduce((sv, s) =>
        sv + ((s.weight_kg ?? 0) * (s.reps ?? 0)), 0), 0) ?? 0;
    const prs = w.exercises?.flatMap(e =>
      (e.sets ?? []).filter(s => s.indicator === "personal_record").map(() => e.title)
    ) ?? [];
    return {
      id:           w.id,
      title:        w.title ?? "Workout",
      started_at:   w.start_time,
      duration_min: w.duration ? Math.round(w.duration / 60) : null,
      exercises:    w.exercises?.length ?? 0,
      total_sets:   totalSets,
      volume_kg:    parseFloat(totalVolume.toFixed(1)),
      volume_lbs:   parseFloat((totalVolume * 2.20462).toFixed(1)),
      prs:          [...new Set(prs)],
    };
  });

  return since
    ? workouts.filter(w => new Date(w.started_at) >= since)
    : workouts;
}

// ---------------------------------------------------------------------------
// Universal receipt & transaction email scanner (Gmail-based)
// ---------------------------------------------------------------------------

function extractField(text, patterns) {
  for (const pat of patterns) {
    const m = text.match(pat);
    if (m) return m[1]?.trim() ?? null;
  }
  return null;
}

async function fetchAllReceipts(hours = 72) {
  const after = Math.floor((Date.now() - hours * 3_600_000) / 1000);
  const subjects = [
    "order confirmation", "order confirmed", "receipt", "invoice",
    "has shipped", "shipping confirmation", "out for delivery", "delivered",
    "your purchase", "payment confirmation", "your receipt",
  ];
  const q = encodeURIComponent(
    `(${subjects.map(s => `subject:"${s}"`).join(" OR ")}) after:${after}`
  );
  const list = await googleGet(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${q}&maxResults=30`);
  const ids  = (list.messages ?? []).map(m => m.id);
  if (ids.length === 0) return [];

  const msgs = await Promise.all(ids.map(id =>
    googleGet(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`).catch(() => null)
  ));

  return msgs.filter(Boolean).map(msg => {
    const subject = gmailHeader(msg, "Subject");
    const from    = gmailHeader(msg, "From");
    const date    = gmailHeader(msg, "Date");
    const body    = decodeGmailBody(msg.payload);

    const store = (() => {
      const friendly = from.match(/"([^"]+)"/)?.[1] ?? from.match(/^([^<]+)/)?.[1]?.trim();
      if (friendly && friendly.length < 60) return friendly.replace(/no.?reply|noreply|alert|notification/gi, "").trim();
      const domain = from.match(/@([\w.-]+)/)?.[1] ?? "";
      return domain.split(".").slice(-2, -1)[0] ?? "Unknown";
    })();

    const order = extractField(body, [
      /Order\s*(?:#|Number|No\.?|ID)[:\s#]*([\w-]{4,30})/i,
      /Confirmation\s*(?:#|Number|No\.?|Code)[:\s#]*([\w-]{4,30})/i,
      /Invoice\s*(?:#|No\.?)[:\s#]*([\w-]{4,30})/i,
    ]);

    const allAmounts = [...body.matchAll(/\$\s?([\d,]+\.\d{2})/g)].map(m => m[1]);
    const total = allAmounts.length > 0
      ? `$${allAmounts.reduce((max, a) => parseFloat(a.replace(",","")) > parseFloat(max.replace(",","")) ? a : max)}`
      : null;

    const status = body.match(
      /\b(shipped|delivered|out for delivery|arriving|processing|confirmed|preparing|cancelled|refunded)\b/i
    )?.[1] ?? null;

    const arriving = extractField(body, [
      /arriving\s+((?:today|tomorrow|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)[\w,\s]*\d{0,2})/i,
      /estimated\s+delivery[:\s]+([^\n<.]{3,40})/i,
      /delivers?\s+((?:today|tomorrow|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)[\w,\s]*\d{0,2})/i,
      /expected\s+by[:\s]+([^\n<.]{3,30})/i,
    ]);

    return {
      type:    "order",
      store,
      subject: subject.slice(0, 120),
      order:   order ?? null,
      total:   total ?? null,
      status:  status ?? null,
      arriving: arriving ?? null,
      date:    date,
    };
  }).filter(r => r.store);
}

// ---------------------------------------------------------------------------
// Moon phase (pure calculation — no API needed)
// ---------------------------------------------------------------------------

function getMoonPhase(date = new Date()) {
  const KNOWN_NEW_MOON = new Date("2000-01-06T18:14:00Z");
  const LUNAR_CYCLE   = 29.53058867;
  const elapsed = (date - KNOWN_NEW_MOON) / 86_400_000;
  const phase   = ((elapsed % LUNAR_CYCLE) + LUNAR_CYCLE) % LUNAR_CYCLE;
  const phases  = [
    { max:  1.85, name: "New Moon",        emoji: "🌑" },
    { max:  7.38, name: "Waxing Crescent", emoji: "🌒" },
    { max:  9.22, name: "First Quarter",   emoji: "🌓" },
    { max: 14.77, name: "Waxing Gibbous",  emoji: "🌔" },
    { max: 16.61, name: "Full Moon",       emoji: "🌕" },
    { max: 22.15, name: "Waning Gibbous",  emoji: "🌖" },
    { max: 23.99, name: "Last Quarter",    emoji: "🌗" },
    { max: 29.53, name: "Waning Crescent", emoji: "🌘" },
  ];
  const p = phases.find(p => phase < p.max) ?? phases[0];
  return { phase: p.name, emoji: p.emoji, age_days: parseFloat(phase.toFixed(1)) };
}

// ---------------------------------------------------------------------------
// Bitcoin price & network (CoinGecko + mempool.space)
// ---------------------------------------------------------------------------

async function fetchBtcData() {
  const res = await fetch(
    "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true&include_market_cap=true",
    { headers: { "User-Agent": "personal-mcp/1.0" }, signal: AbortSignal.timeout(8000) }
  );
  if (!res.ok) throw new Error(`CoinGecko ${res.status}`);
  const d = (await res.json()).bitcoin;
  return {
    price_usd:      Math.round(d.usd),
    change_24h_pct: parseFloat((d.usd_24h_change ?? 0).toFixed(2)),
    market_cap_b:   parseFloat((d.usd_market_cap / 1e9).toFixed(1)),
    volume_24h_b:   parseFloat((d.usd_24h_vol   / 1e9).toFixed(2)),
  };
}

async function fetchMempoolStats() {
  const [feesRes, diffRes, heightRes] = await Promise.allSettled([
    fetch("https://mempool.space/api/v1/fees/recommended",       { signal: AbortSignal.timeout(8000) }).then(r => r.json()),
    fetch("https://mempool.space/api/v1/difficulty-adjustment",  { signal: AbortSignal.timeout(8000) }).then(r => r.json()),
    fetch("https://mempool.space/api/blocks/tip/height",         { signal: AbortSignal.timeout(8000) }).then(r => r.text()),
  ]);
  return {
    fees: feesRes.status === "fulfilled" ? {
      fastest_sat_vb:  feesRes.value.fastestFee,
      halfhour_sat_vb: feesRes.value.halfHourFee,
      hour_sat_vb:     feesRes.value.hourFee,
      economy_sat_vb:  feesRes.value.economyFee,
    } : null,
    difficulty: diffRes.status === "fulfilled" ? {
      change_pct:          parseFloat((diffRes.value.difficultyChange ?? 0).toFixed(2)),
      remaining_blocks:    diffRes.value.remainingBlocks,
      estimated_retarget:  diffRes.value.estimatedRetargetDate
        ? new Date(diffRes.value.estimatedRetargetDate * 1000).toISOString() : null,
      network_hashrate_eh: diffRes.value.currentHashrate
        ? parseFloat((diffRes.value.currentHashrate / 1e18).toFixed(2)) : null,
    } : null,
    block_height: heightRes.status === "fulfilled" ? parseInt(heightRes.value.trim()) : null,
  };
}

async function fetchWalletBalance(address) {
  if (!address) throw new Error("No wallet address configured");
  const res = await fetch(`https://mempool.space/api/address/${address}`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`mempool.space ${res.status}`);
  const d = await res.json();
  const received = (d.chain_stats?.funded_txo_sum ?? 0) + (d.mempool_stats?.funded_txo_sum ?? 0);
  const spent    = (d.chain_stats?.spent_txo_sum  ?? 0) + (d.mempool_stats?.spent_txo_sum  ?? 0);
  return {
    address_short: address.slice(0, 10) + "…",
    balance_btc:   parseFloat(((received - spent) / 1e8).toFixed(8)),
    received_btc:  parseFloat((received / 1e8).toFixed(8)),
    tx_count:      (d.chain_stats?.tx_count ?? 0) + (d.mempool_stats?.tx_count ?? 0),
  };
}

// ---------------------------------------------------------------------------
// Hacker News top stories
// ---------------------------------------------------------------------------

async function fetchHackerNews(limit = 5) {
  const res = await fetch(
    `https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=${limit}`,
    { signal: AbortSignal.timeout(8000) }
  );
  if (!res.ok) throw new Error(`HN API ${res.status}`);
  const d = await res.json();
  return (d.hits ?? []).slice(0, limit).map(h => ({
    title:    h.title,
    url:      h.url ?? `https://news.ycombinator.com/item?id=${h.objectID}`,
    points:   h.points,
    comments: h.num_comments,
    author:   h.author,
  }));
}

// ---------------------------------------------------------------------------
// Reddit top posts (configurable subreddits via REDDIT_SUBREDDITS env var)
// ---------------------------------------------------------------------------

async function fetchRedditPosts(postsPerSub = 3) {
  const raw  = process.env.REDDIT_SUBREDDITS ?? "bitcoin,gaming,Bloomington,mildlyinteresting,todayilearned";
  const subs = raw.split(",").map(s => s.trim()).filter(Boolean);

  const results = await Promise.allSettled(
    subs.map(sub =>
      fetch(`https://www.reddit.com/r/${sub}/hot.json?limit=${postsPerSub + 2}`, {
        headers: { "User-Agent": "personal-mcp/1.0 (daily briefing bot)" },
        signal: AbortSignal.timeout(8000),
      }).then(r => r.json())
    )
  );

  const posts = [];
  for (let i = 0; i < subs.length; i++) {
    const r = results[i];
    if (r.status !== "fulfilled") continue;
    const children = r.value?.data?.children ?? [];
    let count = 0;
    for (const c of children) {
      if (count >= postsPerSub) break;
      const p = c.data;
      if (p.stickied || p.pinned) continue;
      posts.push({
        subreddit: p.subreddit,
        title:     p.title.slice(0, 120),
        url:       p.is_self
          ? `https://www.reddit.com${p.permalink}`
          : (p.url ?? `https://www.reddit.com${p.permalink}`),
        score:    p.score,
        comments: p.num_comments,
        flair:    p.link_flair_text ?? null,
      });
      count++;
    }
  }
  return posts;
}

// ---------------------------------------------------------------------------
// This day in history
// ---------------------------------------------------------------------------

async function fetchThisDayInHistory(date = new Date()) {
  const month = date.getMonth() + 1;
  const day   = date.getDate();
  const res = await fetch(
    `https://history.muffinlabs.com/date/${month}/${day}`,
    { headers: { "User-Agent": "personal-mcp/1.0" }, signal: AbortSignal.timeout(8000) }
  );
  if (!res.ok) throw new Error(`History API ${res.status}`);
  const d = await res.json();
  const events = (d.data?.Events ?? [])
    .filter(e => e.links?.length > 0)
    .slice(-6).slice(0, 3)
    .map(e => ({ year: e.year, text: e.text.slice(0, 130) }));
  const births = (d.data?.Births ?? [])
    .filter(b => b.links?.length > 0)
    .slice(-3).slice(0, 2)
    .map(b => ({ year: b.year, text: b.text.slice(0, 80) }));
  return { date: `${month}/${day}`, events, births };
}

// ---------------------------------------------------------------------------
// Word of the day
// ---------------------------------------------------------------------------

// Curated list of interesting vocabulary words — one per day, no external API needed.
// All are real English words confirmed to exist in dictionaryapi.dev.
const WORD_LIST = [
  "ephemeral","eloquent","serendipity","melancholy","luminous","tenacious","ubiquitous",
  "sanguine","perspicacious","laconic","magnanimous","pernicious","sagacious","recalcitrant",
  "insouciant","loquacious","obfuscate","perfidious","alacrity","propitious","vicarious",
  "equanimity","cogent","circumspect","diligent","fastidious","garrulous","impetuous",
  "judicious","languid","meticulous","nonchalant","obdurate","pensive","querulous",
  "reticent","stoic","taciturn","vacuous","wistful","zealous","ambivalent","benevolent",
  "candid","deferential","ebullient","fervent","gregarious","halcyon","idyllic","jovial",
  "kinetic","lucid","mutable","nascent","opulent","palpable","quixotic","resilient",
  "serene","tenuous","uncanny","vivacious","whimsical","xenial","yearning","zeal",
  "acumen","brevity","catharsis","dearth","empathy","fallacy","gravitas","hubris",
  "inertia","juxtapose","karma","leverage","malaise","nuance","ostracize","paradox",
  "qualm","rapport","solace","tangible","umbrage","veracity","wanderlust","xenophobia",
  "yearlong","zenith","abate","bolster","coalesce","diverge","emulate","fortify",
  "glean","hamper","immerse","jeopardize","kindle","lament","mitigate","nurture",
  "obscure","ponder","quell","rejuvenate","scrutinize","thrive","undermine","validate",
  "wane","yield","abolish","beguile","culminate","daunt","elicit","flourish",
  "galvanize","hinder","illuminate","juxtapose","lure","manifest","negate","optimize",
  "pervade","reconcile","stagnate","transcend","unravel","vindicate","wield","yearn",
  "acquiesce","billow","cascade","dwindle","encompass","fracture","glimmer","hollow",
  "intrigue","jostle","kindle","linger","meander","nestle","oscillate","plummet",
  "quiver","ramble","shimmer","tumble","undulate","vanish","wander","yearn",
  "assuage","bliss","clamor","doleful","eerie","fathom","glean","hasten",
  "infer","jolt","knack","lull","muse","nestle","ominous","pique",
  "quirk","revel","simmer","tinge","unfurl","vex","wary","yonder",
  "abyss","brisk","candor","deft","echo","fallow","gust","hush",
  "inkling","juncture","keen","lapse","mellow","nimble","omen","parch",
  "quaint","rustle","somber","tranquil","upbeat","vivid","whirl","yore",
  "abode","bleak","cozy","dreary","earnest","frugal","genial","humble",
  "inane","jaunty","kooky","lively","mellow","nimble","overt","plucky",
  "quirky","rowdy","spry","timid","upbeat","valiant","witty","zany",
];

async function fetchWordOfDay() {
  // Pick deterministically by day of year — no external API for the word
  const doy = Math.floor((Date.now() - new Date(new Date().getFullYear(), 0, 0)) / 86_400_000);

  // Try the day's word, then fall back through the list if definition lookup fails
  for (let offset = 0; offset < 10; offset++) {
    const word = WORD_LIST[(doy + offset) % WORD_LIST.length];
    try {
      const defRes = await fetch(
        `https://api.dictionaryapi.dev/api/v2/entries/en/${word}`,
        { signal: AbortSignal.timeout(8000) }
      );
      if (!defRes.ok) continue;
      const [entry] = await defRes.json();
      const meaning = entry?.meanings?.[0];
      const definition = meaning?.definitions?.[0]?.definition;
      if (!definition) continue;
      return {
        word,
        part_of_speech: meaning.partOfSpeech ?? null,
        definition:     definition.slice(0, 200),
        example:        meaning.definitions[0].example?.slice(0, 150) ?? null,
      };
    } catch { continue; }
  }
  // Last resort: return the word without a definition
  return { word: WORD_LIST[doy % WORD_LIST.length], part_of_speech: null, definition: null, example: null };
}

// ---------------------------------------------------------------------------
// Air quality + pollen (Open-Meteo AQ API, free, no auth)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Fear & Greed Index (alternative.me — free, no auth)
// ---------------------------------------------------------------------------

async function fetchFearAndGreed() {
  const res = await fetch("https://api.alternative.me/fng/?limit=2", {
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Fear & Greed API ${res.status}`);
  const d = await res.json();
  const [today, yesterday] = d.data ?? [];
  return {
    value:          parseInt(today?.value ?? 0),
    label:          today?.value_classification ?? "Unknown",
    yesterday_value: parseInt(yesterday?.value ?? 0),
    yesterday_label: yesterday?.value_classification ?? "Unknown",
  };
}

// ---------------------------------------------------------------------------
// Crypto portfolio — holdings stored in .env, prices from CoinGecko
// ---------------------------------------------------------------------------

// Map ticker → CoinGecko coin ID
const COINGECKO_IDS = {
  BTC:   "bitcoin",
  ETH:   "ethereum",
  SOL:   "solana",
  XRP:   "ripple",
  ADA:   "cardano",
  ALGO:  "algorand",
  SUI:   "sui",
  FLR:   "flare-networks",
  ZBCN:  "zebec-network",
  WMTX:  "world-mobile-token",
  WLFI:  "world-liberty-financial",
  TRUMP: "maga",
  WAL:   "the-wasted-lands",
  XAG:   null, // silver derivatives — price from metals API below
  USD:   null, // stablecoin, always $1
};

async function fetchCryptoPortfolio() {
  const raw = process.env.CRYPTO_HOLDINGS ?? "";
  if (!raw) return null;

  // Parse holdings: "BTC:0.277,ETH:0.11,..."
  const holdings = {};
  for (const part of raw.split(",")) {
    const [ticker, amt] = part.trim().split(":");
    if (ticker && amt) holdings[ticker.toUpperCase()] = parseFloat(amt);
  }
  const silverAmt = parseFloat(process.env.CRYPTO_SILVER_XAG ?? "0");

  // Collect CoinGecko IDs for coins we hold
  const geckoIds = Object.entries(holdings)
    .map(([t]) => COINGECKO_IDS[t])
    .filter(Boolean);

  const uniqueIds = [...new Set(geckoIds)];
  const params = new URLSearchParams({
    ids:                  uniqueIds.join(","),
    vs_currencies:        "usd",
    include_24hr_change:  "true",
    include_market_cap:   "true",   // used to derive btcData without a second call
    include_24hr_vol:     "true",
  });

  const res = await fetch(
    `https://api.coingecko.com/api/v3/simple/price?${params}`,
    { headers: { "User-Agent": "personal-mcp/1.0" }, signal: AbortSignal.timeout(10000) }
  );
  if (!res.ok) throw new Error(`CoinGecko ${res.status}`);
  const prices = await res.json();

  // Silver spot price via metals-api free fallback (frankfurter for USD/XAG)
  let silverUsd = 87; // fallback estimate
  try {
    const sRes = await fetch("https://api.frankfurter.app/latest?from=XAG&to=USD", {
      signal: AbortSignal.timeout(5000),
    });
    if (sRes.ok) {
      const sData = await sRes.json();
      silverUsd = sData?.rates?.USD ?? silverUsd;
    }
  } catch { /* use fallback */ }

  // Build per-coin rows
  const coins = [];
  let totalValue = 0;
  let total24hDelta = 0;

  for (const [ticker, amount] of Object.entries(holdings)) {
    if (amount === 0) continue;
    let priceUsd = 0, change24h = null;

    if (ticker === "USD") {
      priceUsd = 1;
    } else if (ticker === "XAG") {
      // skip here, handled separately
      continue;
    } else {
      const geckoId = COINGECKO_IDS[ticker];
      if (!geckoId || !prices[geckoId]) continue;
      priceUsd  = prices[geckoId].usd ?? 0;
      change24h = prices[geckoId].usd_24h_change ?? null;
    }

    const value = amount * priceUsd;
    totalValue += value;
    if (change24h != null) total24hDelta += value * (change24h / 100);

    coins.push({
      ticker,
      amount,
      price_usd:  parseFloat(priceUsd.toFixed(4)),
      value_usd:  parseFloat(value.toFixed(2)),
      change_24h: change24h != null ? parseFloat(change24h.toFixed(2)) : null,
    });
  }

  // Add silver
  if (silverAmt > 0) {
    const silverValue = silverAmt * silverUsd;
    totalValue += silverValue;
    coins.push({
      ticker: "XAG",
      amount: silverAmt,
      price_usd:  parseFloat(silverUsd.toFixed(2)),
      value_usd:  parseFloat(silverValue.toFixed(2)),
      change_24h: null,
    });
  }

  // Sort by value desc
  coins.sort((a, b) => b.value_usd - a.value_usd);

  const changePct = totalValue > 0 ? (total24hDelta / (totalValue - total24hDelta)) * 100 : 0;

  // Extract BTC-specific market stats so the caller doesn't need a second CoinGecko request
  const btcRaw = prices["bitcoin"];
  const btc_details = btcRaw ? {
    price_usd:      Math.round(btcRaw.usd ?? 0),
    change_24h_pct: parseFloat((btcRaw.usd_24h_change ?? 0).toFixed(2)),
    market_cap_b:   btcRaw.usd_market_cap  ? parseFloat((btcRaw.usd_market_cap  / 1e9).toFixed(1))  : null,
    volume_24h_b:   btcRaw.usd_24h_vol     ? parseFloat((btcRaw.usd_24h_vol     / 1e9).toFixed(2))  : null,
  } : null;

  return {
    total_usd:      parseFloat(totalValue.toFixed(2)),
    change_24h_usd: parseFloat(total24hDelta.toFixed(2)),
    change_24h_pct: parseFloat(changePct.toFixed(2)),
    coins,
    btc_details,
  };
}

// ---------------------------------------------------------------------------
// GitHub public activity
// ---------------------------------------------------------------------------

async function fetchGithubActivity() {
  const username = process.env.GITHUB_USERNAME;
  if (!username) return null;

  const res = await fetch(
    `https://api.github.com/users/${username}/events/public?per_page=50`,
    {
      headers: { "User-Agent": "personal-mcp/1.0", "Accept": "application/vnd.github+json" },
      signal: AbortSignal.timeout(8000),
    }
  );
  if (!res.ok) throw new Error(`GitHub API ${res.status}`);
  const events = await res.json();

  const todayStr = new Date().toISOString().slice(0, 10);
  const todayEvents = events.filter(e => e.created_at?.startsWith(todayStr));

  const counts = { commits: 0, prs: 0, issues: 0, reviews: 0, stars: 0 };
  const repos  = new Set();

  for (const e of todayEvents) {
    repos.add(e.repo?.name ?? "");
    if      (e.type === "PushEvent")                counts.commits  += e.payload?.commits?.length ?? 0;
    else if (e.type === "PullRequestEvent")          counts.prs++;
    else if (e.type === "IssuesEvent")               counts.issues++;
    else if (e.type === "PullRequestReviewEvent")    counts.reviews++;
    else if (e.type === "WatchEvent")                counts.stars++;
  }

  return {
    username,
    events_today:   todayEvents.length,
    commits_today:  counts.commits,
    prs_today:      counts.prs,
    issues_today:   counts.issues,
    reviews_today:  counts.reviews,
    stars_today:    counts.stars,
    repos_touched:  [...repos].filter(Boolean),
  };
}

// ---------------------------------------------------------------------------
// Ryan Hall Y'all — blog RSS feed (severe weather updates & forecasts)
// ---------------------------------------------------------------------------

async function fetchRyanHallBlog(limit = 3) {
  const res = await fetch("https://ryanhallyall.com/blog/rss.xml", {
    headers: { "User-Agent": "personal-mcp/1.0" },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Ryan Hall blog RSS ${res.status}`);
  const xml = await res.text();

  // Parse <item> blocks
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, limit);
  return items.map(m => {
    const block = m[1];
    const get = (tag) => block.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>|<${tag}[^>]*>([^<]*)</${tag}>`))?.[1] ?? block.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`))?.[1] ?? null;
    const title  = block.match(/<title>([^<]+)<\/title>/)?.[1]?.replace(/&#39;/g, "'").replace(/&amp;/g, "&") ?? null;
    const desc   = block.match(/<description>([^<]+)<\/description>/)?.[1]?.replace(/&#39;/g, "'").replace(/&amp;/g, "&") ?? null;
    const link   = block.match(/<link>([^<]+)<\/link>/)?.[1] ?? null;
    const date   = block.match(/<pubDate>([^<]+)<\/pubDate>/)?.[1] ?? null;
    const cats   = [...block.matchAll(/<category>([^<]+)<\/category>/g)].map(c => c[1]).slice(0, 3);
    return { title, description: desc?.slice(0, 200), link, date, categories: cats };
  });
}

// ---------------------------------------------------------------------------
// AirNow real-time RSS feed — Bloomington, IN (Indiana IDEM sensor, no API key)
// Feed: https://feeds.airnowapi.org/rss/realtime/1272.xml
// ---------------------------------------------------------------------------

async function fetchAirNowPollen() {
  const res = await fetch(
    "https://feeds.airnowapi.org/rss/realtime/1272.xml",
    { headers: { "User-Agent": "personal-mcp/1.0" }, signal: AbortSignal.timeout(8000) }
  );
  if (!res.ok) throw new Error(`AirNow RSS ${res.status}`);
  const xml = await res.text();

  // Extract the description block (HTML-encoded inside XML)
  const descMatch = xml.match(/<description>([\s\S]*?)<\/description>/g);
  const desc = descMatch?.[1] ?? ""; // second <description> is the item one
  // Decode HTML entities
  const html = desc.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

  // Parse each pollutant line: "Good  - 20 AQI - Particle Pollution (2.5 microns)"
  const readings = [];
  const lineRe = /([A-Za-z ]+?)\s+-\s+(\d+)\s+AQI\s+-\s+([^\n<]+)/g;
  let match;
  while ((match = lineRe.exec(html)) !== null) {
    readings.push({
      category: match[1].trim(),
      aqi:      parseInt(match[2]),
      pollutant: match[3].trim(),
    });
  }

  // Extract timestamp
  const timeMatch = html.match(/(\d{2}\/\d{2}\/\d{2}\s+\d+:\d+\s+[AP]M\s+\w+)/);
  const updated = timeMatch?.[1] ?? null;

  // Categorise AQI
  const aqiEmoji = (val) => {
    if (val <= 50)  return "🟢";
    if (val <= 100) return "🟡";
    if (val <= 150) return "🟠";
    if (val <= 200) return "🔴";
    return "🟣";
  };

  return {
    location: "Bloomington, IN",
    updated,
    readings: readings.map(r => ({ ...r, emoji: aqiEmoji(r.aqi) })),
    overall_aqi:      readings.length > 0 ? Math.max(...readings.map(r => r.aqi)) : null,
    overall_category: readings.length > 0 ? readings.reduce((a, b) => a.aqi >= b.aqi ? a : b).category : null,
  };
}

const AQI_LABELS = ["Good", "Fair", "Moderate", "Poor", "Very Poor", "Extremely Poor"];

async function fetchAirQuality() {
  const { lat, lon } = BLOOMINGTON;

  // Open-Meteo AQ API: current AQI + particulates (free, no auth)
  // Pollen forecast via Open-Meteo air quality hourly (European model covers US grass/ragweed)
  const aqParams = new URLSearchParams({
    latitude:  lat,
    longitude: lon,
    current:   "us_aqi,pm2_5,pm10,ozone,nitrogen_dioxide",
    hourly:    "us_aqi",
    timezone:  "America/Indiana/Indianapolis",
    forecast_days: "1",
  });

  // AirNow pollen via Open-Meteo forecast — use UV/weather proxy (pollen unavailable for US on free tier)
  // Instead: fetch AQI forecast for today so we can show today's peak AQI
  const res = await fetch(`https://air-quality-api.open-meteo.com/v1/air-quality?${aqParams}`, {
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`AQ API ${res.status}`);
  const d = await res.json();

  const aqi   = d.current?.us_aqi ?? null;
  const pm25  = d.current?.pm2_5  ?? null;
  const pm10  = d.current?.pm10   ?? null;
  const ozone = d.current?.ozone  ?? null;
  const no2   = d.current?.nitrogen_dioxide ?? null;

  // Peak AQI today
  const hourlyAqi = (d.hourly?.us_aqi ?? []).filter(v => v !== null);
  const peakAqi   = hourlyAqi.length > 0 ? Math.max(...hourlyAqi) : null;

  // AQI category label
  const aqiCategory = (val) => {
    if (val === null) return "Unavailable";
    if (val <= 50)   return "Good 🟢";
    if (val <= 100)  return "Moderate 🟡";
    if (val <= 150)  return "Unhealthy for Sensitive Groups 🟠";
    if (val <= 200)  return "Unhealthy 🔴";
    if (val <= 300)  return "Very Unhealthy 🟣";
    return "Hazardous ⚫";
  };

  // Allergy risk advisory based on season + AQI
  const month = new Date().getMonth() + 1; // 1-based
  let allergyNote = null;
  if (month >= 3 && month <= 5)       allergyNote = "🌲 Tree pollen season (Mar–May) — high allergy risk";
  else if (month >= 6 && month <= 8)  allergyNote = "🌾 Grass pollen season (Jun–Aug) — moderate allergy risk";
  else if (month >= 8 && month <= 10) allergyNote = "🌿 Ragweed season (Aug–Oct) — high allergy risk";

  return {
    aqi,
    aqi_label:    aqiCategory(aqi),
    peak_aqi_today: peakAqi,
    peak_aqi_label: aqiCategory(peakAqi),
    pm2_5:        pm25  != null ? parseFloat(pm25.toFixed(1))  : null,
    pm10:         pm10  != null ? parseFloat(pm10.toFixed(1))  : null,
    ozone:        ozone != null ? parseFloat(ozone.toFixed(1)) : null,
    no2:          no2   != null ? parseFloat(no2.toFixed(1))   : null,
    allergy_note: allergyNote,
  };
}

// ---------------------------------------------------------------------------
// NWS severe weather alerts (Bloomington, IN)
// ---------------------------------------------------------------------------

async function fetchNwsAlerts() {
  const res = await fetch(
    `https://api.weather.gov/alerts/active?point=${BLOOMINGTON.lat},${BLOOMINGTON.lon}`,
    {
      headers: { "User-Agent": "personal-mcp/1.0 (coyofroyos@proton.me)" },
      signal: AbortSignal.timeout(8000),
    }
  );
  if (!res.ok) throw new Error(`NWS alerts ${res.status}`);
  const d = await res.json();
  return (d.features ?? []).map(f => ({
    event:       f.properties.event,
    severity:    f.properties.severity,
    urgency:     f.properties.urgency,
    headline:    f.properties.headline?.slice(0, 150) ?? null,
    expires:     f.properties.expires,
  }));
}

// ---------------------------------------------------------------------------
// Standard Notes mood reader
// Reads a note titled "Mood YYYY-MM-DD" from the SN backup folder.
// Format expected (any order, case-insensitive labels):
//   Mood: 4/5
//   Energy: 3/5
//   Anxiety: 2/5
//   Notes: free text...
// ---------------------------------------------------------------------------

async function fetchMoodNote(dateStr = null) {
  const { readFile } = await import("node:fs/promises");
  const target = dateStr ?? new Date().toISOString().slice(0, 10);
  const dir    = process.env.STANDARD_NOTES_BACKUP_PATH;
  if (!dir) return null;

  let files;
  try { files = await readdir(dir, { withFileTypes: true }); } catch { return null; }

  // File names: "{title}-{uuid}_txt" (no extension)
  const titlePrefix = `Mood ${target}`;
  const match = files.find(f => f.isFile() && f.name.startsWith(titlePrefix));
  if (!match) return null;

  const text = await readFile(join(dir, match.name), "utf-8");
  const parse = (label) => {
    const re = new RegExp(`^${label}:\\s*(.+)`, "im");
    return text.match(re)?.[1]?.trim() ?? null;
  };
  return {
    date:    target,
    mood:    parse("mood"),
    energy:  parse("energy"),
    anxiety: parse("anxiety"),
    notes:   parse("notes"),
    raw:     text.slice(0, 500),
  };
}

// ---------------------------------------------------------------------------
// Package delivery email parser (Gmail-based)
// Scans the last 48h of email for shipping notifications from major carriers.
// ---------------------------------------------------------------------------

async function fetchPackageDeliveries(hours = 48) {
  const after = Math.floor((Date.now() - hours * 3_600_000) / 1000);
  const q = encodeURIComponent(
    `(from:ups.com OR from:fedex.com OR from:usps.com OR from:amazon.com OR from:walmart.com OR from:dhl.com OR "tracking number" OR "your package" OR "has shipped" OR "out for delivery") after:${after}`
  );
  const list = await googleGet(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${q}&maxResults=20`);
  const ids  = (list.messages ?? []).map(m => m.id);
  if (ids.length === 0) return [];

  const msgs = await Promise.all(ids.map(id =>
    googleGet(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From,Subject,Date`).catch(() => null)
  ));

  const carrierPatterns = [
    { carrier: "UPS",     re: /UPS.*shipped|Your UPS.*package|UPS.*delivery|1Z[0-9A-Z]{16}/i },
    { carrier: "FedEx",   re: /FedEx.*shipped|FedEx.*delivery|Your.*package.*FedEx/i },
    { carrier: "USPS",    re: /USPS.*shipped|informed delivery|USPS.*package/i },
    { carrier: "Amazon",  re: /Your.*Amazon.*shipped|Amazon.*delivered|Your package was delivered/i },
    { carrier: "Walmart", re: /Walmart.*shipped|Your Walmart.*order/i },
    { carrier: "DHL",     re: /DHL.*shipped|DHL.*delivery/i },
  ];

  const trackingRe = /\b(1Z[0-9A-Z]{16}|[0-9]{12,22}|[A-Z]{2}[0-9]{9}[A-Z]{2})\b/;

  return msgs.filter(Boolean).flatMap(msg => {
    const subject = gmailHeader(msg, "Subject");
    const from    = gmailHeader(msg, "From");
    const date    = gmailHeader(msg, "Date");
    const text    = `${from} ${subject}`;

    const matched = carrierPatterns.filter(({ re }) => re.test(text));
    return matched.map(({ carrier }) => ({
      carrier,
      subject: subject.slice(0, 100),
      from,
      date,
      tracking: trackingRe.exec(subject)?.[1] ?? null,
    }));
  });
}

// ---------------------------------------------------------------------------
// Data snapshot — saved as JSON alongside each daily briefing MD file.
// Enables monthly and yearly summary aggregation with no extra API calls.
// ---------------------------------------------------------------------------

async function saveDataSnapshot(date, snap) {
  const { writeFile, mkdir } = await import("node:fs/promises");
  const dir = join(SN_BACKUP_ROOT, "Daily Briefing");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `snapshot-${date}.json`), JSON.stringify(snap, null, 2), "utf-8");
}

async function loadDataSnapshots(year, month = null) {
  const { readFile } = await import("node:fs/promises");
  const dir = join(SN_BACKUP_ROOT, "Daily Briefing");
  let files;
  try { files = await readdir(dir, { withFileTypes: true }); } catch { return []; }
  const prefix = month != null
    ? `snapshot-${year}-${String(month).padStart(2, "0")}`
    : `snapshot-${year}-`;
  const snaps = [];
  for (const f of files) {
    if (!f.isFile() || !f.name.startsWith(prefix) || !f.name.endsWith(".json")) continue;
    try {
      snaps.push(JSON.parse(await readFile(join(dir, f.name), "utf-8")));
    } catch { /* skip corrupt */ }
  }
  return snaps.sort((a, b) => a.date?.localeCompare(b.date ?? "") ?? 0);
}

// ---------------------------------------------------------------------------
// Monthly summary generator
// ---------------------------------------------------------------------------

async function generateMonthlySummary(year, month) {
  const snaps = await loadDataSnapshots(year, month);
  if (snaps.length === 0) return null;

  const monthName = new Date(year, month - 1, 1).toLocaleDateString("en-US", { month: "long" });
  const avg  = (arr) => arr.length ? parseFloat((arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1)) : null;
  const sum  = (arr) => arr.reduce((a, b) => a + b, 0);
  const max  = (arr) => arr.length ? Math.max(...arr) : null;
  const topN = (map, n = 3) => Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, n);

  // Aggregate
  const steps         = snaps.map(s => s.steps ?? 0).filter(v => v > 0);
  const sleepH        = snaps.map(s => s.sleep_h).filter(Boolean);
  const spotifyCount  = snaps.map(s => s.spotify_track_count ?? 0);
  const artistCounts  = {};
  snaps.forEach(s => { if (s.spotify_top_artist) artistCounts[s.spotify_top_artist] = (artistCounts[s.spotify_top_artist] ?? 0) + 1; });
  const gameCounts    = {};
  snaps.forEach(s => { if (s.steam_top_game) gameCounts[s.steam_top_game] = (gameCounts[s.steam_top_game] ?? 0) + (s.steam_minutes_played ?? 0); });
  const siteCounts    = {};
  snaps.forEach(s => { if (s.vivaldi_top_site) siteCounts[s.vivaldi_top_site] = (siteCounts[s.vivaldi_top_site] ?? 0) + 1; });
  const duoXp         = snaps.map(s => s.duolingo_xp_today ?? 0);
  const duoGoalDays   = snaps.filter(s => s.duolingo_xp_today >= (s.duolingo_xp_goal ?? 50)).length;
  const workouts      = snaps.map(s => s.hevy_workouts ?? 0);
  const photos        = snaps.map(s => s.ente_photos ?? 0);
  const btcPrices     = snaps.map(s => s.btc_price).filter(Boolean);
  const hashrateGh    = snaps.map(s => s.mining_combined_gh).filter(Boolean);
  const receiptsSpent = snaps.map(s => s.receipts_total_usd ?? 0);
  const emails        = snaps.map(s => s.emails_unread ?? 0);

  const lines = [];
  lines.push(`# 📊 Monthly Summary — ${monthName} ${year}`);
  lines.push(`*${snaps.length} days tracked · ${snaps[0].date} → ${snaps[snaps.length - 1].date}*`);
  lines.push("");

  // Health
  if (steps.length > 0) {
    lines.push("## 🏃 Health");
    lines.push(`- **Steps:** ${sum(steps).toLocaleString()} total · avg ${avg(steps).toLocaleString()}/day · best ${max(steps).toLocaleString()}`);
    if (sleepH.length > 0) lines.push(`- **Sleep:** avg ${avg(sleepH)}h/night · best ${max(sleepH)}h`);
    const totalWorkouts = sum(workouts);
    if (totalWorkouts > 0) lines.push(`- **Workouts:** ${totalWorkouts} logged`);
    lines.push("");
  }

  // Entertainment
  lines.push("## 🎵 Music & Gaming");
  if (sum(spotifyCount) > 0) {
    lines.push(`- **Spotify:** ${sum(spotifyCount)} tracks played`);
    const topArtists = topN(artistCounts, 3);
    if (topArtists.length > 0) lines.push(`- **Top artists:** ${topArtists.map(([a, d]) => `${a} (${d} days)`).join(", ")}`);
  }
  const topGames = topN(gameCounts, 3);
  if (topGames.length > 0) lines.push(`- **Top games:** ${topGames.map(([g, m]) => `${g} (${parseFloat((m/60).toFixed(1))}h)`).join(", ")}`);
  lines.push("");

  // Learning & Productivity
  lines.push("## 🦎 Learning");
  lines.push(`- **Duolingo:** ${sum(duoXp)} XP earned · goal met ${duoGoalDays}/${snaps.length} days`);
  const totalPhotos = sum(photos);
  if (totalPhotos > 0) lines.push(`- **Photos:** ${totalPhotos} added to Ente`);
  lines.push(`- **Emails:** avg ${avg(emails)} unread/day`);
  lines.push("");

  // Mining & Bitcoin
  if (hashrateGh.length > 0 || btcPrices.length > 0) {
    lines.push("## ⛏️ Mining & Bitcoin");
    if (hashrateGh.length > 0) lines.push(`- **Avg hashrate:** ${avg(hashrateGh)} GH/s combined`);
    if (btcPrices.length > 1) lines.push(`- **BTC price:** $${btcPrices[0].toLocaleString()} → $${btcPrices[btcPrices.length - 1].toLocaleString()} (${btcPrices[btcPrices.length - 1] > btcPrices[0] ? "📈" : "📉"})`);
    lines.push("");
  }

  // Spending
  const totalSpent = sum(receiptsSpent);
  if (totalSpent > 0) {
    lines.push("## 💳 Spending");
    lines.push(`- **Orders:** $${totalSpent.toFixed(2)} across ${snaps.filter(s => (s.receipts_order_count ?? 0) > 0).length} days`);
    lines.push("");
  }

  // Browsing
  const topSites = topN(siteCounts, 5);
  if (topSites.length > 0) {
    lines.push("## 🌐 Most Visited Sites");
    for (const [site, days] of topSites) lines.push(`- **${site}** — top site on ${days} day${days > 1 ? "s" : ""}`);
    lines.push("");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Yearly summary generator
// ---------------------------------------------------------------------------

async function generateYearlySummary(year) {
  const snaps = await loadDataSnapshots(year);
  if (snaps.length === 0) return null;

  const monthName = (m) => new Date(year, m - 1, 1).toLocaleDateString("en-US", { month: "short" });
  const sum  = (arr) => arr.reduce((a, b) => a + b, 0);
  const avg  = (arr) => arr.length ? parseFloat((arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1)) : 0;

  const lines = [];
  lines.push(`# 🎆 Year in Review — ${year}`);
  lines.push(`*${snaps.length} days tracked*`);
  lines.push("");

  // Month-by-month step table
  const byMonth = {};
  for (const s of snaps) {
    const m = parseInt(s.date?.split("-")[1] ?? 1);
    if (!byMonth[m]) byMonth[m] = [];
    byMonth[m].push(s);
  }

  lines.push("## 📅 Month-by-Month");
  lines.push("| Month | Days | Steps | Sleep | Workouts | Spotify | Games | XP |");
  lines.push("|-------|------|-------|-------|----------|---------|-------|----|");
  for (const [m, ms] of Object.entries(byMonth).sort((a, b) => +a[0] - +b[0])) {
    const steps    = avg(ms.map(s => s.steps ?? 0).filter(v => v > 0));
    const sleep    = avg(ms.map(s => s.sleep_h).filter(Boolean));
    const workouts = sum(ms.map(s => s.hevy_workouts ?? 0));
    const tracks   = sum(ms.map(s => s.spotify_track_count ?? 0));
    const gameMin  = sum(ms.map(s => s.steam_minutes_played ?? 0));
    const xp       = sum(ms.map(s => s.duolingo_xp_today ?? 0));
    lines.push(`| ${monthName(m)} | ${ms.length} | ${steps > 0 ? steps.toLocaleString() : "—"} | ${sleep > 0 ? sleep + "h" : "—"} | ${workouts || "—"} | ${tracks || "—"} | ${gameMin > 0 ? parseFloat((gameMin/60).toFixed(0)) + "h" : "—"} | ${xp || "—"} |`);
  }
  lines.push("");

  // Annual totals
  const totalSteps    = sum(snaps.map(s => s.steps ?? 0));
  const totalTracks   = sum(snaps.map(s => s.spotify_track_count ?? 0));
  const totalWorkouts = sum(snaps.map(s => s.hevy_workouts ?? 0));
  const totalPhotos   = sum(snaps.map(s => s.ente_photos ?? 0));
  const totalXp       = sum(snaps.map(s => s.duolingo_xp_today ?? 0));
  const totalSpent    = sum(snaps.map(s => s.receipts_total_usd ?? 0));
  const topStreak     = Math.max(...snaps.map(s => s.duolingo_streak ?? 0));

  lines.push("## 🏆 Year Totals");
  if (totalSteps > 0)    lines.push(`- 👟 **${totalSteps.toLocaleString()} steps** walked`);
  if (totalTracks > 0)   lines.push(`- 🎵 **${totalTracks.toLocaleString()} songs** played on Spotify`);
  if (totalWorkouts > 0) lines.push(`- 💪 **${totalWorkouts} workouts** logged in Hevy`);
  if (totalPhotos > 0)   lines.push(`- 📸 **${totalPhotos} photos** added to Ente`);
  if (totalXp > 0)       lines.push(`- 🦎 **${totalXp.toLocaleString()} Duolingo XP** earned · best streak: ${topStreak} days`);
  if (totalSpent > 0)    lines.push(`- 💳 **$${totalSpent.toFixed(2)} spent** on orders`);
  lines.push("");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// WisdomBuilder helper
// ---------------------------------------------------------------------------
// Reads the WisdomBuilder personality profiling data from its project folder.
// Returns the master profile plus any session completed today.

async function fetchWisdomBuilder(dateStr) {
  const { readFile } = await import("node:fs/promises");
  const basePath = process.env.WISDOM_BUILDER_PATH
    ?? `C:\\Users\\${process.env.USERNAME}\\Documents\\Claude\\Claude Code\\WisdomBuilder`;

  // Load master profile
  let profile = null;
  try {
    const raw = await readFile(`${basePath}\\profile\\master-profile.json`, "utf-8");
    profile = JSON.parse(raw);
  } catch { return null; }

  // Find any sessions completed today (session files are named session-YYYY-MM-DD-XXXX.json)
  let todaySession = null;
  try {
    const sessionsDir = `${basePath}\\sessions`;
    const files = await readdir(sessionsDir, { withFileTypes: true });
    for (const f of files) {
      if (!f.isFile() || !f.name.includes(dateStr) || !f.name.endsWith(".json")) continue;
      try {
        const raw = await readFile(`${sessionsDir}\\${f.name}`, "utf-8");
        const sess = JSON.parse(raw);
        // Use the latest session if multiple were completed today
        if (!todaySession || (sess.session_number ?? 0) > (todaySession.session_number ?? 0)) {
          todaySession = sess;
        }
      } catch { /* skip corrupt */ }
    }
  } catch { /* sessions dir not found */ }

  return {
    session_today: todaySession !== null,
    session_today_number: todaySession?.session_number ?? null,
    session_today_question_count: todaySession?.question_count ?? null,
    session_today_summary: todaySession?.session_summary ?? null,
    sessions_completed_total: profile.sessions_completed ?? 0,
    questions_answered_total: profile.questions_answered ?? 0,
    derived_type: profile.mbti?.derived_type ?? null,
    mbti_scores: profile.mbti?.scores ?? null,
    big5: {
      openness:          profile.big5_ocean?.openness ?? null,
      conscientiousness: profile.big5_ocean?.conscientiousness ?? null,
      extraversion:      profile.big5_ocean?.extraversion ?? null,
      agreeableness:     profile.big5_ocean?.agreeableness ?? null,
      neuroticism:       profile.big5_ocean?.neuroticism ?? null,
    },
    political_compass: {
      economic: profile.political_compass?.economic ?? null,
      social:   profile.political_compass?.social ?? null,
      label:    profile.political_compass?.quadrant_label ?? null,
    },
    top_values:        profile.values_map?.top_values ?? [],
    notable_patterns:  profile.notable_patterns ?? [],
    last_updated:      profile.last_updated ?? null,
  };
}

// ---------------------------------------------------------------------------
// Google Tasks API
// ---------------------------------------------------------------------------

async function fetchGoogleTasks() {
  const listsRes = await googleGet("https://tasks.googleapis.com/tasks/v1/users/@me/lists?maxResults=20");
  const taskLists = listsRes.items ?? [];
  if (taskLists.length === 0) return { total_tasks: 0, lists: [] };

  const results = await Promise.all(taskLists.map(async (list) => {
    try {
      const tasksRes = await googleGet(
        `https://tasks.googleapis.com/tasks/v1/lists/${list.id}/tasks?showCompleted=false&showDeleted=false&maxResults=100`
      );
      return {
        list:       list.title,
        list_id:    list.id,
        task_count: (tasksRes.items ?? []).length,
        tasks:      (tasksRes.items ?? []).map(t => ({
          id:     t.id,
          title:  t.title,
          status: t.status,
          due:    t.due ?? null,
          notes:  t.notes ? t.notes.slice(0, 200) : null,
        })),
      };
    } catch { return { list: list.title, list_id: list.id, task_count: 0, tasks: [] }; }
  }));

  return {
    total_tasks: results.reduce((s, l) => s + l.task_count, 0),
    lists: results.filter(l => l.task_count > 0),
  };
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOLS = [
  // --- Ente Photos ---
  {
    name: "ente_recent_media",
    description: "List photos and videos added or modified in Ente Photos local sync folder within the last N hours.",
    inputSchema: {
      type: "object",
      properties: {
        hours: { type: "number", description: "How many hours back to look. Default: 24", default: 24 },
      },
    },
  },

  // --- Spotify ---
  {
    name: "spotify_recently_played",
    description: "Get Spotify tracks played recently (up to last 50).",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Number of tracks to return (1-50). Default: 20", default: 20 },
      },
    },
  },
  {
    name: "spotify_currently_playing",
    description: "Get the track currently playing on Spotify, or null if nothing is playing.",
    inputSchema: { type: "object", properties: {} },
  },

  // --- Google Drive ---
  {
    name: "drive_recent_files",
    description: "List recently modified Google Drive files.",
    inputSchema: {
      type: "object",
      properties: {
        hours: { type: "number", description: "How many hours back to look. Default: 24", default: 24 },
        limit: { type: "number", description: "Max results. Default: 20", default: 20 },
      },
    },
  },
  {
    name: "drive_search",
    description: "Search Google Drive files by name.",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string", description: "Filename search keyword" },
      },
    },
  },

  // --- Weather ---
  {
    name: "get_weather",
    description: "Get current weather and 3-day forecast for Bloomington, Indiana.",
    inputSchema: { type: "object", properties: {} },
  },

  // --- Hevy ---
  {
    name: "hevy_workouts",
    description: "Get recent Hevy workouts with exercises, sets, volume, and any personal records.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Number of recent workouts to return. Default: 10." },
      },
    },
  },

  // --- Orders & Transactions (email-parsed) ---
  {
    name: "email_receipts",
    description: "Scan Gmail for any recent order confirmations, shipping notices, receipts, and invoices from any store. Returns parsed fields: store, order number, total, status, delivery estimate.",
    inputSchema: {
      type: "object",
      properties: {
        hours: { type: "number", description: "How many hours back to scan. Default: 72", default: 72 },
      },
    },
  },

  // --- Mining ---
  {
    name: "bitaxe_status",
    description: "Get real-time stats from all local BitAxe miners: hashrate, temperature, power, efficiency, best difficulty.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "braiins_stats",
    description: "Get Braiins pool mining stats for the CoYo account: hashrate, workers, earnings.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "public_pool_stats",
    description: "Get public-pool.io stats for the configured Bitcoin address.",
    inputSchema: { type: "object", properties: {} },
  },

  // --- Google Health ---
  {
    name: "health_day",
    description: "Get Google Health data for a day: steps, calories, active minutes, resting heart rate, and sleep. Requires health-auth.js setup.",
    inputSchema: {
      type: "object",
      properties: {
        date: { type: "string", description: "Date in YYYY-MM-DD format. Defaults to today." },
      },
    },
  },

  // --- Steam ---
  {
    name: "steam_status",
    description: "Get Steam gaming status: currently playing game and recently played games with hours.",
    inputSchema: { type: "object", properties: {} },
  },

  // --- Duolingo ---
  {
    name: "duolingo_status",
    description: "Get current Duolingo streak, XP earned today, and progress across all active language courses.",
    inputSchema: { type: "object", properties: {} },
  },

  // --- Vivaldi ---
  {
    name: "vivaldi_history",
    description: "Get today's Vivaldi browsing history grouped by domain, sorted by visit count.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max domains to return. Default: 20." },
      },
    },
  },

  // --- Bitcoin & Network ---
  {
    name: "btc_data",
    description: "Get current Bitcoin price, 24h change, market cap and volume from CoinGecko.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "mempool_stats",
    description: "Get Bitcoin mempool stats: recommended fee rates, difficulty adjustment countdown, current block height and network hashrate.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "wallet_balance",
    description: "Get BTC balance and total received for the configured mining payout wallet address via mempool.space.",
    inputSchema: { type: "object", properties: {} },
  },

  // --- News & Discovery ---
  {
    name: "hacker_news",
    description: "Get top stories currently on the Hacker News front page.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Number of stories to return. Default: 5." },
      },
    },
  },
  {
    name: "reddit_posts",
    description: "Get top hot posts from configured subreddits (set REDDIT_SUBREDDITS in .env, comma-separated).",
    inputSchema: {
      type: "object",
      properties: {
        posts_per_sub: { type: "number", description: "Posts per subreddit. Default: 3." },
      },
    },
  },
  {
    name: "this_day_in_history",
    description: "Get notable historical events and births that happened on today's date.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "word_of_day",
    description: "Get a word of the day with its definition, part of speech, and example sentence.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "nws_alerts",
    description: "Get active NWS severe weather alerts for Bloomington, Indiana.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "air_quality",
    description: "Get current air quality index (US AQI, PM2.5, PM10, ozone) and daily pollen counts (birch, grass, ragweed, alder) for Bloomington, Indiana.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "mood_note",
    description: "Read today's mood note from Standard Notes (title: 'Mood YYYY-MM-DD'). Returns mood/energy/anxiety scores and any free-text notes.",
    inputSchema: {
      type: "object",
      properties: {
        date: { type: "string", description: "Date in YYYY-MM-DD format. Defaults to today." },
      },
    },
  },
  {
    name: "package_deliveries",
    description: "Scan Gmail for shipping notifications from UPS, FedEx, USPS, Amazon, Walmart, and DHL in the last 48 hours.",
    inputSchema: {
      type: "object",
      properties: {
        hours: { type: "number", description: "Hours of email to scan. Default: 48." },
      },
    },
  },

  {
    name: "fear_and_greed",
    description: "Get the current Bitcoin Fear & Greed Index value and label (0=Extreme Fear, 100=Extreme Greed).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "crypto_portfolio",
    description: "Get live crypto portfolio value across all holdings (BTC, ETH, SOL, XRP, ADA, etc.) with 24h change.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "github_activity",
    description: "Get today's GitHub activity for the configured user: commits, PRs, issues, and repos touched.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "airnow_pollen",
    description: "Get today's AirNow air quality forecast for Bloomington, IN — ozone, PM2.5, and PM10 AQI categories.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "spotify_recommendations",
    description: "Get personalized song recommendations based on current weather, time of day, mood, workout status, and recently played tracks.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "ryan_hall_blog",
    description: "Get the latest posts from Ryan Hall Y'all's weather blog — severe weather updates, forecasts, and storm recaps.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Number of posts to return. Default: 3." },
      },
    },
  },

  // --- PC Hardware ---
  {
    name: "pc_hardware",
    description: "Get real-time PC hardware stats: GPU utilization/temp/VRAM (via nvidia-smi), CPU load %, CPU name, and RAM usage.",
    inputSchema: { type: "object", properties: {} },
  },

  // --- Windows Activity History ---
  {
    name: "activity_history",
    description: "Get today's Windows Activity History — time spent per app/program. Requires Activity History enabled in Windows Settings → Privacy → Activity history.",
    inputSchema: {
      type: "object",
      properties: {
        hours: { type: "number", description: "Hours to look back. Default: 24." },
        limit: { type: "number", description: "Max apps to return. Default: 15." },
      },
    },
  },

  // --- Vivaldi Notes ---
  {
    name: "vivaldi_notes",
    description: "Read notes from Vivaldi browser's built-in Notes panel.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max notes to return. Default: 20." },
      },
    },
  },

  // --- Summaries ---
  {
    name: "monthly_summary",
    description: "Generate a monthly summary from saved daily snapshots. Shows health trends, top games, top artists, Duolingo progress, mining stats, and spending.",
    inputSchema: {
      type: "object",
      required: ["year", "month"],
      properties: {
        year:  { type: "number", description: "Year (e.g. 2026)" },
        month: { type: "number", description: "Month 1-12" },
      },
    },
  },
  {
    name: "yearly_summary",
    description: "Generate a year-in-review from saved daily snapshots with month-by-month breakdown and annual totals.",
    inputSchema: {
      type: "object",
      required: ["year"],
      properties: {
        year: { type: "number", description: "Year (e.g. 2026)" },
      },
    },
  },

  // --- Daily Briefing ---
  {
    name: "daily_briefing",
    description:
      "Get a complete daily briefing: today's calendar events plus unread emails from the last 24 hours. Use this as the starting point each morning.",
    inputSchema: {
      type: "object",
      properties: {
        date: {
          type: "string",
          description: "Date to brief for, ISO 8601 (e.g. 2026-05-13). Defaults to today.",
        },
      },
    },
  },

  // --- Gmail ---
  {
    name: "gmail_messages",
    description: "Search Gmail messages. Returns sender, subject, date, snippet, and label IDs. Uses Gmail search syntax (e.g. 'is:unread from:boss@company.com', 'subject:invoice newer_than:7d').",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Gmail search query. Default: recent inbox messages.", default: "in:inbox" },
        limit: { type: "number", description: "Max messages to return (1–50). Default: 20", default: 20 },
      },
    },
  },
  {
    name: "gmail_get_message",
    description: "Get the full body of a Gmail message by its ID.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", description: "Message ID from gmail_messages" },
      },
    },
  },
  {
    name: "gmail_labels",
    description: "List all Gmail labels (folders). Useful for understanding how the inbox is organized.",
    inputSchema: { type: "object", properties: {} },
  },

  // --- Google Calendar ---
  {
    name: "google_calendar_events",
    description: "List Google Calendar events in a date range across all calendars.",
    inputSchema: {
      type: "object",
      required: ["start", "end"],
      properties: {
        start: { type: "string", description: "Start date/time ISO 8601 (e.g. 2026-05-18T00:00:00)" },
        end:   { type: "string", description: "End date/time ISO 8601 (e.g. 2026-05-18T23:59:59)" },
      },
    },
  },

  // --- Google Tasks ---
  {
    name: "google_tasks",
    description: "List all Google Tasks across all task lists. Returns incomplete tasks only.",
    inputSchema: { type: "object", properties: {} },
  },

  // --- Standard Notes ---
  {
    name: "sn_list_notes",
    description: "List all Standard Notes notes (titles and UUIDs only).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "sn_search_notes",
    description: "Search Standard Notes notes by keyword in title or body.",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string", description: "Search keyword" },
      },
    },
  },
  {
    name: "sn_get_note",
    description: "Get the full content of a Standard Notes note by its UUID.",
    inputSchema: {
      type: "object",
      required: ["uuid"],
      properties: {
        uuid: { type: "string", description: "Note UUID from sn_list_notes or sn_search_notes" },
      },
    },
  },
  {
    name: "sn_create_note",
    description: "Create a new Standard Notes note.",
    inputSchema: {
      type: "object",
      required: ["title", "text"],
      properties: {
        title: { type: "string", description: "Note title" },
        text: { type: "string", description: "Note body (plain text or Markdown)" },
      },
    },
  },
  {
    name: "end_of_day_data",
    description: "Collects all end-of-day data as structured JSON for AI analysis. Runs all relevant data sources in parallel — health, fitness, gaming, music, workouts, Duolingo, browsing, app usage, hardware, notes, email, calendar, mining, crypto, GitHub, mood, air quality, fear/greed. Intentionally excludes weather, fun content (jokes/quotes/facts), package deliveries, NWS alerts, and Ryan Hall blog — none of these reflect the quality of the day. Also saves an enhanced daily snapshot for monthly and yearly rollups. Call this at 11:50 PM each night to get the structured data for your nightly analysis.",
    inputSchema: {
      type: "object",
      properties: {
        date: { type: "string", description: "Date to collect data for (YYYY-MM-DD). Defaults to today." },
      },
    },
  },
  {
    name: "weekly_summary",
    description: "Returns structured JSON of the last 7 daily snapshots for weekly review analysis. Includes daily breakdowns plus totals and averages across the week — steps, sleep, workouts, gaming, music, Duolingo, GitHub commits, crypto portfolio change, spending, top apps, top games, top artists. Returns raw data so Claude can write the actual analysis. Call this on Sunday nights after end_of_day_data has run.",
    inputSchema: {
      type: "object",
      properties: {
        end_date: { type: "string", description: "Last day of the week (YYYY-MM-DD). Defaults to today. Returns the 7 days ending on this date." },
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

async function handleTool(name, args) {
  switch (name) {
    case "btc_data":            return JSON.stringify(await fetchBtcData(), null, 2);
    case "mempool_stats":       return JSON.stringify(await fetchMempoolStats(), null, 2);
    case "wallet_balance":      return JSON.stringify(await fetchWalletBalance(process.env.PUBLIC_POOL_ADDRESS), null, 2);
    case "hacker_news":         return JSON.stringify(await fetchHackerNews(args.limit ?? 5), null, 2);
    case "reddit_posts":        return JSON.stringify(await fetchRedditPosts(args.posts_per_sub ?? 3), null, 2);
    case "this_day_in_history": return JSON.stringify(await fetchThisDayInHistory(), null, 2);
    case "word_of_day":         return JSON.stringify(await fetchWordOfDay(), null, 2);
    case "nws_alerts":          return JSON.stringify(await fetchNwsAlerts(), null, 2);
    case "air_quality":         return JSON.stringify(await fetchAirQuality(), null, 2);
    case "fear_and_greed":      return JSON.stringify(await fetchFearAndGreed(), null, 2);
    case "crypto_portfolio":    return JSON.stringify(await fetchCryptoPortfolio(), null, 2);
    case "github_activity":     return JSON.stringify(await fetchGithubActivity(), null, 2);
    case "airnow_pollen":       return JSON.stringify(await fetchAirNowPollen(), null, 2);
    case "spotify_recommendations": return JSON.stringify(await fetchSpotifyRecommendations(), null, 2);
    case "ryan_hall_blog":      return JSON.stringify(await fetchRyanHallBlog(args.limit ?? 3), null, 2);
    case "mood_note":           return JSON.stringify(await fetchMoodNote(args.date ?? null), null, 2);
    case "package_deliveries":  return JSON.stringify(await fetchPackageDeliveries(args.hours ?? 48), null, 2);

    case "pc_hardware":
      return JSON.stringify(await fetchPcHardware(), null, 2);

    case "activity_history": {
      const since = new Date(Date.now() - (args.hours ?? 24) * 3_600_000);
      return JSON.stringify(await fetchActivityHistory(since, args.limit ?? 15), null, 2);
    }

    case "vivaldi_notes":
      return JSON.stringify(await fetchVivaldiNotes(args.limit ?? 20), null, 2);

    case "monthly_summary": {
      const result = await generateMonthlySummary(args.year, args.month);
      return result ?? `No snapshot data found for ${args.year}-${String(args.month).padStart(2,"0")}. Daily briefings need to run first to accumulate snapshots.`;
    }

    case "yearly_summary": {
      const result = await generateYearlySummary(args.year);
      return result ?? `No snapshot data found for ${args.year}.`;
    }

    case "hevy_workouts": {
      const since = new Date(); since.setDate(since.getDate() - 7);
      return JSON.stringify(await fetchHevyWorkouts({ since, limit: args.limit ?? 10 }), null, 2);
    }

    case "email_receipts": {
      return JSON.stringify(await fetchAllReceipts(args.hours ?? 72), null, 2);
    }

    case "bitaxe_status": {
      return JSON.stringify(await fetchAllBitaxe(), null, 2);
    }

    case "braiins_stats": {
      return JSON.stringify(await fetchBraiinsStats(), null, 2);
    }

    case "public_pool_stats": {
      return JSON.stringify(await fetchPublicPoolStats(), null, 2);
    }

    case "health_day": {
      const date = args.date ?? new Date().toLocaleDateString("en-CA", { timeZone: "America/Indiana/Indianapolis" });
      return JSON.stringify(await fetchHealthDay(date), null, 2);
    }

    case "steam_status": {
      return JSON.stringify(await fetchSteamData(), null, 2);
    }

    case "duolingo_status": {
      return JSON.stringify(await fetchDuolingo(), null, 2);
    }

    case "vivaldi_history": {
      const since = new Date(); since.setHours(0, 0, 0, 0);
      return JSON.stringify(await fetchVivaldiHistory(since, args.limit ?? 20), null, 2);
    }

    case "ente_recent_media": {
      const since = new Date(Date.now() - (args.hours ?? 24) * 60 * 60 * 1000);
      return JSON.stringify(await enteRecentMedia(since), null, 2);
    }

    case "spotify_recently_played": {
      return JSON.stringify(await spotifyRecentlyPlayed(Math.min(args.limit ?? 20, 50)), null, 2);
    }

    case "spotify_currently_playing": {
      return JSON.stringify(await spotifyCurrentlyPlaying(), null, 2);
    }

    case "drive_recent_files": {
      const since = new Date(Date.now() - (args.hours ?? 24) * 60 * 60 * 1000);
      return JSON.stringify(await fetchGoogleDriveRecent(since, args.limit ?? 20), null, 2);
    }

    case "drive_search": {
      return JSON.stringify(await searchGoogleDrive(args.query), null, 2);
    }

    case "get_weather": {
      return JSON.stringify(await fetchWeather(), null, 2);
    }

    case "daily_briefing": {
      // Parse date as local noon so Indiana timezone always shows the correct day
      // (bare "YYYY-MM-DD" strings are treated as UTC midnight by the JS engine)
      const targetDate = args.date ? new Date(args.date + "T12:00:00") : new Date();
      const dayStart = new Date(targetDate);
      dayStart.setHours(0, 0, 0, 0);
      const dayEnd = new Date(targetDate);
      dayEnd.setHours(23, 59, 59, 999);

      // Wrap each call with a per-source timeout so a slow service never
      // hangs the whole briefing. Each source gets 12 s; failures return a
      // safe fallback value so the rest of the briefing still renders.
      // Resolves to fallback if the promise rejects OR times out — a single
      // failing source never crashes the whole briefing Promise.all.
      const withTimeout = (promise, ms, fallback) => Promise.race([
        promise.catch(() => fallback),
        new Promise(resolve => setTimeout(() => resolve(fallback), ms)),
      ]);

      const todayStr = targetDate.toLocaleDateString("en-CA", { timeZone: "America/Indiana/Indianapolis" });

      const moonPhase = getMoonPhase(targetDate);

      const [events, unread, recentNotes, weather, driveFiles, enteMedia, spotifyTracks, nowPlaying,
             health, steam, duolingo, vivaldiHistory, miners, braiins, publicPool,
             dailyFact, dailyJoke, dailyQuote, hevyWorkouts, receipts,
             mempoolStats, walletBalance, hnStories, redditPosts,
             historyToday, wordOfDay, nwsAlerts, moodNote, packages, airQuality,
             fearAndGreed, cryptoPortfolio, githubActivity, airNowPollen, ryanHallPosts,
             pcHardware, activityHistory, vivaldiNotes] = await Promise.all([
        withTimeout(fetchGoogleCalendarEvents(dayStart, dayEnd),        12000, []),
        withTimeout(fetchGmailUnread(24),                               12000, []),
        withTimeout(snGetRecentNotes(dayStart),                         12000, []),
        withTimeout(fetchWeather(),                                     12000, { current: { condition:"Unavailable", temperature_f:"?", feels_like_f:"?", humidity_pct:"?", wind_mph:"?" }, forecast: [], today_sunrise: null, today_sunset: null }),
        withTimeout(fetchGoogleDriveRecent(dayStart, 20),               12000, []),
        withTimeout(enteRecentMedia(dayStart),                          12000, []),
        withTimeout(spotifyRecentlyPlayed(50).catch(()=>[]),            12000, []),
        withTimeout(spotifyCurrentlyPlaying().catch(()=>null),          12000, null),
        withTimeout(fetchHealthDay(todayStr).catch(()=>null),           12000, null),
        withTimeout(fetchSteamData().catch(()=>null),                   12000, null),
        withTimeout(fetchDuolingo().catch(()=>null),                    12000, null),
        withTimeout(fetchVivaldiHistory(dayStart, 20).catch(()=>null),  12000, null),
        withTimeout(fetchAllBitaxe().catch(()=>[]),                     12000, []),
        withTimeout(fetchBraiinsStats().catch(()=>null),                12000, null),
        withTimeout(fetchPublicPoolStats().catch(()=>null),             12000, null),
        withTimeout(fetchDailyFact().catch(()=>null),                   8000,  null),
        withTimeout(fetchDailyJoke().catch(()=>null),                   8000,  null),
        withTimeout(fetchDailyQuote().catch(()=>null),                  8000,  null),
        withTimeout(fetchHevyWorkouts({ since: dayStart }).catch(()=>[]),12000, []),
        withTimeout(fetchAllReceipts(72).catch(()=>[]),                 12000, []),
        withTimeout(fetchMempoolStats().catch(()=>null),                10000, null),
        withTimeout(fetchWalletBalance(process.env.PUBLIC_POOL_ADDRESS).catch(()=>null), 10000, null),
        withTimeout(fetchHackerNews(5).catch(()=>[]),                   10000, []),
        withTimeout(fetchRedditPosts(3).catch(()=>[]),                  12000, []),
        withTimeout(fetchThisDayInHistory(targetDate).catch(()=>null),  8000,  null),
        withTimeout(fetchWordOfDay().catch(()=>null),                   10000, null),
        withTimeout(fetchNwsAlerts().catch(()=>[]),                     8000,  []),
        withTimeout(fetchMoodNote(todayStr).catch(()=>null),            6000,  null),
        withTimeout(fetchPackageDeliveries(48).catch(()=>[]),           12000, []),
        withTimeout(fetchAirQuality().catch(()=>null),                  8000,  null),
        withTimeout(fetchFearAndGreed().catch(()=>null),                8000,  null),
        withTimeout(fetchCryptoPortfolio().catch(()=>null),             12000, null),
        withTimeout(fetchGithubActivity().catch(()=>null),              8000,  null),
        withTimeout(fetchAirNowPollen().catch(()=>null),                8000,  null),
        withTimeout(fetchRyanHallBlog(3).catch(()=>[]),                 8000,  []),
        withTimeout(fetchPcHardware().catch(()=>null),                  12000, null),
        withTimeout(fetchActivityHistory(dayStart, 15).catch(()=>null), 12000, null),
        withTimeout(fetchVivaldiNotes(20).catch(()=>null),              8000,  null),
      ]);

      // Derive BTC data from portfolio — avoids a second simultaneous CoinGecko call
      const btcData = cryptoPortfolio?.btc_details ?? null;

      // ── Phase 2: Spotify recommendations using full context ──────────────────
      const spotifyRecs = await withTimeout(
        fetchSpotifyRecommendations({ weather, mood: moodNote, health, steam, hevyWorkouts }).catch(() => null),
        12000, null
      );

      const todaySpotify = spotifyTracks.filter((t) => new Date(t.played_at) >= dayStart);

      // Helper: format time from ISO string
      const fmtTime = (iso) => new Date(iso).toLocaleTimeString("en-US", {
        hour: "numeric", minute: "2-digit", hour12: true,
        timeZone: "America/Indiana/Indianapolis"
      });
      const fmtDate = (iso) => new Date(iso).toLocaleDateString("en-US", {
        month: "short", day: "numeric", timeZone: "America/Indiana/Indianapolis"
      });

      const lines = [];

      // ── Header ──────────────────────────────────────────────────────────────
      const dayName = targetDate.toLocaleDateString("en-US", { weekday: "long", timeZone: "America/Indiana/Indianapolis" });
      const fullDate = targetDate.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "America/Indiana/Indianapolis" });
      lines.push(`# 📋 Daily Briefing`);
      lines.push(`### ${dayName}, ${fullDate} — Bloomington, IN`);
      lines.push("");

      // ── Weather ─────────────────────────────────────────────────────────────
      const w = weather.current;
      const WEATHER_EMOJI = { "Clear sky": "☀️", "Mainly clear": "🌤️", "Partly cloudy": "⛅", "Overcast": "☁️",
        "Foggy": "🌫️", "Light drizzle": "🌦️", "Moderate drizzle": "🌧️", "Dense drizzle": "🌧️",
        "Slight rain": "🌧️", "Moderate rain": "🌧️", "Heavy rain": "⛈️",
        "Slight snow": "🌨️", "Moderate snow": "❄️", "Heavy snow": "❄️",
        "Slight showers": "🌦️", "Moderate showers": "🌧️", "Violent showers": "⛈️",
        "Thunderstorm": "⛈️", "Thunderstorm with hail": "⛈️" };
      const wEmoji = WEATHER_EMOJI[w.condition] ?? "🌡️";
      lines.push(`## ${wEmoji} Weather  ${moonPhase.emoji} ${moonPhase.phase}`);

      // NWS alerts — show prominently at top of weather if any
      if (nwsAlerts.length > 0) {
        for (const a of nwsAlerts) {
          lines.push(`> ⚠️ **${a.event}** (${a.severity}) — ${a.headline ?? ""}`);
        }
        lines.push("");
      }

      const sunriseFmt = weather.today_sunrise ? fmtTime(weather.today_sunrise) : null;
      const sunsetFmt  = weather.today_sunset  ? fmtTime(weather.today_sunset)  : null;
      const sunLine = [
        `**${w.condition}** · ${w.temperature_f}°F (feels ${w.feels_like_f}°F) · 💨 ${w.wind_mph} mph · 💧 ${w.humidity_pct}%`,
        sunriseFmt && sunsetFmt ? `🌅 ${sunriseFmt} · 🌇 ${sunsetFmt}` : null,
      ].filter(Boolean).join("  \n");
      lines.push(sunLine);
      lines.push("");
      lines.push("| Day | Condition | High | Low | Rain | UV |");
      lines.push("|-----|-----------|------|-----|------|----|");
      for (const day of weather.forecast) {
        const emoji = WEATHER_EMOJI[day.condition] ?? "🌡️";
        const rain  = day.precip_chance_pct > 0 ? `${day.precip_chance_pct}%` : "—";
        const uv    = day.uv_index_max != null ? day.uv_index_max : "—";
        lines.push(`| ${fmtDate(day.date + "T12:00:00")} | ${emoji} ${day.condition} | ${day.high_f}°F | ${day.low_f}°F | ${rain} | ${uv} |`);
      }
      lines.push("");

      // ── Air quality + pollen ──────────────────────────────────────────────
      if (airQuality || airNowPollen) {
        lines.push("### 🌬️ Air Quality & Pollen");
        if (airQuality) {
          const aqParts = [`**AQI ${airQuality.aqi ?? "?"}** — ${airQuality.aqi_label}`];
          if (airQuality.peak_aqi_today != null && airQuality.peak_aqi_today !== airQuality.aqi)
            aqParts.push(`Peak today: ${airQuality.peak_aqi_today} (${airQuality.peak_aqi_label})`);
          if (airQuality.pm2_5 != null) aqParts.push(`PM2.5: ${airQuality.pm2_5} µg/m³`);
          if (airQuality.pm10  != null) aqParts.push(`PM10: ${airQuality.pm10} µg/m³`);
          lines.push(aqParts.join(" · "));
        }
        if (airNowPollen?.readings?.length > 0) {
          const parts = airNowPollen.readings.map(r => `${r.emoji} **${r.aqi}** ${r.category} — ${r.pollutant}`);
          lines.push(`*Indiana IDEM sensor* · ${parts.join(" · ")}`);
        }
        if (airQuality?.allergy_note) lines.push(`> ${airQuality.allergy_note}`);
        lines.push("");
      }

      // ── Ryan Hall Y'all ───────────────────────────────────────────────────
      if (ryanHallPosts.length > 0) {
        lines.push("## 🌪️ Ryan Hall Y'all");
        for (const p of ryanHallPosts) {
          const age = p.date ? (() => {
            const diff = Date.now() - new Date(p.date).getTime();
            const h = Math.round(diff / 3600000);
            return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
          })() : "";
          lines.push(`- **${p.title}** ${age ? `*(${age})*` : ""}`);
          if (p.description) lines.push(`  ${p.description}`);
        }
        lines.push("");
      }

      // ── Calendar ─────────────────────────────────────────────────────────────
      lines.push(`## 📅 Calendar`);
      if (events.length === 0) {
        lines.push("*No events scheduled today*");
      } else {
        for (const e of events) {
          const time = e.start ? `${fmtTime(e.start)}${e.end ? ` – ${fmtTime(e.end)}` : ""}` : "All day";
          lines.push(`- **${e.summary}** · ${time}${e.location ? ` · 📍 ${e.location}` : ""}`);
          if (e.description) lines.push(`  *${e.description.trim().slice(0, 120)}*`);
        }
      }
      lines.push("");

      // ── Email ────────────────────────────────────────────────────────────────
      lines.push(`## 📬 Email — ${unread.length} unread`);
      if (unread.length === 0) {
        lines.push("*Inbox zero! 🎉*");
      } else {
        for (const m of unread.slice(0, 15)) {
          lines.push(`- **${m.subject}**`);
          lines.push(`  *from ${m.from} · ${fmtTime(m.date)}*`);
        }
        if (unread.length > 15) lines.push(`  *…and ${unread.length - 15} more*`);
      }
      lines.push("");

      // ── Package deliveries ────────────────────────────────────────────────
      if (packages.length > 0) {
        lines.push("## 📦 Packages");
        const statusEmoji = { "Delivered": "✅", "Out for delivery": "🚚", "Shipped": "📫" };
        for (const p of packages) {
          const emoji = statusEmoji[p.status] ?? "📦";
          const tracking = p.tracking ? ` · \`${p.tracking}\`` : "";
          lines.push(`- ${emoji} **${p.carrier}** — ${p.status}${tracking}`);
          lines.push(`  *${p.subject}*`);
        }
        lines.push("");
      }

      // ── Mood ──────────────────────────────────────────────────────────────
      if (moodNote) {
        lines.push("## 😊 Mood");
        const parts = [];
        if (moodNote.mood)    parts.push(`Mood **${moodNote.mood}**`);
        if (moodNote.energy)  parts.push(`Energy **${moodNote.energy}**`);
        if (moodNote.anxiety) parts.push(`Anxiety **${moodNote.anxiety}**`);
        if (parts.length > 0) lines.push(parts.join(" · "));
        if (moodNote.notes)   lines.push(`> ${moodNote.notes}`);
        lines.push("");
        lines.push(`*To update: create a Standard Notes note titled "Mood ${todayStr}" with fields Mood, Energy, Anxiety, Notes*`);
        lines.push("");
      } else {
        lines.push("## 😊 Mood");
        lines.push(`*No mood note for today. Create a Standard Notes note titled "Mood ${todayStr}" with lines like:*`);
        lines.push("*Mood: 4/5 · Energy: 3/5 · Anxiety: 2/5 · Notes: ...*");
        lines.push("");
      }

      // ── Standard Notes ────────────────────────────────────────────────────
      lines.push(`## 📝 Notes`);
      if (recentNotes.length === 0) {
        lines.push("*No notes modified today*");
      } else {
        for (const n of recentNotes) {
          lines.push(`- **${n.title}** · *${n.notebook}* · ${fmtTime(n.modified)}`);
        }
      }
      lines.push("");

      // ── Spotify ──────────────────────────────────────────────────────────────
      lines.push(`## 🎵 Spotify`);
      if (nowPlaying) {
        lines.push(`**▶ Now playing:** ${nowPlaying.track} — ${nowPlaying.artist}`);
        lines.push("");
      }
      if (todaySpotify.length === 0) {
        lines.push("*No tracks played today*");
      } else {
        lines.push(`**${todaySpotify.length} tracks played today:**`);
        // Group consecutive same-track plays
        const deduped = [];
        for (const t of todaySpotify) {
          const last = deduped[deduped.length - 1];
          if (last && last.track === t.track && last.artist === t.artist) {
            last.count++;
          } else {
            deduped.push({ ...t, count: 1 });
          }
        }
        for (const t of deduped.slice(0, 10)) {
          const repeat = t.count > 1 ? ` ×${t.count}` : "";
          lines.push(`- **${t.track}**${repeat} — ${t.artist} · *${fmtTime(t.played_at)}*`);
        }
      }
      lines.push("");

      // ── Spotify Recommendations ───────────────────────────────────────────
      if (spotifyRecs?.tracks?.length > 0) {
        const ctx = spotifyRecs.context;
        const vibe = ctx.reasons.length > 0 ? `*${ctx.reasons.join(", ")}*` : "";
        lines.push(`## 🎧 Recommended For Right Now`);
        if (vibe) lines.push(vibe);
        lines.push("");
        for (const t of spotifyRecs.tracks) {
          lines.push(`- **${t.name}** — ${t.artist}`);
        }
        lines.push("");
      }

      // ── Ente Photos ───────────────────────────────────────────────────────
      lines.push(`## 📸 Ente Photos`);
      if (enteMedia.length === 0) {
        lines.push("*No photos or videos added today*");
      } else {
        // Group by album
        const byAlbum = {};
        for (const m of enteMedia) {
          (byAlbum[m.album] ??= []).push(m);
        }
        for (const [album, items] of Object.entries(byAlbum)) {
          const label = album === ".." ? "Unsorted" : album;
          const videos = items.filter((i) => i.file.match(/\.(mp4|mov|avi|mkv)$/i)).length;
          const photos = items.length - videos;
          const parts = [];
          if (photos) parts.push(`${photos} photo${photos > 1 ? "s" : ""}`);
          if (videos) parts.push(`${videos} video${videos > 1 ? "s" : ""}`);
          lines.push(`- **${label}** · ${parts.join(", ")}`);
        }
      }
      lines.push("");

      // ── Google Drive ──────────────────────────────────────────────────────
      lines.push(`## ☁️ Google Drive`);
      if (driveFiles.length === 0) {
        lines.push("*No files modified today*");
      } else {
        for (const f of driveFiles) {
          const kb = f.size_bytes ? (f.size_bytes / 1024).toFixed(0) + " KB · " : "";
          lines.push(`- **${f.name}** · ${kb}${fmtTime(f.modified)}`);
        }
      }

      // ── Mining ───────────────────────────────────────────────────────────
      lines.push("");
      lines.push("## ⛏️ Mining");

      // BitAxe local miners
      if (miners.length === 0) {
        lines.push("*No BitAxe miners configured*");
      } else {
        for (const m of miners) {
          if (m.error) {
            lines.push(`- **${m.ip}** — ⚠️ ${m.error}`);
          } else {
            const eff = m.efficiency_j_th ? ` · ${m.efficiency_j_th} J/TH` : "";
            const temp = m.temp_c ? ` · 🌡️ ${m.temp_c}°C` : "";
            const power = m.power_w ? ` · ⚡ ${m.power_w}W` : "";
            lines.push(`- **${m.hostname}** (${m.model}) · **${m.hashrate_gh} GH/s**${temp}${power}${eff}`);
            if (m.best_diff) lines.push(`  Best diff: ${m.best_diff} · Uptime: ${m.uptime_h}h · Shares: ${m.shares_accepted} accepted / ${m.shares_rejected} rejected`);
          }
        }
      }

      // Braiins pool
      lines.push("");
      lines.push("**Braiins Pool**");
      if (!braiins) {
        lines.push("*Unavailable*");
      } else {
        lines.push(`Workers: ${braiins.workers_ok ?? "?"}/${braiins.workers_total ?? "?"} online`);
        if (braiins.hash_rate_5m)  lines.push(`Hashrate: ${braiins.hash_rate_5m} (5m) / ${braiins.hash_rate_60m} (1h) / ${braiins.hash_rate_24h} (24h)`);
        if (braiins.unconfirmed_btc != null) lines.push(`Pending: ${braiins.unconfirmed_btc} BTC · Confirmed: ${braiins.confirmed_btc} BTC`);
        if (braiins.all_time_btc != null) lines.push(`All-time earned: ${braiins.all_time_btc} BTC`);
      }

      // Public Pool (lottery miner)
      lines.push("");
      lines.push("**Public Pool (Lottery)**");
      if (!publicPool) {
        lines.push("*Unavailable*");
      } else {
        lines.push(`Workers: ${publicPool.workers} · Hashrate: ${publicPool.hashrate_gh} GH/s`);
        if (publicPool.best_difficulty) lines.push(`Best difficulty: ${publicPool.best_difficulty}`);
        if (publicPool.blocks_found != null) lines.push(`🎰 Blocks found: ${publicPool.blocks_found}`);
      }

      // ── Google Health ─────────────────────────────────────────────────────
      lines.push("");
      lines.push("## 🏃 Health");
      if (!health) {
        lines.push("*Health data unavailable — check credentials or run health-auth.js*");
      } else {
        const slp = health.sleep;
        lines.push(`**${health.steps.toLocaleString()} steps** · 🔥 ${health.calories_burned.toLocaleString()} cal · ⚡ ${health.active_minutes} active min`);
        if (health.resting_hr) lines.push(`💓 Resting HR: **${health.resting_hr} bpm**`);
        if (slp) lines.push(`😴 Sleep: **${slp.duration_h}h** (${fmtTime(slp.start)} – ${fmtTime(slp.end)})`);
      }

      // ── Steam ─────────────────────────────────────────────────────────────
      lines.push("");
      lines.push("## 🎮 Steam");
      if (!steam) {
        lines.push("*Steam data unavailable — check STEAM_API_KEY and STEAM_ID in .env*");
      } else {
        if (steam.currently_playing) {
          lines.push(`▶ **Currently playing: ${steam.currently_playing.name}**`);
          lines.push("");
        }
        if (steam.recently_played.length === 0) {
          lines.push("*No games played in the last 2 weeks*");
        } else {
          lines.push("**Recent games (last 2 weeks):**");
          for (const g of steam.recently_played) {
            lines.push(`- **${g.name}** · ${g.playtime_2weeks_h}h recently · ${g.playtime_total_h}h total`);
          }
        }
        if (steam.achievements_today?.length > 0) {
          lines.push("");
          lines.push("🏆 **Achievements unlocked today:**");
          for (const a of steam.achievements_today) {
            lines.push(`- **${a.name}** *(${a.game})* — ${a.description ?? ""}`);
          }
        }
      }

      // ── Duolingo ──────────────────────────────────────────────────────────
      lines.push("");
      lines.push("## 🦎 Duolingo");
      if (!duolingo) {
        lines.push("*Duolingo data unavailable*");
      } else {
        const streakEmoji = duolingo.streak_active ? "🔥" : "❄️";
        lines.push(`${streakEmoji} **${duolingo.streak} day streak** · ${duolingo.xp_today} / ${duolingo.xp_goal} XP today${duolingo.streak_active ? " ✅" : " — goal not yet met"}`);
        for (const c of duolingo.courses.slice(0, 3)) {
          lines.push(`- **${c.language}** · Level ${c.level} · ${c.xp.toLocaleString()} XP · ${c.crowns} crowns`);
        }
      }

      // ── Vivaldi browsing ──────────────────────────────────────────────────
      lines.push("");
      lines.push("## 🌐 Vivaldi");
      if (!vivaldiHistory || vivaldiHistory.total_visits === 0) {
        lines.push("*No browsing recorded today*");
      } else {
        lines.push(`**${vivaldiHistory.total_visits} visits today** — top sites:`);
        for (const d of vivaldiHistory.top_domains.slice(0, 8)) {
          lines.push(`- **${d.domain}** · ${d.visits}×`);
        }
      }

      // ── Windows Activity History ──────────────────────────────────────────
      if (activityHistory?.apps?.length > 0) {
        lines.push("");
        lines.push("## 🖥️ App Usage Today");
        const totalMin = activityHistory.apps.reduce((s, a) => s + a.duration_min, 0);
        lines.push(`*${Math.round(totalMin)} min tracked across ${activityHistory.apps.length} apps*`);
        for (const a of activityHistory.apps.slice(0, 8)) {
          const h = Math.floor(a.duration_min / 60);
          const m = Math.round(a.duration_min % 60);
          const dur = h > 0 ? `${h}h ${m}m` : `${m}m`;
          lines.push(`- **${a.app}** · ${dur}`);
        }
      }

      // ── PC Hardware ───────────────────────────────────────────────────────
      lines.push("");
      lines.push("## 💻 System");
      if (!pcHardware || (!pcHardware.gpus && !pcHardware.cpu && !pcHardware.ram)) {
        lines.push("*Hardware stats unavailable*");
      } else {
        if (pcHardware.cpu) {
          const cpuLabel = pcHardware.cpu.name
            ? `${pcHardware.cpu.name} — **${pcHardware.cpu.load_pct}%** load`
            : `CPU: **${pcHardware.cpu.load_pct}%** load`;
          lines.push(cpuLabel);
        }
        if (pcHardware.ram) {
          const used = (pcHardware.ram.total_gb - pcHardware.ram.free_gb).toFixed(1);
          lines.push(`RAM: **${pcHardware.ram.used_pct}%** used · ${used} / ${pcHardware.ram.total_gb} GB`);
        }
        if (pcHardware.gpus?.length > 0) {
          for (const gpu of pcHardware.gpus) {
            const parts = [`**${gpu.name}**`];
            if (gpu.gpu_utilization_pct != null) parts.push(`GPU ${gpu.gpu_utilization_pct}%`);
            if (gpu.temperature_c != null)        parts.push(`🌡️ ${gpu.temperature_c}°C`);
            if (gpu.vram_used_mb != null && gpu.vram_total_mb != null)
              parts.push(`VRAM ${gpu.vram_used_mb}/${gpu.vram_total_mb} MB`);
            if (gpu.power_w != null)              parts.push(`⚡ ${gpu.power_w}W`);
            lines.push(parts.join(" · "));
          }
        }
      }

      // ── Vivaldi Notes ─────────────────────────────────────────────────────
      if (vivaldiNotes?.total > 0) {
        lines.push("");
        lines.push("## 🗒️ Vivaldi Notes");
        lines.push(`*${vivaldiNotes.total} notes total — most recent:*`);
        for (const n of vivaldiNotes.notes.slice(0, 5)) {
          const dateStr = n.added_at ? fmtDate(n.added_at) : "";
          const folderTag = (n.folder && n.folder !== "Notes" && n.folder !== "Other Notes") ? ` *(${n.folder})*` : "";
          lines.push(`- **${n.title}**${folderTag}${dateStr ? ` · ${dateStr}` : ""}`);
          if (n.content && n.content.trim()) {
            lines.push(`  ${n.content.trim().slice(0, 120)}${n.content.length > 120 ? "…" : ""}`);
          }
        }
      }

      // ── Hevy workouts ─────────────────────────────────────────────────────
      lines.push("");
      lines.push("## 💪 Hevy");
      if (!hevyWorkouts || hevyWorkouts.length === 0) {
        lines.push("*No workouts logged today*");
      } else {
        for (const w of hevyWorkouts) {
          const dur  = w.duration_min ? ` · ${w.duration_min} min` : "";
          const vol  = w.volume_lbs   ? ` · ${w.volume_lbs.toLocaleString()} lbs volume` : "";
          lines.push(`- **${w.title}**${dur} · ${w.exercises} exercises · ${w.total_sets} sets${vol}`);
          if (w.prs.length > 0) lines.push(`  🏆 PRs: ${w.prs.join(", ")}`);
        }
      }

      // ── Orders & Transactions ─────────────────────────────────────────────
      const orders      = receipts.filter(r => r.type === "order");
      const transactions = receipts.filter(r => r.type === "transaction");

      if (orders.length > 0) {
        lines.push("");
        lines.push("## 📦 Recent Orders");
        for (const o of orders) {
          const orderNum = o.order ? ` #${o.order}` : "";
          const status   = o.status   ? ` — ${o.status}` : "";
          const arrive   = o.arriving ? ` · 📬 ${o.arriving}` : "";
          const total    = o.total    ? ` · **${o.total}**` : "";
          lines.push(`- **${o.store}**${orderNum}${total}${status}${arrive}`);
          lines.push(`  *${o.subject.slice(0, 80)}*`);
        }
      }

      if (transactions.length > 0) {
        lines.push("");
        lines.push("## 🏦 Transactions");
        for (const t of transactions) {
          const acct  = t.account_last4 ? ` (···${t.account_last4})` : "";
          const total = t.total ? ` · **${t.total}**` : "";
          const type  = t.txn_type ? ` — ${t.txn_type}` : "";
          lines.push(`- **${t.store}**${acct}${total}${type}`);
          lines.push(`  *${t.subject.slice(0, 80)}*`);
        }
      }

      // ── Bitcoin & Network ─────────────────────────────────────────────────
      lines.push("");
      lines.push("## ₿ Bitcoin");
      if (btcData) {
        const arrow  = btcData.change_24h_pct >= 0 ? "📈" : "📉";
        const change = btcData.change_24h_pct >= 0 ? `+${btcData.change_24h_pct}%` : `${btcData.change_24h_pct}%`;
        lines.push(`**$${btcData.price_usd.toLocaleString()}** ${arrow} ${change} 24h · Market cap: $${btcData.market_cap_b}B · Vol: $${btcData.volume_24h_b}B`);
      } else {
        lines.push("*Price unavailable*");
      }
      if (mempoolStats) {
        const f = mempoolStats.fees;
        const d = mempoolStats.difficulty;
        if (f) lines.push(`⛽ Fees: **${f.fastest_sat_vb}** / ${f.halfhour_sat_vb} / ${f.hour_sat_vb} sat/vB (fast/30m/1h)`);
        if (d) {
          const retarget = d.estimated_retarget ? fmtDate(d.estimated_retarget) : "?";
          const changeSign = d.change_pct >= 0 ? "+" : "";
          const netHash = d.network_hashrate_eh != null ? `${d.network_hashrate_eh} EH/s` : "N/A";
          lines.push(`🔧 Difficulty adj: **${changeSign}${d.change_pct}%** · ${d.remaining_blocks} blocks (~${retarget}) · Network: ${netHash}`);
        }
        if (mempoolStats.block_height) lines.push(`📦 Block height: **${mempoolStats.block_height.toLocaleString()}**`);
      }
      if (walletBalance) {
        lines.push(`💰 Payout wallet: **${walletBalance.balance_btc} BTC** balance · ${walletBalance.received_btc} BTC total received`);
      }
      if (fearAndGreed) {
        const fgEmoji = fearAndGreed.value <= 25 ? "😱" : fearAndGreed.value <= 45 ? "😟" : fearAndGreed.value <= 55 ? "😐" : fearAndGreed.value <= 75 ? "😊" : "🤑";
        const trend = fearAndGreed.value > fearAndGreed.yesterday_value ? "↑" : fearAndGreed.value < fearAndGreed.yesterday_value ? "↓" : "→";
        lines.push(`${fgEmoji} Fear & Greed: **${fearAndGreed.value}** — ${fearAndGreed.label} ${trend} (was ${fearAndGreed.yesterday_value} yesterday)`);
      }
      lines.push("");

      // ── Crypto Portfolio ──────────────────────────────────────────────────
      if (cryptoPortfolio) {
        lines.push("## 💎 Crypto Portfolio");
        const arrow  = cryptoPortfolio.change_24h_pct >= 0 ? "📈" : "📉";
        const chgPct = cryptoPortfolio.change_24h_pct >= 0 ? `+${cryptoPortfolio.change_24h_pct}%` : `${cryptoPortfolio.change_24h_pct}%`;
        const chgUsd = cryptoPortfolio.change_24h_usd >= 0 ? `+$${cryptoPortfolio.change_24h_usd.toLocaleString()}` : `-$${Math.abs(cryptoPortfolio.change_24h_usd).toLocaleString()}`;
        lines.push(`**Total: $${cryptoPortfolio.total_usd.toLocaleString()}** ${arrow} ${chgPct} (${chgUsd}) 24h`);
        lines.push("");
        lines.push("| Coin | Holdings | Price | Value | 24h |");
        lines.push("|------|----------|-------|-------|-----|");
        for (const c of cryptoPortfolio.coins) {
          const chg = c.change_24h != null ? `${c.change_24h >= 0 ? "+" : ""}${c.change_24h}%` : "—";
          const price = c.price_usd >= 1 ? `$${c.price_usd.toLocaleString()}` : `$${c.price_usd}`;
          lines.push(`| **${c.ticker}** | ${c.amount} | ${price} | $${c.value_usd.toLocaleString()} | ${chg} |`);
        }
        lines.push("");
      }

      // ── GitHub ────────────────────────────────────────────────────────────
      if (githubActivity) {
        lines.push("## 🐙 GitHub");
        if (githubActivity.events_today === 0) {
          lines.push("*No GitHub activity today*");
        } else {
          const parts = [];
          if (githubActivity.commits_today > 0) parts.push(`**${githubActivity.commits_today}** commit${githubActivity.commits_today !== 1 ? "s" : ""}`);
          if (githubActivity.prs_today     > 0) parts.push(`**${githubActivity.prs_today}** PR${githubActivity.prs_today !== 1 ? "s" : ""}`);
          if (githubActivity.issues_today  > 0) parts.push(`**${githubActivity.issues_today}** issue${githubActivity.issues_today !== 1 ? "s" : ""}`);
          if (githubActivity.reviews_today > 0) parts.push(`**${githubActivity.reviews_today}** review${githubActivity.reviews_today !== 1 ? "s" : ""}`);
          if (githubActivity.stars_today   > 0) parts.push(`**${githubActivity.stars_today}** star${githubActivity.stars_today !== 1 ? "s" : ""}`);
          lines.push(parts.length > 0 ? parts.join(" · ") : `${githubActivity.events_today} events`);
          if (githubActivity.repos_touched.length > 0) {
            lines.push(`Repos: ${githubActivity.repos_touched.slice(0, 5).join(", ")}`);
          }
        }
        lines.push("");
      }

      // ── News: Hacker News ─────────────────────────────────────────────────
      if (hnStories.length > 0) {
        lines.push("");
        lines.push("## 🔶 Hacker News");
        for (const s of hnStories) {
          lines.push(`- **${s.title}** · ${s.points} pts · ${s.comments} comments`);
        }
      }

      // ── News: Reddit ──────────────────────────────────────────────────────
      if (redditPosts.length > 0) {
        lines.push("");
        lines.push("## 🔴 Reddit");
        const bySub = {};
        for (const p of redditPosts) (bySub[p.subreddit] ??= []).push(p);
        for (const [sub, posts] of Object.entries(bySub)) {
          lines.push(`**r/${sub}**`);
          for (const p of posts) {
            lines.push(`- ${p.title}${p.flair ? ` *(${p.flair})*` : ""} · ⬆️ ${p.score.toLocaleString()}`);
          }
        }
      }

      // ── Daily fun content ─────────────────────────────────────────────────
      lines.push("");
      lines.push("---");
      lines.push("## 🎲 Today's Picks");

      if (dailyQuote) {
        lines.push(`> *"${dailyQuote.quote}"*`);
        lines.push(`> — **${dailyQuote.author}**`);
        lines.push("");
      }

      if (wordOfDay?.definition) {
        lines.push(`**📖 Word of the Day: ${wordOfDay.word}**${wordOfDay.part_of_speech ? ` *(${wordOfDay.part_of_speech})*` : ""}`);
        lines.push(wordOfDay.definition);
        if (wordOfDay.example) lines.push(`*"${wordOfDay.example}"*`);
        lines.push("");
      }

      if (historyToday?.events?.length > 0) {
        lines.push(`**📜 This Day in History (${historyToday.date})**`);
        for (const e of historyToday.events) lines.push(`- **${e.year}** — ${e.text}`);
        if (historyToday.births?.length > 0) {
          lines.push(`*Notable births: ${historyToday.births.map(b => b.text).join(" · ")}*`);
        }
        lines.push("");
      }

      if (dailyFact) {
        lines.push(`**🤓 Fact of the Day**`);
        lines.push(dailyFact);
        lines.push("");
      }

      if (dailyJoke) {
        lines.push(`**😄 Joke of the Day**`);
        lines.push(dailyJoke.setup);
        lines.push(`||${dailyJoke.punchline}||`);
      }

      // ── Claude's journal entry ────────────────────────────────────────────
      lines.push("");
      lines.push("---");
      lines.push("## 📓 Journal Entry");
      const commentary = generateDayCommentary({
        date: targetDate, weather, moonPhase, events, unread,
        spotifyTracks: todaySpotify, enteMedia, driveFiles, nowPlaying,
        health, steam, duolingo, vivaldiHistory, hevyWorkouts,
        miners, btcData, receipts, recentNotes,
      });
      lines.push(commentary);

      // ── Standard Notes save + JSON snapshot ──────────────────────────────
      const briefingTitle = `Daily Briefing — ${fullDate}`;
      const briefingText  = lines.join("\n");

      // Save snapshot JSON for monthly/yearly summaries
      const snap = {
        date:                  todayStr,
        steps:                 health?.steps ?? 0,
        calories_burned:       health?.calories_burned ?? 0,
        active_minutes:        health?.active_minutes ?? 0,
        sleep_h:               health?.sleep?.duration_h ?? null,
        resting_hr:            health?.resting_hr ?? null,
        spotify_track_count:   todaySpotify.length,
        spotify_top_artist:    [...new Set(todaySpotify.map(t => t.artist?.split(",")[0].trim()).filter(Boolean))][0] ?? null,
        emails_unread:         unread.length,
        calendar_events:       events.length,
        ente_photos:           enteMedia.length,
        drive_files_modified:  driveFiles.length,
        hevy_workouts:         hevyWorkouts.length,
        hevy_volume_lbs:       hevyWorkouts.reduce((s, w) => s + (w.volume_lbs ?? 0), 0),
        duolingo_xp_today:     duolingo?.xp_today ?? 0,
        duolingo_xp_goal:      duolingo?.xp_goal  ?? 50,
        duolingo_streak:       duolingo?.streak    ?? 0,
        steam_minutes_played:  steam?.recently_played?.reduce((s, g) => s + Math.round(g.playtime_2weeks_h * 60), 0) ?? 0,
        steam_top_game:        steam?.recently_played?.[0]?.name ?? null,
        vivaldi_visits:        vivaldiHistory?.total_visits ?? 0,
        vivaldi_top_site:      vivaldiHistory?.top_domains?.[0]?.domain ?? null,
        mining_combined_gh:    miners?.filter(m => !m.error).reduce((s, m) => s + m.hashrate_gh, 0) ?? 0,
        btc_price:             btcData?.price_usd ?? null,
        receipts_order_count:  receipts.filter(r => r.type === "order").length,
        receipts_total_usd:    receipts.filter(r => r.type === "order" && r.total)
                                 .reduce((s, r) => s + parseFloat(r.total.replace(/[$,]/g, "") || 0), 0),
        moon_phase:            moonPhase.phase,
        weather_condition:     weather.current?.condition ?? null,
        weather_high_f:        weather.forecast?.[0]?.high_f ?? null,
        weather_low_f:         weather.forecast?.[0]?.low_f  ?? null,
        notes_created:         recentNotes.length,
      };
      try { await saveDataSnapshot(todayStr, snap); } catch { /* non-fatal */ }

      // Save MD to SN backup folder
      try {
        await snCreateNote(briefingTitle, briefingText, "Daily Briefing");
        lines.push("");
        lines.push("---");
        lines.push("## 📥 Save to Standard Notes");
        lines.push(`Saved to **Standard Notes Backup → Daily Briefing** as **"${briefingTitle}"**.`);
        lines.push("*(Go to Preferences → Backups → Import Backup to sync into the app)*");
      } catch (e) {
        lines.push("");
        lines.push(`> ⚠️ Could not save to Standard Notes: ${e.message}`);
      }

      return lines.join("\n");
    }

    case "gmail_messages": {
      return JSON.stringify(await fetchGmailMessages(args.query ?? "in:inbox", args.limit ?? 20), null, 2);
    }
    case "gmail_get_message": {
      return JSON.stringify(await fetchGmailMessageBody(args.id), null, 2);
    }
    case "gmail_labels": {
      return JSON.stringify(await fetchGmailLabels(), null, 2);
    }

    case "google_calendar_events": {
      const events = await fetchGoogleCalendarEvents(new Date(args.start), new Date(args.end));
      return JSON.stringify(events, null, 2);
    }

    case "google_tasks": {
      return JSON.stringify(await fetchGoogleTasks(), null, 2);
    }

    case "sn_list_notes": {
      const notes = await snGetAllNotes();
      return JSON.stringify(
        notes.map((n) => ({ id: n.id, title: n.title, notebook: n.notebook, modified: n.modified })),
        null, 2
      );
    }

    case "sn_search_notes": {
      const notes = await snGetAllNotes();
      const q = args.query.toLowerCase();
      // Search by title first (fast), then by content if needed
      const titleMatches = notes.filter((n) => n.title.toLowerCase().includes(q));
      const contentMatches = [];
      if (titleMatches.length < 5) {
        for (const n of notes) {
          if (titleMatches.find((m) => m.id === n.id)) continue;
          try {
            const text = await snReadNote(n.path);
            if (text.toLowerCase().includes(q)) contentMatches.push({ ...n, preview: text.slice(0, 200) });
          } catch { /* skip */ }
        }
      }
      return JSON.stringify(
        [...titleMatches, ...contentMatches].map((n) => ({
          id: n.id, title: n.title, notebook: n.notebook, preview: n.preview,
        })),
        null, 2
      );
    }

    case "sn_get_note": {
      const notes = await snGetAllNotes();
      const note = notes.find((n) => n.id === args.uuid || n.title.toLowerCase() === args.uuid.toLowerCase());
      if (!note) throw new Error(`Note not found: ${args.uuid}`);
      const text = await snReadNote(note.path);
      return JSON.stringify({ ...note, text }, null, 2);
    }

    case "sn_create_note": {
      return JSON.stringify(await snCreateNote(args.title, args.text), null, 2);
    }

    case "end_of_day_data": {
      const targetDate = args.date ? new Date(args.date + "T12:00:00") : new Date();
      const dayStart = new Date(targetDate);
      dayStart.setHours(0, 0, 0, 0);
      const dayEnd = new Date(targetDate);
      dayEnd.setHours(23, 59, 59, 999);

      const withTimeout = (promise, ms, fallback) => Promise.race([
        promise.catch(() => fallback),
        new Promise(resolve => setTimeout(() => resolve(fallback), ms)),
      ]);

      const todayStr = targetDate.toLocaleDateString("en-CA", { timeZone: "America/Indiana/Indianapolis" });

      // Parallel fetch all relevant sources — intentionally excludes weather, fun content,
      // packages, NWS alerts, Ryan Hall, Spotify recommendations (forward-looking).
      const [
        events, unread, recentNotes, spotifyTracks, nowPlaying,
        health, steam, duolingo, vivaldiHistory, miners, braiins, publicPool,
        hevyWorkouts, receipts, mempoolStats, walletBalance,
        moodNote, airQuality, fearAndGreed, cryptoPortfolio, githubActivity,
        pcHardware, activityHistory, vivaldiNotes, wisdomBuilder,
      ] = await Promise.all([
        withTimeout(fetchGoogleCalendarEvents(dayStart, dayEnd),         12000, []),
        withTimeout(fetchGmailUnread(24),                                12000, []),
        withTimeout(snGetRecentNotes(dayStart),                          12000, []),
        withTimeout(spotifyRecentlyPlayed(50).catch(() => []),           12000, []),
        withTimeout(spotifyCurrentlyPlaying().catch(() => null),         12000, null),
        withTimeout(fetchHealthDay(todayStr).catch(() => null),          12000, null),
        withTimeout(fetchSteamData().catch(() => null),                  12000, null),
        withTimeout(fetchDuolingo().catch(() => null),                   12000, null),
        withTimeout(fetchVivaldiHistory(dayStart, 30).catch(() => null), 12000, null),
        withTimeout(fetchAllBitaxe().catch(() => []),                    12000, []),
        withTimeout(fetchBraiinsStats().catch(() => null),               12000, null),
        withTimeout(fetchPublicPoolStats().catch(() => null),            12000, null),
        withTimeout(fetchHevyWorkouts({ since: dayStart }).catch(() => []), 12000, []),
        withTimeout(fetchAllReceipts(72).catch(() => []),                12000, []),
        withTimeout(fetchMempoolStats().catch(() => null),               10000, null),
        withTimeout(fetchWalletBalance(process.env.PUBLIC_POOL_ADDRESS).catch(() => null), 10000, null),
        withTimeout(fetchMoodNote(todayStr).catch(() => null),           6000,  null),
        withTimeout(fetchAirQuality().catch(() => null),                 8000,  null),
        withTimeout(fetchFearAndGreed().catch(() => null),               8000,  null),
        withTimeout(fetchCryptoPortfolio().catch(() => null),            12000, null),
        withTimeout(fetchGithubActivity().catch(() => null),             8000,  null),
        withTimeout(fetchPcHardware().catch(() => null),                 12000, null),
        withTimeout(fetchActivityHistory(dayStart, 20).catch(() => null),12000, null),
        withTimeout(fetchVivaldiNotes(20).catch(() => null),             8000,  null),
        withTimeout(fetchWisdomBuilder(todayStr).catch(() => null),      5000,  null),
      ]);

      // Derive BTC details from portfolio to avoid a separate CoinGecko call
      const btcData = cryptoPortfolio?.btc_details ?? null;

      // Filter Spotify to today only
      const todaySpotify = spotifyTracks.filter((t) => new Date(t.played_at) >= dayStart);

      // Compute derived / enhanced snapshot fields
      const cryptoTotalUsd   = cryptoPortfolio?.total_value_usd ?? null;
      const btcChange24h     = btcData?.price_change_24h_pct ?? null;
      const fearGreedValue   = typeof fearAndGreed?.value === "number" ? fearAndGreed.value : null;
      const githubCommits    = (githubActivity?.events ?? [])
        .filter(e => e.type === "PushEvent")
        .reduce((s, e) => s + (e.commits ?? 1), 0);
      const githubReposActive = [...new Set(
        (githubActivity?.events ?? []).map(e => e.repo).filter(Boolean)
      )].length;
      const activityTopApp   = activityHistory?.apps?.[0]?.app ?? null;
      const activityTotalMin = parseFloat(
        (activityHistory?.apps?.reduce((s, a) => s + (a.duration_min ?? 0), 0) ?? 0).toFixed(1)
      );
      const workoutVolume    = parseFloat(hevyWorkouts.reduce((s, w) => s + (w.volume_lbs ?? 0), 0).toFixed(1));
      const ordersCount      = receipts.filter(r => r.type === "order").length;
      const ordersTotal      = parseFloat(
        receipts.filter(r => r.type === "order" && r.total)
          .reduce((s, r) => s + parseFloat(r.total.replace(/[$,]/g, "") || 0), 0).toFixed(2)
      );

      // Save enhanced snapshot (backwards-compatible with existing monthly/yearly generators)
      const snap = {
        date:                 todayStr,
        steps:                health?.steps ?? 0,
        calories_burned:      health?.calories_burned ?? 0,
        active_minutes:       health?.active_minutes ?? 0,
        sleep_h:              health?.sleep?.duration_h ?? null,
        resting_hr:           health?.resting_hr ?? null,
        hevy_workouts:        hevyWorkouts.length,
        hevy_volume_lbs:      workoutVolume,
        spotify_track_count:  todaySpotify.length,
        spotify_top_artist:   [...new Set(todaySpotify.map(t => t.artist?.split(",")[0].trim()).filter(Boolean))][0] ?? null,
        steam_minutes_played: steam?.recently_played?.reduce((s, g) => s + Math.round(g.playtime_2weeks_h * 60), 0) ?? 0,
        steam_top_game:       steam?.recently_played?.[0]?.name ?? null,
        duolingo_xp_today:    duolingo?.xp_today ?? 0,
        duolingo_xp_goal:     duolingo?.xp_goal  ?? 50,
        duolingo_streak:      duolingo?.streak    ?? 0,
        vivaldi_visits:       vivaldiHistory?.total_visits ?? 0,
        vivaldi_top_site:     vivaldiHistory?.top_domains?.[0]?.domain ?? null,
        emails_unread:        unread.length,
        calendar_events:      events.length,
        notes_created:        recentNotes.length,
        mining_combined_gh:   miners?.filter(m => !m.error).reduce((s, m) => s + m.hashrate_gh, 0) ?? 0,
        btc_price:            btcData?.price_usd ?? null,
        receipts_order_count: ordersCount,
        receipts_total_usd:   ordersTotal,
        ente_photos:          0,
        drive_files_modified: 0,
        moon_phase:           getMoonPhase(targetDate).phase,
        wisdom_session_today: wisdomBuilder?.session_today ?? false,
        // Enhanced fields
        crypto_total_usd:     cryptoTotalUsd,
        crypto_btc_change_24h: btcChange24h,
        fear_greed_value:     fearGreedValue,
        github_commits:       githubCommits,
        github_repos_active:  githubReposActive,
        activity_top_app:     activityTopApp,
        activity_total_min:   activityTotalMin,
        pc_gpu_temp_c:        pcHardware?.gpus?.[0]?.temperature_c ?? null,
        pc_cpu_load_pct:      pcHardware?.cpu?.load_pct ?? null,
      };
      try { await saveDataSnapshot(todayStr, snap); } catch { /* non-fatal */ }

      // Return fully structured JSON for Claude to analyze
      const result = {
        date: todayStr,
        snapshot_saved: true,
        health: health ?? null,
        fitness: {
          workouts: hevyWorkouts,
          workout_count: hevyWorkouts.length,
          total_volume_lbs: workoutVolume,
        },
        music: {
          tracks_today: todaySpotify,
          track_count: todaySpotify.length,
          currently_playing: nowPlaying,
          top_artists: [...new Set(todaySpotify.map(t => t.artist?.split(",")[0].trim()).filter(Boolean))].slice(0, 5),
        },
        gaming: steam ?? null,
        learning: { duolingo: duolingo ?? null },
        mood: moodNote ?? null,
        browsing: {
          history: vivaldiHistory ?? null,
          notes: vivaldiNotes ?? null,
        },
        app_usage: activityHistory ?? null,
        email: {
          unread_count: unread.length,
          recent_unread: unread.slice(0, 10),
        },
        calendar: {
          events: events,
          event_count: events.length,
        },
        notes: {
          created_today: recentNotes,
          count: recentNotes.length,
        },
        mining: {
          bitaxe: miners,
          braiins: braiins,
          public_pool: publicPool,
          wallet: walletBalance,
        },
        crypto: {
          portfolio: cryptoPortfolio,
          mempool: mempoolStats,
          btc: btcData,
        },
        finance: {
          receipts: receipts,
          order_count: ordersCount,
          order_total_usd: ordersTotal,
        },
        hardware: pcHardware ?? null,
        github: githubActivity ?? null,
        air_quality: airQuality ?? null,
        fear_and_greed: fearAndGreed ?? null,
        wisdom: wisdomBuilder ?? null,
      };

      return JSON.stringify(result, null, 2);
    }

    case "weekly_summary": {
      const endDate = args.end_date ? new Date(args.end_date + "T12:00:00") : new Date();
      const endDateStr = endDate.toLocaleDateString("en-CA", { timeZone: "America/Indiana/Indianapolis" });
      const year = endDate.getFullYear();

      // Load snapshots from this year (and previous year if we're in the first week of January)
      let allSnaps = await loadDataSnapshots(year);
      if (endDate.getMonth() === 0 && endDate.getDate() <= 7) {
        const prevSnaps = await loadDataSnapshots(year - 1);
        allSnaps = [...prevSnaps, ...allSnaps];
      }

      // Keep only the 7 most recent days up to end_date
      const snaps = allSnaps.filter(s => s.date <= endDateStr).slice(-7);

      if (snaps.length === 0) {
        return JSON.stringify({
          error: "No snapshot data found. Run end_of_day_data at least once first.",
          looked_in_year: year,
          end_date: endDateStr,
        }, null, 2);
      }

      // Compute ISO week number for the end date
      const isoWeek = (() => {
        const d = new Date(endDateStr + "T12:00:00");
        d.setDate(d.getDate() + 4 - (d.getDay() || 7));
        const yearStart = new Date(d.getFullYear(), 0, 1);
        return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
      })();

      const numVals  = (field) => snaps.map(s => s[field]).filter(v => v != null && v > 0);
      const allVals  = (field) => snaps.map(s => s[field] ?? 0);
      const sum      = (arr) => arr.reduce((a, b) => a + b, 0);
      const avg      = (arr) => arr.length ? parseFloat((sum(arr) / arr.length).toFixed(1)) : null;

      const topEntries = (field, valueField = null) => {
        const map = {};
        snaps.forEach(s => {
          const key = s[field];
          if (!key) return;
          const val = valueField ? (s[valueField] ?? 1) : 1;
          map[key] = (map[key] ?? 0) + val;
        });
        return Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, 5)
          .map(([name, total]) => ({ name, total }));
      };

      const result = {
        week: `${year}-W${String(isoWeek).padStart(2, "0")}`,
        days_tracked: snaps.length,
        date_range: { start: snaps[0].date, end: snaps[snaps.length - 1].date },
        daily_snapshots: snaps,
        totals: {
          steps:               sum(allVals("steps")),
          active_minutes:      sum(allVals("active_minutes")),
          workouts:            sum(allVals("hevy_workouts")),
          workout_volume_lbs:  parseFloat(sum(allVals("hevy_volume_lbs")).toFixed(1)),
          spotify_tracks:      sum(allVals("spotify_track_count")),
          steam_minutes:       sum(allVals("steam_minutes_played")),
          duolingo_xp:         sum(allVals("duolingo_xp_today")),
          duolingo_goal_days:  snaps.filter(s => (s.duolingo_xp_today ?? 0) >= (s.duolingo_xp_goal ?? 50)).length,
          notes_created:       sum(allVals("notes_created")),
          calendar_events:     sum(allVals("calendar_events")),
          github_commits:      sum(allVals("github_commits")),
          orders_placed:       sum(allVals("receipts_order_count")),
          orders_total_usd:    parseFloat(sum(allVals("receipts_total_usd")).toFixed(2)),
          activity_total_min:  parseFloat(sum(allVals("activity_total_min")).toFixed(1)),
        },
        averages: {
          steps_per_day:        avg(numVals("steps")),
          sleep_h:              avg(numVals("sleep_h")),
          resting_hr:           avg(numVals("resting_hr")),
          fear_greed:           avg(numVals("fear_greed_value")),
          activity_min_per_day: avg(numVals("activity_total_min")),
          mining_gh:            avg(numVals("mining_combined_gh")),
        },
        streaks: {
          duolingo_streak_end: snaps[snaps.length - 1]?.duolingo_streak ?? null,
          duolingo_streak_start: snaps[0]?.duolingo_streak ?? null,
        },
        crypto_range: {
          btc_price_start:     numVals("btc_price")[0] ?? null,
          btc_price_end:       numVals("btc_price").slice(-1)[0] ?? null,
          portfolio_usd_start: numVals("crypto_total_usd")[0] ?? null,
          portfolio_usd_end:   numVals("crypto_total_usd").slice(-1)[0] ?? null,
        },
        top_steam_games:     topEntries("steam_top_game", "steam_minutes_played"),
        top_spotify_artists: topEntries("spotify_top_artist"),
        top_sites:           topEntries("vivaldi_top_site"),
        top_apps:            topEntries("activity_top_app"),
      };

      return JSON.stringify(result, null, 2);
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ---------------------------------------------------------------------------
// MCP server bootstrap
// ---------------------------------------------------------------------------

const server = new Server(
  { name: "personal-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    const text = await handleTool(name, args ?? {});
    return { content: [{ type: "text", text }] };
  } catch (err) {
    return {
      content: [{ type: "text", text: `Error: ${err.message}` }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("Google + Standard Notes MCP server running (stdio)");

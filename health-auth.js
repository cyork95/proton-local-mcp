/**
 * health-auth.js
 * One-time OAuth flow to get a Google refresh token covering all Google APIs
 * used by this MCP server: Health, Gmail, Calendar, Drive, and Tasks.
 *
 * Setup:
 *  1. Go to https://console.cloud.google.com/ → New Project (or use an existing one)
 *  2. Enable these APIs:
 *       - Google Health API
 *       - Gmail API
 *       - Google Calendar API
 *       - Google Drive API
 *       - Tasks API
 *  3. OAuth consent screen → add your Google email as a Test User
 *  4. Credentials → OAuth 2.0 Client ID → Web application
 *       Add Authorized redirect URI: http://127.0.0.1:8890/callback
 *  5. Copy Client ID and Client Secret into .env as GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET
 *     (or the legacy names GOOGLE_HEALTH_CLIENT_ID / GOOGLE_HEALTH_CLIENT_SECRET also work)
 *  6. Run: node --dns-result-order=ipv4first health-auth.js
 *  7. Open the printed URL in your browser and complete the OAuth consent
 *  8. Paste the printed GOOGLE_REFRESH_TOKEN= line into your .env
 *
 * Note: While your app is in "Testing" mode, refresh tokens expire after 7 days.
 * Publish your app ("In Production") to get long-lived tokens.
 */

import { config as dotenvConfig } from "dotenv";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import { randomBytes, createHash } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: join(__dirname, ".env") });

const CLIENT_ID     = process.env.GOOGLE_CLIENT_ID     ?? process.env.GOOGLE_HEALTH_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET ?? process.env.GOOGLE_HEALTH_CLIENT_SECRET;
const REDIRECT_URI  = "http://127.0.0.1:8890/callback";
const PORT          = 8890;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env first.");
  console.error("(Legacy names GOOGLE_HEALTH_CLIENT_ID / GOOGLE_HEALTH_CLIENT_SECRET also work.)");
  process.exit(1);
}

// PKCE
const verifier  = randomBytes(64).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");

const SCOPES = [
  // Google Health
  "https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly",
  "https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly",
  "https://www.googleapis.com/auth/googlehealth.sleep.readonly",
  // Gmail
  "https://www.googleapis.com/auth/gmail.readonly",
  // Google Calendar
  "https://www.googleapis.com/auth/calendar.readonly",
  // Google Drive
  "https://www.googleapis.com/auth/drive.readonly",
  // Google Tasks
  "https://www.googleapis.com/auth/tasks.readonly",
].join(" ");

const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
authUrl.searchParams.set("client_id", CLIENT_ID);
authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
authUrl.searchParams.set("response_type", "code");
authUrl.searchParams.set("scope", SCOPES);
authUrl.searchParams.set("access_type", "offline");
authUrl.searchParams.set("prompt", "consent");   // force refresh_token to be issued
authUrl.searchParams.set("code_challenge", challenge);
authUrl.searchParams.set("code_challenge_method", "S256");

console.log("\nOpen this URL in your browser:\n");
console.log(authUrl.toString());
console.log("\nWaiting for callback on http://127.0.0.1:8890/callback ...\n");

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (url.pathname !== "/callback") { res.end("Not found"); return; }

  const code  = url.searchParams.get("code");
  const error = url.searchParams.get("error");
  if (error) { res.end(`Error: ${error}`); console.error("Auth error:", error); server.close(); return; }
  if (!code)  { res.end("No code received."); server.close(); return; }

  res.end("<h2>Got it! You can close this tab.</h2>");
  server.close();

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id:     CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri:  REDIRECT_URI,
      grant_type:    "authorization_code",
      code_verifier: verifier,
    }),
  });

  if (!tokenRes.ok) {
    const err = await tokenRes.text();
    console.error("Token exchange failed:", err);
    process.exit(1);
  }

  const data = await tokenRes.json();
  if (!data.refresh_token) {
    console.error("\n⚠️  No refresh_token returned. Make sure you:");
    console.error("   • Added your email as a Test User in Google Cloud Console");
    console.error("   • Used 'prompt=consent' (already set in this script)");
    console.error("   • Have all required APIs enabled and scopes added");
    process.exit(1);
  }

  console.log("\n✅ Success! Add this to your .env:\n");
  console.log(`GOOGLE_REFRESH_TOKEN=${data.refresh_token}`);
  console.log("\nThis single token covers: Health, Gmail, Calendar, Drive, Tasks.");
  console.log("Keep this token safe — treat it like a password.");
});

server.listen(PORT);

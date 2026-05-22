/**
 * health-auth.js
 * One-time OAuth flow to get your Google Health API refresh token.
 *
 * Setup:
 *  1. Go to https://console.developers.google.com/apis/library/health.googleapis.com
 *     and enable the Google Health API.
 *  2. Go to https://console.developers.google.com/apis/credentials
 *     → Create credentials → OAuth 2.0 Client ID → Web application
 *     → Add Authorized redirect URI: http://127.0.0.1:8890/callback
 *  3. Go to https://console.developers.google.com/auth/audience
 *     → Add your Google account email as a Test User
 *  4. Go to https://console.developers.google.com/auth/scopes
 *     → Add the three Google Health API scopes (activity_and_fitness, health_metrics, sleep)
 *  5. Copy Client ID and Client Secret into .env as GOOGLE_HEALTH_CLIENT_ID/SECRET
 *  6. Run: node health-auth.js
 *  7. Paste the printed GOOGLE_HEALTH_REFRESH_TOKEN into .env
 *
 * Note: While your app is in "Testing" mode, refresh tokens expire after 7 days.
 * Publish your app ("In Production") to get long-lived tokens.
 */

import "dotenv/config";
import http from "node:http";
import { randomBytes, createHash } from "node:crypto";

const CLIENT_ID     = process.env.GOOGLE_HEALTH_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_HEALTH_CLIENT_SECRET;
const REDIRECT_URI  = "http://127.0.0.1:8890/callback";
const PORT          = 8890;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("Set GOOGLE_HEALTH_CLIENT_ID and GOOGLE_HEALTH_CLIENT_SECRET in .env first.");
  process.exit(1);
}

// PKCE
const verifier  = randomBytes(64).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");

const SCOPES = [
  "https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly",
  "https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly",
  "https://www.googleapis.com/auth/googlehealth.sleep.readonly",
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
    console.error("   • Have the correct scopes enabled on the Data Access page");
    process.exit(1);
  }

  console.log("\n✅ Success! Add this to your .env:\n");
  console.log(`GOOGLE_HEALTH_REFRESH_TOKEN=${data.refresh_token}`);
  console.log("\nKeep this token safe — treat it like a password.");
});

server.listen(PORT);

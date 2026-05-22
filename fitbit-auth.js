/**
 * fitbit-auth.js
 * One-time OAuth flow to get your Fitbit refresh token.
 *
 * Setup:
 *  1. Go to https://dev.fitbit.com/apps/new
 *  2. Fill in any name/description
 *  3. OAuth 2.0 Application Type: Personal
 *  4. Callback URL: http://127.0.0.1:8889/callback
 *  5. Requested scopes: activity, heartrate, sleep, profile
 *  6. Save — copy Client ID and Client Secret into .env
 *  7. Run: node fitbit-auth.js
 *  8. Copy the printed FITBIT_REFRESH_TOKEN into .env
 */

import "dotenv/config";
import http from "node:http";
import { createHash, randomBytes } from "node:crypto";

const CLIENT_ID     = process.env.FITBIT_CLIENT_ID;
const CLIENT_SECRET = process.env.FITBIT_CLIENT_SECRET;
const REDIRECT_URI  = "http://127.0.0.1:8889/callback";
const PORT          = 8889;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("Set FITBIT_CLIENT_ID and FITBIT_CLIENT_SECRET in .env first.");
  process.exit(1);
}

// PKCE challenge
const verifier  = randomBytes(64).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");

const authUrl = new URL("https://www.fitbit.com/oauth2/authorize");
authUrl.searchParams.set("response_type", "code");
authUrl.searchParams.set("client_id", CLIENT_ID);
authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
authUrl.searchParams.set("scope", "activity heartrate sleep profile");
authUrl.searchParams.set("code_challenge", challenge);
authUrl.searchParams.set("code_challenge_method", "S256");
authUrl.searchParams.set("expires_in", "604800");

console.log("\nOpen this URL in your browser:\n");
console.log(authUrl.toString());
console.log("\nWaiting for callback on http://127.0.0.1:8889/callback ...\n");

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (url.pathname !== "/callback") { res.end("Not found"); return; }

  const code = url.searchParams.get("code");
  if (!code) { res.end("No code in callback"); return; }

  res.end("<h2>Got it! You can close this tab.</h2>");
  server.close();

  // Exchange code for tokens
  const creds = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");
  const tokenRes = await fetch("https://api.fitbit.com/oauth2/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${creds}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    }),
  });

  if (!tokenRes.ok) {
    const err = await tokenRes.text();
    console.error("Token exchange failed:", err);
    process.exit(1);
  }

  const data = await tokenRes.json();
  console.log("\n✅ Success! Add these to your .env:\n");
  console.log(`FITBIT_REFRESH_TOKEN=${data.refresh_token}`);
  console.log(`\nAccess token (expires in ~1 hour, not needed in .env):\n${data.access_token}`);
});

server.listen(PORT);

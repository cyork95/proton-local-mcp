/**
 * One-time Spotify OAuth setup — run this once to get your refresh token.
 * Usage: node spotify-auth.js
 *
 * Prerequisites:
 *  1. Go to https://developer.spotify.com/dashboard
 *  2. Create an app (any name, e.g. "My MCP")
 *  3. In the app settings, add this Redirect URI: http://localhost:8888/callback
 *  4. Copy the Client ID and Client Secret into your .env
 *  5. Run: node spotify-auth.js
 *  6. Approve in the browser that opens
 *  7. Copy the SPOTIFY_REFRESH_TOKEN printed here into your .env
 */

import "dotenv/config";
import { createServer } from "node:http";

const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const REDIRECT_URI = "http://127.0.0.1:8888/callback";

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in .env first.");
  process.exit(1);
}

const SCOPES = [
  "user-read-recently-played",
  "user-read-currently-playing",
  "user-read-playback-state",
].join(" ");

const authUrl =
  "https://accounts.spotify.com/authorize?" +
  new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
  });

console.log("\n=== Spotify One-Time Auth Setup ===");
console.log("\nOpening your browser to authorize. If it doesn't open, paste this URL manually:\n");
console.log(authUrl);
console.log("\nWaiting for callback on http://localhost:8888/callback ...\n");

// Try to open the browser
const { exec } = await import("node:child_process");
exec(`start "" "${authUrl}"`);

// Temporary HTTP server to catch the redirect
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost:8888");
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  if (error) {
    res.writeHead(400);
    res.end(`Auth denied: ${error}`);
    console.error(`\nAuth denied: ${error}`);
    server.close();
    process.exit(1);
  }

  if (!code) {
    res.writeHead(400);
    res.end("No code received.");
    return;
  }

  // Exchange code for tokens
  const credentials = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");
  const tokenRes = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
    }),
  });

  const tokens = await tokenRes.json();

  if (tokens.error) {
    res.writeHead(500);
    res.end(`Token exchange failed: ${tokens.error_description}`);
    console.error(`\nToken exchange failed: ${tokens.error_description}`);
    server.close();
    process.exit(1);
  }

  res.writeHead(200, { "Content-Type": "text/html" });
  res.end("<h2>Success! You can close this tab.</h2><p>Go back to your terminal.</p>");

  console.log("\n✓ Authorization successful!\n");
  console.log("Add this line to your .env file:");
  console.log(`\nSPOTIFY_REFRESH_TOKEN=${tokens.refresh_token}\n`);

  server.close();
  process.exit(0);
});

server.listen(8888);

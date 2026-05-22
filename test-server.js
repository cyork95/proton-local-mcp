/**
 * Smoke-test the MCP server dependencies and connections.
 * Run: node test-server.js
 */

import "dotenv/config";
import { ImapFlow } from "imapflow";

const checks = [];

function check(name, condition, detail = "") {
  const ok = Boolean(condition);
  checks.push({ name, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? `  (${detail})` : ""}`);
}

// --- Env vars ---
console.log("\n=== Environment ===");
check("BRIDGE_EMAIL set", process.env.BRIDGE_EMAIL);
check("BRIDGE_PASSWORD set", process.env.BRIDGE_PASSWORD);
check("BRIDGE_IMAP_HOST set", process.env.BRIDGE_IMAP_HOST, process.env.BRIDGE_IMAP_HOST ?? "missing");
check("BRIDGE_IMAP_PORT set", process.env.BRIDGE_IMAP_PORT, process.env.BRIDGE_IMAP_PORT ?? "missing");
check("STANDARD_NOTES_EMAIL set", process.env.STANDARD_NOTES_EMAIL);
check("STANDARD_NOTES_PASSWORD set", process.env.STANDARD_NOTES_PASSWORD);

// --- Proton Bridge IMAP ---
console.log("\n=== Proton Bridge IMAP ===");
const imapClient = new ImapFlow({
  host: process.env.BRIDGE_IMAP_HOST ?? "127.0.0.1",
  port: Number(process.env.BRIDGE_IMAP_PORT ?? 1143),
  secure: process.env.BRIDGE_IMAP_SECURE === "true",
  tls: { rejectUnauthorized: false },
  auth: {
    user: process.env.BRIDGE_EMAIL,
    pass: process.env.BRIDGE_PASSWORD,
  },
  logger: false,
});

try {
  await imapClient.connect();
  check("Bridge IMAP connection", true, `${process.env.BRIDGE_IMAP_HOST}:${process.env.BRIDGE_IMAP_PORT}`);

  const status = await imapClient.status("INBOX", { messages: true, unseen: true });
  check("INBOX accessible", true, `${status.messages} messages, ${status.unseen} unread`);

  const boxes = await imapClient.list();
  check("Mailboxes listed", boxes.length > 0, boxes.slice(0, 5).map(b => b.path).join(", "));

  await imapClient.logout();
} catch (err) {
  check("Bridge IMAP connection", false, err.message);
  console.log("\n  Troubleshooting:");
  console.log("  • Is Proton Bridge running? Open the Bridge app and confirm it shows 'Connected'.");
  console.log("  • Is BRIDGE_PASSWORD the Bridge-generated password (not your Proton login)?");
  console.log("  • Check the port in Bridge settings (usually 1143).");
}

// --- Standard Notes API ---
console.log("\n=== Standard Notes API ===");
const snServer = process.env.STANDARD_NOTES_SERVER ?? "https://api.standardnotes.com";
try {
  const res = await fetch(`${snServer}/healthcheck`);
  check("Standard Notes API reachable", res.ok, `HTTP ${res.status}`);
} catch (err) {
  check("Standard Notes API reachable", false, err.message);
}

// --- Dependencies ---
console.log("\n=== Dependencies ===");
try {
  await import("@modelcontextprotocol/sdk/server/index.js");
  check("@modelcontextprotocol/sdk importable", true);
} catch (err) {
  check("@modelcontextprotocol/sdk importable", false, "run: npm install");
}

try {
  await import("argon2");
  check("argon2 importable", true);
} catch (err) {
  check("argon2 importable", false, "run: npm install  (needs C++ build tools on Windows)");
}

// --- Summary ---
const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) {
  console.log("\nFailed:");
  failed.forEach((c) => console.log(`  ✗ ${c.name}`));
  process.exit(1);
}

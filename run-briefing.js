/**
 * run-briefing.js
 * Standalone daily briefing runner — called by Windows Task Scheduler at 6 PM.
 * Generates the full briefing, saves it to the Standard Notes backup folder,
 * and writes a timestamped log next to this file.
 */

import "dotenv/config";
import { appendFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Re-use the handleTool function from server.js
// We import the handler indirectly by duplicating the minimal bootstrap needed.
// Easier: just shell out to a tiny inline call via the same module graph.
// Instead, we import handleTool directly — server.js exports nothing, so we
// copy just what we need by calling via the MCP transport in child-process mode.
// Simplest reliable approach: spawn the node process and talk stdio-MCP to it.

import { spawn } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_FILE  = join(__dirname, "briefing-runner.log");

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  process.stdout.write(line);
  return appendFile(LOG_FILE, line).catch(() => {});
}

async function runBriefing() {
  await log("Starting daily briefing run...");

  const today = new Date().toLocaleDateString("en-CA", {
    timeZone: "America/Indiana/Indianapolis",
  }); // YYYY-MM-DD

  // Build a minimal JSON-RPC 2.0 request for the MCP server
  const initRequest   = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "runner", version: "1.0" } } });
  const notifyInit    = JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" });
  const toolRequest   = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "daily_briefing", arguments: { date: today } } });

  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--dns-result-order=ipv4first", join(__dirname, "server.js")],
      { cwd: __dirname, stdio: ["pipe", "pipe", "pipe"] }
    );

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });

    // Send init, then wait a beat, then send the tool call
    child.stdin.write(initRequest + "\n");

    // Parse streaming responses; resolve when we get id=2 response
    let responded = false;
    child.stdout.on("data", () => {
      const lines = stdout.split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === 1) {
            // Init response received — send initialized notification then tool call
            child.stdin.write(notifyInit + "\n");
            child.stdin.write(toolRequest + "\n");
          }
          if (msg.id === 2 && !responded) {
            responded = true;
            child.stdin.end();
            if (msg.error) {
              reject(new Error(msg.error.message));
            } else {
              const text = msg.result?.content?.[0]?.text ?? "(empty)";
              resolve(text);
            }
          }
        } catch { /* partial line, wait for more */ }
      }
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (!responded) reject(new Error(`Server exited with code ${code}. stderr: ${stderr.slice(0, 500)}`));
    });

    // Safety timeout — kill after 60 s
    setTimeout(() => {
      if (!responded) {
        child.kill();
        reject(new Error("Briefing timed out after 60 s"));
      }
    }, 60_000);
  });
}

(async () => {
  try {
    const briefing = await runBriefing();
    await log(`Briefing generated (${briefing.length} chars). Done.`);

    // Also save a standalone markdown file to Desktop for easy access
    const date    = new Date().toLocaleDateString("en-CA", { timeZone: "America/Indiana/Indianapolis" });
    const outFile = join("C:\\Users\\coyof\\Desktop", `Daily Briefing ${date}.md`);
    await writeFile(outFile, briefing, "utf-8");
    await log(`Saved to Desktop: ${outFile}`);
  } catch (err) {
    await log(`ERROR: ${err.message}`);
    process.exit(1);
  }
})();

/**
 * run-summary.js
 * Called by Windows Task Scheduler:
 *   node run-summary.js monthly   → runs on 1st of each month at 6 PM
 *   node run-summary.js yearly    → runs on Jan 1st at 6 PM
 *
 * Reads daily JSON snapshots, generates a summary, saves to Desktop + Standard Notes.
 */

import "dotenv/config";
import { appendFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_FILE  = join(__dirname, "summary-runner.log");
const mode      = process.argv[2] ?? "monthly"; // "monthly" or "yearly"

function log(msg) {
  const line = `[${new Date().toISOString()}] [${mode}] ${msg}\n`;
  process.stdout.write(line);
  return appendFile(LOG_FILE, line).catch(() => {});
}

async function runSummary() {
  const now   = new Date();
  const year  = now.getFullYear();
  const month = now.getMonth(); // 0-based; for monthly we want the PREVIOUS month

  let toolName, toolArgs;
  if (mode === "yearly") {
    // Run on Jan 1st — summarise the previous year
    toolName = "yearly_summary";
    toolArgs = { year: year - 1 };
  } else {
    // Run on 1st of month — summarise the previous month
    const prevMonth = month === 0 ? 12 : month;
    const prevYear  = month === 0 ? year - 1 : year;
    toolName = "monthly_summary";
    toolArgs = { year: prevYear, month: prevMonth };
  }

  const initRequest = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "runner", version: "1.0" } } });
  const notifyInit  = JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" });
  const toolRequest = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: toolName, arguments: toolArgs } });

  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--dns-result-order=ipv4first", join(__dirname, "server.js")],
      { cwd: __dirname, stdio: ["pipe", "pipe", "pipe"] }
    );

    let stdout = "", stderr = "", responded = false;
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.stdin.write(initRequest + "\n");

    child.stdout.on("data", () => {
      for (const line of stdout.split("\n")) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === 1) {
            child.stdin.write(notifyInit + "\n");
            child.stdin.write(toolRequest + "\n");
          }
          if (msg.id === 2 && !responded) {
            responded = true;
            child.stdin.end();
            if (msg.error) reject(new Error(msg.error.message));
            else resolve(msg.result?.content?.[0]?.text ?? "(empty)");
          }
        } catch { /* partial */ }
      }
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (!responded) reject(new Error(`Server exited ${code}. stderr: ${stderr.slice(0, 500)}`));
    });
    setTimeout(() => { if (!responded) { child.kill(); reject(new Error("Timed out after 60s")); } }, 60_000);
  });
}

(async () => {
  await log(`Starting ${mode} summary run...`);
  try {
    const summary = await runSummary();
    await log(`Summary generated (${summary.length} chars).`);

    const now   = new Date();
    const label = mode === "yearly"
      ? `${now.getFullYear() - 1} Year in Review`
      : `${now.toLocaleDateString("en-US", { month: "long" })} ${now.getFullYear()} Summary`;

    const outFile = join("C:\\Users\\coyof\\Desktop", `${label}.md`);
    await writeFile(outFile, summary, "utf-8");
    await log(`Saved to Desktop: ${outFile}`);
  } catch (err) {
    await log(`ERROR: ${err.message}`);
    process.exit(1);
  }
})();

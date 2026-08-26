// Robinhood option-fill courier. Runs headless Claude Code (the
// user's Claude subscription — no API key involved) to call the
// Robinhood MCP's get_option_orders, then POSTs the raw JSON to
// app/api/robinhood-account/poll-transactions, which lands and
// processes it (lib/robinhood-account-import.ts). Idempotent —
// dedup is by execution_id on the server side, so an extra or late
// fire, or a wider-than-strictly-needed lookback window, is harmless.
//
// This is the one piece of the pipeline that ISN'T a plain server-side
// poll: Robinhood's official agent MCP is reached through Claude Code
// itself (proven to work headless — a `claude -p` run on this machine
// successfully called it non-interactively), not a stored OAuth token
// this script manages directly. If that MCP connection's own auth
// ever lapses, `claude -p` will fail below and this alerts via
// Telegram, same as a Schwab reconnect-needed case — the user
// reconnects it once and the courier resumes.
//
// Run via com.csp.robinhood-courier launchd agent, weekdays.
// Usage: npx tsx scripts/robinhood-courier.ts
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";

function loadEnvLocal(): void {
  const content = readFileSync(resolve(process.cwd(), ".env.local"), "utf8");
  for (const line of content.split("\n")) {
    const eq = line.indexOf("=");
    if (eq === -1 || line.trim().startsWith("#")) continue;
    const k = line.slice(0, eq).trim();
    if (!process.env[k]) process.env[k] = line.slice(eq + 1).trim();
  }
}

const CLAUDE_BIN = "/Users/raitsai/.local/bin/claude";
const POLL_URL = "https://csp-screener.vercel.app/api/robinhood-account/poll-transactions";
// 7-day rolling lookback, not a strict cursor — an order created days
// ago can still fill today, and idempotency is entirely execution_id
// dedup on the server, so overlap is intentional. See
// migrations/2026-08-21-robinhood-account-transactions.sql.
const LOOKBACK_DAYS = 7;

// Brace-counting extraction, not a fence regex — see the identical
// helper (and the 2026-08-26 incident that motivated it) in
// lib/robinhood-account-import.ts::extractFirstJsonObject. Duplicated
// rather than shared: this file only ever imports lib/telegram-alert,
// deliberately, so a courier failure can't be traced to an import-time
// coupling with the server-side lib.
function extractFirstJsonObject(text: string): string {
  const start = text.indexOf("{");
  if (start === -1) throw new Error("No JSON object found in claude -p output");
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  throw new Error("Unbalanced JSON object in claude -p output");
}

async function main() {
  loadEnvLocal();
  const { sendTelegramAlert } = await import("../lib/telegram-alert");

  // No hardcoded default — this repo is public and a Robinhood account
  // number has no safe truncation the way Schwab's last-3-digits
  // ACCOUNT_BROKER_MAP does. Lives only in the untracked .env.local.
  const ACCOUNT_NUMBER = process.env.ROBINHOOD_ACCOUNT_NUMBER ?? "";
  if (!ACCOUNT_NUMBER) {
    console.error("[robinhood-courier] ROBINHOOD_ACCOUNT_NUMBER not set in .env.local, aborting");
    process.exitCode = 1;
    return;
  }

  const nowIso = new Date().toISOString();
  const lookbackSince = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();
  console.log(`[${nowIso}] robinhood courier — account ${ACCOUNT_NUMBER}, lookback since ${lookbackSince}`);

  const prompt = [
    `Call the robinhood MCP tool get_option_orders with account_number="${ACCOUNT_NUMBER}"`,
    `and created_at_gte="${lookbackSince}". Do not call any other tool.`,
    `Do not place, cancel, or modify any order.`,
    `Output ONLY the raw JSON the tool returned — no prose, no markdown code`,
    `fences, no summary, no commentary. Your entire response must be valid JSON.`,
  ].join(" ");

  let stdout: string;
  try {
    stdout = execFileSync(
      CLAUDE_BIN,
      ["-p", prompt, "--allowedTools", "mcp__robinhood__get_option_orders"],
      { encoding: "utf8", timeout: 90_000, maxBuffer: 10 * 1024 * 1024 },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[robinhood-courier] claude -p failed: ${msg}`);
    await sendTelegramAlert(
      `🔴 Robinhood courier: headless Claude call failed (${msg}). If this persists, the Robinhood MCP connection likely needs reconnecting — run \`claude mcp list\` to check.`,
    );
    process.exitCode = 1;
    return;
  }

  let rawJson: string;
  try {
    rawJson = extractFirstJsonObject(stdout);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[robinhood-courier] couldn't extract JSON from claude -p output: ${msg}`);
    await sendTelegramAlert(`🔴 Robinhood courier: claude -p output wasn't parseable JSON (${msg}) — nothing submitted.`);
    process.exitCode = 1;
    return;
  }

  let res: Response;
  try {
    res = await fetch(
      `${POLL_URL}?accountNumber=${encodeURIComponent(ACCOUNT_NUMBER)}&lookbackSince=${encodeURIComponent(lookbackSince)}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.CRON_SECRET ?? ""}`,
          "Content-Type": "application/json",
        },
        body: rawJson,
      },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[robinhood-courier] POST failed: ${msg}`);
    await sendTelegramAlert(`🔴 Robinhood courier: POST to poll-transactions failed (${msg}).`);
    process.exitCode = 1;
    return;
  }

  const json = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    report?: { ordersSeen: number; executionsSeen: number; executionsLanded: number; tradesSubmitted: number; skipped: number; errors: string[] };
    error?: string;
  };

  if (!res.ok || !json.ok) {
    const detail = json.error ?? json.report?.errors?.join("; ") ?? `HTTP ${res.status}`;
    console.error(`[robinhood-courier] poll-transactions reported failure: ${detail}`);
    await sendTelegramAlert(`🔴 Robinhood courier: import failed — ${detail}`);
    process.exitCode = 1;
    return;
  }

  const r = json.report;
  console.log(
    `[robinhood-courier] ok — orders=${r?.ordersSeen ?? 0} executions=${r?.executionsSeen ?? 0} landed=${r?.executionsLanded ?? 0} submitted=${r?.tradesSubmitted ?? 0} skipped=${r?.skipped ?? 0}`,
  );
}

main().catch(async (e) => {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`[robinhood-courier] fatal: ${msg}`);
  try {
    const { sendTelegramAlert } = await import("../lib/telegram-alert");
    await sendTelegramAlert(`🔴 Robinhood courier: fatal error — ${msg}`);
  } catch {
    // best-effort alert — don't mask the original failure
  }
  process.exitCode = 1;
});

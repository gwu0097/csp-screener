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
// The prompt deliberately asks for ONLY the data.orders array, not the
// full tool response — the omitted "guide" field is pure LLM-facing
// instruction prose (unused by anything downstream) that's long and
// intricate enough to be exactly the kind of content an LLM can
// truncate or garble when asked to reproduce it verbatim. A
// 2026-08-26 incident traced two consecutive scheduled failures to
// this: one run wrapped the guide-inclusive response in a markdown
// fence inconsistently, the next produced genuinely truncated JSON
// mid-guide-text. Dropping the guide field shrinks the ask
// substantially and removes the hardest part to reproduce faithfully.
//
// Run via com.csp.robinhood-courier launchd agent, weekdays.
// Usage: npx tsx scripts/robinhood-courier.ts
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
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

const STATE_DIR = resolve(homedir(), "Library/Application Support/csp-screener");
const STATE_PATH = resolve(STATE_DIR, "robinhood-courier-state.json");

type State = { lastStatus: "ok" | "failed" | "unknown"; checkedAt: string; detail?: string };

function readState(): State {
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf8")) as State;
  } catch {
    return { lastStatus: "unknown", checkedAt: "" };
  }
}
function writeState(s: State): void {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(s, null, 2));
}

// Brace/bracket-counting extraction, not a fence regex — see the
// identical helper in lib/robinhood-account-import.ts (server-side,
// where the 2026-08-26 parse failure actually happened). Duplicated
// rather than shared: this file only ever imports lib/telegram-alert,
// deliberately, so a courier failure can't be traced to an import-time
// coupling with the server-side lib. Accepts either a top-level object
// or array as the first JSON value in the text, since the prompt below
// asks for a bare array but a "no prose" instruction is not a
// guarantee Claude never wraps it.
function extractFirstJsonValue(text: string): string {
  let start = -1;
  let openChar = "";
  let closeChar = "";
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "{" || text[i] === "[") {
      start = i;
      openChar = text[i];
      closeChar = openChar === "{" ? "}" : "]";
      break;
    }
  }
  if (start === -1) throw new Error("No JSON value found in claude -p output");
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
    if (ch === openChar) depth++;
    else if (ch === closeChar) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  throw new Error("Unbalanced JSON value in claude -p output");
}

async function main() {
  loadEnvLocal();
  const { sendTelegramAlert } = await import("../lib/telegram-alert");
  const prev = readState();
  const nowIso = new Date().toISOString();

  // Alert only on a state transition (ok -> failing, failing -> ok),
  // not on every failed run — a 2026-08-26 incident sent a separate
  // Telegram message for each of several consecutive scheduled
  // failures before this was added, mirroring the dedup already built
  // into scripts/schwab-account-poll-trigger.ts.
  async function fail(detail: string): Promise<void> {
    console.error(`[robinhood-courier] ${detail}`);
    if (prev.lastStatus !== "failed") {
      await sendTelegramAlert(`🔴 Robinhood courier failing: ${detail}`);
    }
    writeState({ lastStatus: "failed", checkedAt: nowIso, detail });
    process.exitCode = 1;
  }
  async function succeed(summary: string): Promise<void> {
    console.log(`[robinhood-courier] ${summary}`);
    if (prev.lastStatus === "failed") {
      await sendTelegramAlert("🟢 Robinhood courier recovered — back to normal.");
    }
    writeState({ lastStatus: "ok", checkedAt: nowIso });
  }

  // No hardcoded default — this repo is public and a Robinhood account
  // number has no safe truncation the way Schwab's last-3-digits
  // ACCOUNT_BROKER_MAP does. Lives only in the untracked .env.local.
  const ACCOUNT_NUMBER = process.env.ROBINHOOD_ACCOUNT_NUMBER ?? "";
  if (!ACCOUNT_NUMBER) {
    await fail("ROBINHOOD_ACCOUNT_NUMBER not set in .env.local, aborting");
    return;
  }

  const lookbackSince = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();
  console.log(`[${nowIso}] robinhood courier — account ${ACCOUNT_NUMBER}, lookback since ${lookbackSince}`);

  const prompt = [
    `Call the robinhood MCP tool get_option_orders with account_number="${ACCOUNT_NUMBER}"`,
    `and created_at_gte="${lookbackSince}". Do not call any other tool.`,
    `Do not place, cancel, or modify any order.`,
    `The tool result has a top-level "data.orders" array and a separate "guide"`,
    `field — the guide field is instructions for you, not order data; do NOT`,
    `include it or any other part of the response in your output.`,
    `Output ONLY the JSON array found at data.orders, nothing else: no prose,`,
    `no markdown code fences, no summary, no commentary, no wrapping object.`,
    `Your entire response must be exactly that array, starting with [ and`,
    `ending with ].`,
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
    await fail(
      `headless Claude call failed (${msg}). If this persists, the Robinhood MCP connection likely needs reconnecting — run \`claude mcp list\` to check.`,
    );
    return;
  }

  let rawJson: string;
  try {
    rawJson = extractFirstJsonValue(stdout);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await fail(`claude -p output wasn't parseable JSON (${msg}) — nothing submitted.`);
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
    await fail(`POST to poll-transactions failed (${msg}).`);
    return;
  }

  const json = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    report?: { ordersSeen: number; executionsSeen: number; executionsLanded: number; tradesSubmitted: number; skipped: number; errors: string[] };
    error?: string;
  };

  if (!res.ok || !json.ok) {
    const detail = json.error ?? json.report?.errors?.join("; ") ?? `HTTP ${res.status}`;
    await fail(`import failed — ${detail}`);
    return;
  }

  const r = json.report;
  await succeed(
    `ok — orders=${r?.ordersSeen ?? 0} executions=${r?.executionsSeen ?? 0} landed=${r?.executionsLanded ?? 0} submitted=${r?.tradesSubmitted ?? 0} skipped=${r?.skipped ?? 0}`,
  );
}

main().catch(async (e) => {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`[robinhood-courier] fatal: ${msg}`);
  try {
    const { sendTelegramAlert } = await import("../lib/telegram-alert");
    const prev = readState();
    if (prev.lastStatus !== "failed") {
      await sendTelegramAlert(`🔴 Robinhood courier: fatal error — ${msg}`);
    }
    writeState({ lastStatus: "failed", checkedAt: new Date().toISOString(), detail: msg });
  } catch {
    // best-effort alert — don't mask the original failure
  }
  process.exitCode = 1;
});

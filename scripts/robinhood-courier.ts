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
// Discord, same as a Schwab reconnect-needed case — the user
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

// Module-level, not inside main() — the outer main().catch() fatal
// handler needs the same clock, and a fatal error can happen before
// main()'s own local timer would exist. Captures wall-clock from
// process start to whichever exit path fires, covering the full
// execFileSync call (the thing actually at risk of drifting toward the
// 170s budget) plus everything around it.
const SCRIPT_STARTED_AT = Date.now();
function elapsedSeconds(): string {
  return ((Date.now() - SCRIPT_STARTED_AT) / 1000).toFixed(1);
}

const CLAUDE_BIN = "/Users/raitsai/.local/bin/claude";
const POLL_URL = "https://csp-screener.vercel.app/api/robinhood-account/poll-transactions";
const ATTEMPT_URL = "https://csp-screener.vercel.app/api/robinhood-account/poll-attempt";
// 7-day rolling lookback, not a strict cursor — an order created days
// ago can still fill today, and idempotency is entirely execution_id
// dedup on the server, so overlap is intentional. See
// migrations/2026-08-21-robinhood-account-transactions.sql.
const LOOKBACK_DAYS = 7;

const STATE_DIR = resolve(homedir(), "Library/Application Support/csp-screener");
const STATE_PATH = resolve(STATE_DIR, "robinhood-courier-state.json");

type Severity = "ok" | "warning" | "failed";
type State = {
  lastStatus: Severity | "unknown";
  checkedAt: string;
  detail?: string;
  // Runs of consecutive failed statuses, reset to 0 on anything else.
  // Lets a persisting failure keep alerting (with the count) instead of
  // going silent after the first ping — see fail() below.
  consecutiveFailures?: number;
};

function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

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

// Same classifier as scripts/schwab-account-poll-trigger.ts — see
// that file's comment for the full reasoning. Duplicated per this
// script's existing zero-import-coupling convention, not shared.
function classifyErrors(errors: string[]): Severity {
  if (errors.length === 0) return "ok";
  return errors.every((e) => /no matching open position/i.test(e)) ? "warning" : "failed";
}

// Brace/bracket-counting extraction, not a fence regex — see the
// identical helper in lib/robinhood-account-import.ts (server-side,
// where the 2026-08-26 parse failure actually happened). Duplicated
// rather than shared: this file only ever imports lib/discord-alert,
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
  const { sendDiscordAlert } = await import("../lib/discord-alert");
  const prev = readState();
  const nowIso = new Date().toISOString();

  // This job runs 4x/day, not continuously — transition-only dedup
  // (alert on ok->failed but stay silent while failed persists) makes
  // "still failing," "ran clean," and "never fired" all indistinguishable
  // from Discord, which is exactly what happened 2026-09-04: an 11:07am
  // failure alert never recovered, so the 1:05pm failure sent nothing.
  // Every run now posts its outcome — the state file is kept only to
  // track consecutiveFailures for the "(Nth consecutive run)" label, not
  // to decide whether to send. The one exception is the WARNING severity
  // (see warn() below): a warning means an off-strategy trade is sitting
  // undismissed in the activity panel, a standing fact that doesn't
  // change run to run the way "did the courier work this cycle" does —
  // per-run posting there would just re-alert the same undismissed trade
  // every 2 hours for as long as it sits there, so warning stays
  // transition-deduped.
  // duration= on every line, success or failure, printed at the SAME
  // position regardless of outcome so a plain `grep duration= | awk` can
  // pull a trend later — the point of logging it at all (see the
  // 2026-09-04 request: a 168s success and a 20s success looked
  // identical, no way to tell drift toward the 170s budget from
  // isolated spikes). Written into the console line, not the state
  // file — state only ever holds the latest run, and a trend needs the
  // append-only log history.
  // POSTs a bare failure record for runs that never reach POLL_URL at
  // all (the headless `claude -p` call itself hanging/failing, JSON
  // extraction failing, a missing account number) — those failure
  // modes previously left zero trace in the database, only this
  // script's local state file. Best-effort: a broken attempt-log call
  // must never mask the original failure or throw out of fail().
  async function logLocalAttempt(detail: string): Promise<void> {
    try {
      await fetch(ATTEMPT_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.CRON_SECRET ?? ""}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          accountNumber: process.env.ROBINHOOD_ACCOUNT_NUMBER ?? null,
          detail,
          startedAt: new Date(SCRIPT_STARTED_AT).toISOString(),
        }),
      });
    } catch {
      // best-effort — don't let attempt-logging itself break the courier
    }
  }

  // reachedServer=true for failures where POLL_URL already returned a
  // response — those runs already have a real row from the deployed
  // route's own insert (lib/robinhood-account-import.ts), so logging
  // here again would just duplicate it.
  async function fail(detail: string, opts?: { reachedServer?: boolean }): Promise<void> {
    console.error(`[robinhood-courier] duration=${elapsedSeconds()}s ${detail}`);
    const consecutiveFailures = (prev.consecutiveFailures ?? 0) + 1;
    const streak = consecutiveFailures > 1 ? ` (${ordinal(consecutiveFailures)} consecutive run)` : "";
    await sendDiscordAlert(`🔴 Robinhood courier failing${streak}: ${detail}`);
    if (!opts?.reachedServer) {
      await logLocalAttempt(detail);
    }
    writeState({ lastStatus: "failed", checkedAt: nowIso, detail, consecutiveFailures });
    process.exitCode = 1;
  }
  // Transition-deduped, unlike fail()/succeed() — see the header
  // comment above for why a warning is a standing fact (an undismissed
  // trade), not new per-run information.
  async function warn(detail: string, count: number): Promise<void> {
    console.warn(`[robinhood-courier] duration=${elapsedSeconds()}s warning: ${detail}`);
    if (prev.lastStatus !== "warning") {
      await sendDiscordAlert(
        `🟡 Robinhood courier: ${count} trade(s) couldn't auto-import because they aren't part of a tracked position — not necessarily broken, just off-strategy or opened outside this app. Review and Dismiss in the activity panel.\n${detail}`,
        { mention: false },
      );
    }
    writeState({ lastStatus: "warning", checkedAt: nowIso, detail, consecutiveFailures: 0 });
    // Not a script failure — the poll itself ran fine; exit code stays 0.
  }
  async function succeed(summary: string): Promise<void> {
    console.log(`[robinhood-courier] duration=${elapsedSeconds()}s ${summary}`);
    const prefix =
      prev.lastStatus === "failed"
        ? "🟢 Robinhood courier recovered — connectivity restored.\n"
        : prev.lastStatus === "warning"
          ? "🟢 Robinhood courier recovered from data warnings — no action was needed.\n"
          : "🟢 Robinhood courier ok — ";
    await sendDiscordAlert(`${prefix}${summary}`, { mention: false });
    writeState({ lastStatus: "ok", checkedAt: nowIso, consecutiveFailures: 0 });
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
    // 90s was too tight — a 2026-08-27 diagnostic timed a genuinely
    // successful headless call at 93.6s (fetching + the MCP round
    // trip both vary in latency), so real calls were spuriously
    // ETIMEDOUT-ing at the old limit. This isn't the whole-script
    // budget: launchd fires this job every 2 hours, so there's ample
    // room.
    stdout = execFileSync(
      CLAUDE_BIN,
      ["-p", prompt, "--allowedTools", "mcp__robinhood__get_option_orders"],
      { encoding: "utf8", timeout: 170_000, maxBuffer: 10 * 1024 * 1024 },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // ETIMEDOUT here means execFileSync's own `timeout` option killed a
    // process that HAD started and was still running past the 170s
    // budget — not a process that failed to launch, and not a dead MCP
    // connection. Confirmed directly (2026-09-04): a spawnSync child
    // killed by timeout reports exactly this code, after running for
    // the full timeout duration, not near-instantly. `claude mcp list`
    // checks the CLI's persistent server registration, which has
    // nothing to do with one invocation's own round-trip latency — each
    // headless call opens and tears down its own MCP session fresh, so
    // there's no persistent connection here to be "reconnected." Live
    // check the same day this was fixed: `claude mcp list` showed
    // robinhood as Connected while these calls were timing out.
    const code = (e as NodeJS.ErrnoException).code;
    const detail =
      code === "ETIMEDOUT"
        ? `headless Claude call started but didn't finish within the 170s budget (${msg}). The process ran, it was just slow this time — check for scheduling overlap (schwab-account-poll fires 5 min before every one of this job's runs) or general system load around the fire time, not the MCP connection (\`claude mcp list\` reflects the CLI's registration, not this run's latency).`
        : `headless Claude call failed (${msg}, code=${code ?? "unknown"}).`;
    await fail(detail);
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

  // A non-2xx HTTP status is always a real failure — never content-
  // classified, regardless of what the body says.
  if (!res.ok) {
    const detail = json.error ?? `HTTP ${res.status}`;
    await fail(`import failed — ${detail}`, { reachedServer: true });
    return;
  }

  if (!json.ok) {
    const allErrors = json.error ? [json.error] : (json.report?.errors ?? []);
    const detail =
      json.error ?? ((json.report?.errors ?? []).join("; ") || `ok=false with no error detail (HTTP ${res.status})`);
    // No captured error strings despite ok=false is itself an anomaly
    // — classify as failed, not a silent "ok" via classifyErrors([]).
    const severity: Severity = allErrors.length > 0 ? classifyErrors(allErrors) : "failed";
    if (severity === "warning") {
      await warn(detail, allErrors.length);
      return;
    }
    await fail(`import failed — ${detail}`, { reachedServer: true });
    return;
  }

  const r = json.report;
  await succeed(
    `orders=${r?.ordersSeen ?? 0} executions=${r?.executionsSeen ?? 0} landed=${r?.executionsLanded ?? 0} submitted=${r?.tradesSubmitted ?? 0} skipped=${r?.skipped ?? 0}`,
  );
}

main().catch(async (e) => {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`[robinhood-courier] duration=${elapsedSeconds()}s fatal: ${msg}`);
  try {
    const { sendDiscordAlert } = await import("../lib/discord-alert");
    const prev = readState();
    const consecutiveFailures = (prev.consecutiveFailures ?? 0) + 1;
    const streak = consecutiveFailures > 1 ? `, still failing (${ordinal(consecutiveFailures)} consecutive run)` : "";
    await sendDiscordAlert(`🔴 Robinhood courier: fatal error${streak} — ${msg}`);
    writeState({ lastStatus: "failed", checkedAt: new Date().toISOString(), detail: msg, consecutiveFailures });
    await fetch(ATTEMPT_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.CRON_SECRET ?? ""}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        accountNumber: process.env.ROBINHOOD_ACCOUNT_NUMBER ?? null,
        detail: `fatal error — ${msg}`,
        startedAt: new Date(SCRIPT_STARTED_AT).toISOString(),
      }),
    }).catch(() => {});
  } catch {
    // best-effort alert — don't mask the original failure
  }
  process.exitCode = 1;
});

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
// budget) plus everything around it.
const SCRIPT_STARTED_AT = Date.now();
function elapsedSeconds(): number {
  return (Date.now() - SCRIPT_STARTED_AT) / 1000;
}

// The message posted at run start, edited in place to the final result
// at whichever exit path fires — one message per run, not two. Also
// readable from main().catch() below, which has no other way to reach
// the same message. runRowId is the equivalent thread for the DB-side
// "running" placeholder (see poll-run-start below).
let startMessageId: string | null = null;
let runRowId: string | null = null;

const CLAUDE_BIN = "/Users/raitsai/.local/bin/claude";
const POLL_URL = "https://csp-screener.vercel.app/api/robinhood-account/poll-transactions";
const ATTEMPT_URL = "https://csp-screener.vercel.app/api/robinhood-account/poll-attempt";
const RUN_START_URL = "https://csp-screener.vercel.app/api/robinhood-account/poll-run-start";
// Was 170_000 (raised once already from 90_000 after a 2026-08-27
// diagnostic clocked a good run at 93.6s). Round-trip latency has
// roughly doubled again since then — a live repro on 2026-09-04
// completed successfully in 173.8s, and the same day's scheduled runs
// were landing right on the 170s line (one killed at 170.4s, one
// succeeded at 173.8s, same latency either way). 500s is a safety
// valve against a run that's genuinely wedged, not a drift-detection
// mechanism — the start/finish Discord messages and the 80%-budget
// warning below do the actual detecting, so the ceiling itself doesn't
// need to be tight.
const CLAUDE_TIMEOUT_MS = 500_000;
const BUDGET_WARNING_RATIO = 0.8;
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
  // Used only to label "(Nth consecutive run)" — every failed run
  // alerts regardless of this count, see fail() below.
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

// "1:05pm" — no leading zero on the hour, no space before am/pm. This
// runs on the user's own Mac via launchd, so the system's local
// timezone (not UTC) is exactly the right one to render in.
function fmtClock(d: Date): string {
  let h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? "pm" : "am";
  h = h % 12 || 12;
  return `${h}:${String(m).padStart(2, "0")}${ampm}`;
}

function truncateWithNote(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return `${s.slice(0, maxLen)}... [truncated, ${s.length} chars total]`;
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
  const { sendDiscordAlert, editDiscordAlert } = await import("../lib/discord-alert");
  const prev = readState();
  const nowIso = new Date().toISOString();

  // This job runs 4x/day, not continuously — one message per run,
  // posted at start and edited in place at completion, rather than
  // silence-until-transition (which made "still failing," "ran
  // clean," and "never fired" indistinguishable from Discord — see the
  // 2026-09-04 incident where an 11:07am failure alert never
  // recovered, so the 1:05pm failure sent nothing) or two separate
  // messages per run (which would double the channel's volume for no
  // extra information, since the start and end of one run are the same
  // event). The state file is kept only to track consecutiveFailures
  // for the "(Nth consecutive run)" label, never to decide whether to
  // post.
  const startClock = fmtClock(new Date(SCRIPT_STARTED_AT));
  const startPost = await sendDiscordAlert(`🔵 ${startClock} — Robinhood courier starting`, {
    mention: false,
    returnId: true,
  });
  startMessageId = startPost.messageId ?? null;

  // Best-effort "running" placeholder for the Positions page — see
  // app/api/robinhood-account/poll-run-start. Independent of the
  // Discord post above: either can fail without affecting the other.
  try {
    const runStartRes = await fetch(RUN_START_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.CRON_SECRET ?? ""}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ accountNumber: process.env.ROBINHOOD_ACCOUNT_NUMBER ?? null }),
    });
    const runStartJson = (await runStartRes.json().catch(() => null)) as { runRowId?: string } | null;
    runRowId = runStartJson?.runRowId ?? null;
  } catch {
    // best-effort — a failure here shouldn't block the actual courier run
  }

  // Edits the start placeholder to its final text; falls back to a
  // fresh post if there's no message id to edit (the start post itself
  // failed) or the edit call fails for some other reason, so the
  // outcome is never silently lost.
  async function finish(text: string, opts?: { mention?: boolean }): Promise<void> {
    if (startMessageId) {
      const res = await editDiscordAlert(startMessageId, text, opts);
      if (res.ok) return;
    }
    await sendDiscordAlert(text, opts);
  }

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
          runRowId: runRowId ?? undefined,
        }),
      });
    } catch {
      // best-effort — don't let attempt-logging itself break the courier
    }
  }

  // reachedServer=true for failures where POLL_URL already returned a
  // response — those runs already have a real row from the deployed
  // route's own insert/update (lib/robinhood-account-import.ts), so
  // logging here again would just duplicate it.
  async function fail(
    outcomePhrase: string,
    detail: string,
    opts?: { reachedServer?: boolean },
  ): Promise<void> {
    console.error(`[robinhood-courier] duration=${elapsedSeconds().toFixed(1)}s ${outcomePhrase}: ${detail}`);
    const consecutiveFailures = (prev.consecutiveFailures ?? 0) + 1;
    const streak = consecutiveFailures > 1 ? ` (${ordinal(consecutiveFailures)} consecutive run)` : "";
    const endClock = fmtClock(new Date());
    await finish(`🔴 ${endClock} — Robinhood courier ${outcomePhrase}${streak}.\n${detail}`);
    if (!opts?.reachedServer) {
      await logLocalAttempt(detail);
    }
    writeState({ lastStatus: "failed", checkedAt: nowIso, detail, consecutiveFailures });
    process.exitCode = 1;
  }
  async function warn(detail: string, count: number): Promise<void> {
    console.warn(`[robinhood-courier] duration=${elapsedSeconds().toFixed(1)}s warning: ${detail}`);
    const endClock = fmtClock(new Date());
    await finish(
      `🟡 ${endClock} — Robinhood courier finished: ${count} trade(s) couldn't auto-import — not part of a tracked position. Review and Dismiss in the activity panel.\n${detail}`,
      { mention: false },
    );
    writeState({ lastStatus: "warning", checkedAt: nowIso, detail, consecutiveFailures: 0 });
    // Not a script failure — the poll itself ran fine; exit code stays 0.
  }
  async function succeed(fillsCount: number, summary: string): Promise<void> {
    const elapsedS = elapsedSeconds();
    console.log(`[robinhood-courier] duration=${elapsedS.toFixed(1)}s ok — ${summary}`);
    const endClock = fmtClock(new Date());
    const fillsText = fillsCount > 0 ? `${fillsCount} fill${fillsCount === 1 ? "" : "s"} imported` : "no new fills";
    const budgetSeconds = CLAUDE_TIMEOUT_MS / 1000;
    const overBudgetLine =
      elapsedS > budgetSeconds * BUDGET_WARNING_RATIO
        ? ` ⚠️ ${Math.round(elapsedS)}s — ${Math.round((elapsedS / budgetSeconds) * 100)}% of the ${budgetSeconds}s budget, drifting close to the ceiling again.`
        : ` (${Math.round(elapsedS)}s)`;
    await finish(`🟢 ${endClock} — Robinhood courier finished, ${fillsText}.${overBudgetLine}\n${summary}`, {
      mention: overBudgetLine.includes("⚠️"),
    });
    writeState({ lastStatus: "ok", checkedAt: nowIso, consecutiveFailures: 0 });
  }

  // No hardcoded default — this repo is public and a Robinhood account
  // number has no safe truncation the way Schwab's last-3-digits
  // ACCOUNT_BROKER_MAP does. Lives only in the untracked .env.local.
  const ACCOUNT_NUMBER = process.env.ROBINHOOD_ACCOUNT_NUMBER ?? "";
  if (!ACCOUNT_NUMBER) {
    await fail("aborted", "ROBINHOOD_ACCOUNT_NUMBER not set in .env.local.");
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
      { encoding: "utf8", timeout: CLAUDE_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // ETIMEDOUT here means execFileSync's own `timeout` option killed a
    // process that HAD started and was still running past the budget —
    // not a process that failed to launch, and not a dead MCP
    // connection. `claude mcp list` checks the CLI's persistent server
    // registration, which has nothing to do with one invocation's own
    // round-trip latency — each headless call opens and tears down its
    // own MCP session fresh, so there's no persistent connection here
    // to be "reconnected."
    //
    // A bare "ETIMEDOUT" says a kill happened, not what the process was
    // doing when it was killed — a genuinely stuck call (hung on the
    // MCP round trip, zero progress) and one that's simply outgrown the
    // budget (real work, just slow) need different fixes, and the
    // message alone can't distinguish them. execFileSync's thrown error
    // carries .stdout/.stderr with whatever the child had written
    // before the kill (confirmed empirically, 2026-09-04) — surfacing
    // that turns "it timed out" into "it timed out after producing X"
    // or "it timed out having produced nothing."
    const code = (e as NodeJS.ErrnoException).code;
    const rawStdout = (e as { stdout?: string | Buffer | null }).stdout;
    const rawStderr = (e as { stderr?: string | Buffer | null }).stderr;
    const stdoutText = typeof rawStdout === "string" ? rawStdout : (rawStdout?.toString("utf8") ?? "");
    const stderrText = typeof rawStderr === "string" ? rawStderr : (rawStderr?.toString("utf8") ?? "");
    const captured =
      [
        stdoutText.trim() ? `stdout (${stdoutText.length} chars): ${truncateWithNote(stdoutText, 400)}` : null,
        stderrText.trim() ? `stderr (${stderrText.length} chars): ${truncateWithNote(stderrText, 400)}` : null,
      ]
        .filter((s): s is string => s !== null)
        .join(" | ") || "nothing captured — the process produced no stdout or stderr before being killed";

    if (code === "ETIMEDOUT") {
      await fail(`timed out after ${Math.round(CLAUDE_TIMEOUT_MS / 1000)}s`, captured);
    } else {
      await fail("headless Claude call failed", `${msg} (code=${code ?? "unknown"}). ${captured}`);
    }
    return;
  }

  let rawJson: string;
  try {
    rawJson = extractFirstJsonValue(stdout);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await fail(
      "output wasn't parseable JSON",
      `${msg} — nothing submitted. Raw output (${stdout.length} chars): ${truncateWithNote(stdout, 500)}`,
    );
    return;
  }

  let res: Response;
  try {
    res = await fetch(
      `${POLL_URL}?accountNumber=${encodeURIComponent(ACCOUNT_NUMBER)}&lookbackSince=${encodeURIComponent(lookbackSince)}&source=courier${runRowId ? `&runRowId=${encodeURIComponent(runRowId)}` : ""}`,
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
    await fail("POST to poll-transactions failed", msg);
    return;
  }

  // Read the raw body FIRST so a non-JSON or unparseable response
  // (e.g. a Vercel error page on a 500) still has its actual content
  // available for the alert, rather than silently collapsing to a
  // bare status code.
  const rawBody = await res.text().catch(() => "");
  let json: {
    ok?: boolean;
    report?: { ordersSeen: number; executionsSeen: number; executionsLanded: number; tradesSubmitted: number; skipped: number; errors: string[] };
    error?: string;
  } = {};
  try {
    json = JSON.parse(rawBody);
  } catch {
    // leave json empty — handled via rawBody below
  }

  // A non-2xx HTTP status is always a real failure — never content-
  // classified, regardless of what the body says.
  if (!res.ok) {
    const bodyPreview = rawBody.trim() ? truncateWithNote(rawBody, 500) : "(empty body)";
    await fail("import failed", `HTTP ${res.status}. Response: ${bodyPreview}`, { reachedServer: true });
    return;
  }

  if (!json.ok) {
    const allErrors = json.error ? [json.error] : (json.report?.errors ?? []);
    const detail =
      allErrors.length > 0
        ? allErrors.join("; ")
        : `ok=false with no error strings in the response (HTTP ${res.status}). Raw: ${truncateWithNote(rawBody, 400)}`;
    // No captured error strings despite ok=false is itself an anomaly
    // — classify as failed, not a silent "ok" via classifyErrors([]).
    const severity: Severity = allErrors.length > 0 ? classifyErrors(allErrors) : "failed";
    if (severity === "warning") {
      await warn(detail, allErrors.length);
      return;
    }
    await fail("import failed", detail, { reachedServer: true });
    return;
  }

  const r = json.report;
  await succeed(
    r?.tradesSubmitted ?? 0,
    `orders=${r?.ordersSeen ?? 0} executions=${r?.executionsSeen ?? 0} landed=${r?.executionsLanded ?? 0} submitted=${r?.tradesSubmitted ?? 0} skipped=${r?.skipped ?? 0}`,
  );
}

main().catch(async (e) => {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`[robinhood-courier] duration=${elapsedSeconds().toFixed(1)}s fatal: ${msg}`);
  try {
    const { sendDiscordAlert, editDiscordAlert } = await import("../lib/discord-alert");
    const prev = readState();
    const consecutiveFailures = (prev.consecutiveFailures ?? 0) + 1;
    const streak = consecutiveFailures > 1 ? ` (${ordinal(consecutiveFailures)} consecutive run)` : "";
    const endClock = fmtClock(new Date());
    const text = `🔴 ${endClock} — Robinhood courier fatal error${streak}.\n${msg}`;
    if (startMessageId) {
      const editRes = await editDiscordAlert(startMessageId, text);
      if (!editRes.ok) await sendDiscordAlert(text);
    } else {
      await sendDiscordAlert(text);
    }
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
        runRowId: runRowId ?? undefined,
      }),
    }).catch(() => {});
  } catch {
    // best-effort alert — don't mask the original failure
  }
  process.exitCode = 1;
});

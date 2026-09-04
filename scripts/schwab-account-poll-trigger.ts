// Local trigger for the Schwab Account Data 4x/day transaction poll —
// replaces the plain curl call ~/bin/csp-schwab-account-poll.sh used
// to make directly. Added after a 2026-08-24 incident: the poll
// silently failed for ~30 hours (a poisoned refresh token — see
// lib/schwab-account.ts's refreshAcctAccessTokenWithRetry comment)
// with zero notification, since only the WEEKLY Saturday health check
// alerts, and it had already run days before the failure started.
// Discord alerting runs from here (a local script using .env.local),
// not from the deployed route itself, mirroring the proven-working
// scripts/schwab-weekly-health.ts pattern. (One deployed route now
// posts its own alert too — app/api/robinhood-account/poll-transactions
// — added 2026-09-04 specifically to cover calls that bypass the
// courier. That route requires DISCORD_WEBHOOK_URL/DISCORD_PING_USER_ID
// in Vercel's production env, same names as .env.local.)
//
// One Discord message per run, posted at start and edited in place at
// completion — not silence-until-transition (which made "still
// failing," "ran clean," and "never fired" indistinguishable — a
// 2026-09-04 Robinhood incident showed this exact failure mode) and
// not two separate messages per run (the start and end of one run are
// the same event, not two pieces of information). The state file is
// kept only to track consecutiveFailures for the "(Nth consecutive
// run)" label, never to decide whether to post. Unlike the Robinhood
// courier, this script has no multi-minute in-flight window (the
// entire poll is one synchronous HTTP call that normally finishes in
// seconds) and no comparable timeout ceiling that's been drifting, so
// it doesn't get a "running" row on the Positions page or a
// budget-warning check — there's nothing here for either to detect.
//
// Run via com.csp.schwab-account-poll launchd agent, weekdays.
// Usage: npx tsx scripts/schwab-account-poll-trigger.ts
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

function loadEnvLocal(): void {
  const content = readFileSync(resolve(process.cwd(), ".env.local"), "utf8");
  for (const line of content.split("\n")) {
    const eq = line.indexOf("=");
    if (eq === -1 || line.trim().startsWith("#")) continue;
    const k = line.slice(0, eq).trim();
    if (!process.env[k]) process.env[k] = line.slice(eq + 1).trim();
  }
}

let startMessageId: string | null = null;

const STATE_DIR = resolve(homedir(), "Library/Application Support/csp-screener");
const STATE_PATH = resolve(STATE_DIR, "schwab-account-poll-state.json");
const POLL_URL = "https://csp-screener.vercel.app/api/schwab-account/poll-transactions";
const RECONNECT_URL = "https://csp-screener.vercel.app/settings";

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

type PollResponse = {
  ok?: boolean;
  error?: string;
  reports?: Array<{
    broker: string;
    ok: boolean;
    errors: string[];
    transactionsSeen?: number;
    tradesSubmitted?: number;
    expirationsRecorded?: number;
    assignmentsRecorded?: number;
    skipped?: number;
  }>;
};

// A closing fill with no matching open position on file isn't a
// broken poller — it means the trade isn't part of a position this
// app tracks (a different strategy on the same brokerage account,
// e.g. the ELF/CRM/NOW cases). Per the user's explicit correction
// (2026-08-27): "error to me means something is broken... if it
// couldn't import due to not being a CSP [position], it should be a
// warning." Still surfaces (via the activity review panel + this
// alert, no mention) and still needs a manual Dismiss — this only
// softens the alert's tone, never the underlying "always surface,
// never silently ignore" behavior for off-strategy trades. Matches
// the exact error text lib/bulk-create-trades.ts and
// lib/schwab-account-import.ts both produce for this case.
function classifyErrors(errors: string[]): Severity {
  if (errors.length === 0) return "ok";
  return errors.every((e) => /no matching open position|no open stock_long position/i.test(e))
    ? "warning"
    : "failed";
}

async function main() {
  loadEnvLocal();
  const { sendDiscordAlert, editDiscordAlert } = await import("../lib/discord-alert");

  const prev = readState();
  const nowIso = new Date().toISOString();

  const startClock = fmtClock(new Date());
  const startPost = await sendDiscordAlert(`🔵 ${startClock} — Schwab Account Data poll starting`, {
    mention: false,
    returnId: true,
  });
  startMessageId = startPost.messageId ?? null;

  async function finish(text: string, opts?: { mention?: boolean }): Promise<void> {
    if (startMessageId) {
      const res = await editDiscordAlert(startMessageId, text, opts);
      if (res.ok) return;
    }
    await sendDiscordAlert(text, opts);
  }

  async function fail(outcomePhrase: string, detail: string): Promise<void> {
    console.error(`[schwab-account-poll-trigger] ${outcomePhrase}: ${detail}`);
    const consecutiveFailures = (prev.consecutiveFailures ?? 0) + 1;
    const streak = consecutiveFailures > 1 ? ` (${ordinal(consecutiveFailures)} consecutive run)` : "";
    const endClock = fmtClock(new Date());
    await finish(
      `🔴 ${endClock} — Schwab Account Data poll ${outcomePhrase}${streak}.\n${detail}\nReconnect: ${RECONNECT_URL}`,
    );
    writeState({ lastStatus: "failed", checkedAt: nowIso, detail, consecutiveFailures });
    process.exitCode = 1;
  }
  async function warn(detail: string, count: number): Promise<void> {
    console.warn(`[schwab-account-poll-trigger] warning: ${detail}`);
    const endClock = fmtClock(new Date());
    await finish(
      `🟡 ${endClock} — Schwab Account Data poll finished: ${count} trade(s) couldn't auto-import — not part of a tracked position. Review and Dismiss in the activity panel.\n${detail}`,
      { mention: false },
    );
    writeState({ lastStatus: "warning", checkedAt: nowIso, detail, consecutiveFailures: 0 });
    // Not a script failure — the poll itself ran fine; this is a
    // data-level heads-up, not an execution error, so the exit code
    // stays 0.
  }
  async function succeed(summary: string): Promise<void> {
    console.log(`[schwab-account-poll-trigger] ${summary}`);
    const endClock = fmtClock(new Date());
    await finish(`🟢 ${endClock} — Schwab Account Data poll finished — ${summary}`, { mention: false });
    writeState({ lastStatus: "ok", checkedAt: nowIso, consecutiveFailures: 0 });
  }

  let res: Response;
  try {
    res = await fetch(POLL_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.CRON_SECRET ?? ""}` },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await fail("request failed", msg);
    return;
  }

  // Read the raw body FIRST so a non-JSON or unparseable response
  // (e.g. a Vercel error page on a 500) still has its actual content
  // available for the alert, rather than silently collapsing to a
  // bare status code.
  const rawBody = await res.text().catch(() => "");
  let json: PollResponse = {};
  try {
    json = JSON.parse(rawBody);
  } catch {
    // leave json empty — handled via rawBody below
  }
  console.log(`[schwab-account-poll-trigger] ${nowIso} status=${res.status} ok=${json.ok}`);

  // A non-2xx HTTP status (e.g. the route's own 500 on a fatal
  // exception) is always a real failure — never content-classified,
  // regardless of what the body says.
  if (!res.ok) {
    const bodyPreview = rawBody.trim() ? truncateWithNote(rawBody, 500) : "(empty body)";
    await fail("failed", `HTTP ${res.status}. Response: ${bodyPreview}`);
    return;
  }

  if (!json.ok) {
    const allErrors = json.error
      ? [json.error]
      : (json.reports ?? []).filter((r) => !r.ok).flatMap((r) => r.errors);
    const detail =
      allErrors.length > 0
        ? ((json.reports ?? [])
            .filter((r) => !r.ok)
            .map((r) => `${r.broker}: ${r.errors.join("; ")}`)
            .join(" | ") || allErrors.join("; "))
        : `ok=false with no error strings in the response (HTTP ${res.status}). Raw: ${truncateWithNote(rawBody, 400)}`;
    // No captured error strings despite ok=false is itself an
    // anomaly — classify as failed, not a silent "ok" via an empty
    // classifyErrors([]) call.
    const severity: Severity = allErrors.length > 0 ? classifyErrors(allErrors) : "failed";

    if (severity === "warning") {
      await warn(detail, allErrors.length);
      return;
    }
    await fail("failed", detail);
    return;
  }

  const reports = json.reports ?? [];
  const totalTrades = reports.reduce((s, r) => s + (r.tradesSubmitted ?? 0), 0);
  const summary =
    reports.map((r) => `${r.broker}: seen=${r.transactionsSeen ?? 0} trades=${r.tradesSubmitted ?? 0}`).join(", ") ||
    "no accounts reported";
  await succeed(`${totalTrades} trade(s) imported — ${summary}`);
}

main().catch(async (e) => {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`[schwab-account-poll-trigger] fatal: ${msg}`);
  try {
    const { sendDiscordAlert, editDiscordAlert } = await import("../lib/discord-alert");
    const prev = readState();
    const consecutiveFailures = (prev.consecutiveFailures ?? 0) + 1;
    const streak = consecutiveFailures > 1 ? ` (${ordinal(consecutiveFailures)} consecutive run)` : "";
    const endClock = fmtClock(new Date());
    const text = `🔴 ${endClock} — Schwab Account Data poll fatal error${streak}.\n${msg}`;
    if (startMessageId) {
      const editRes = await editDiscordAlert(startMessageId, text);
      if (!editRes.ok) await sendDiscordAlert(text);
    } else {
      await sendDiscordAlert(text);
    }
    writeState({ lastStatus: "failed", checkedAt: new Date().toISOString(), detail: msg, consecutiveFailures });
  } catch {
    // best-effort alert — don't mask the original failure
  }
  process.exitCode = 1;
});

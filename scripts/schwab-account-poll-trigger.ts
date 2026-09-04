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
// This job runs 4x/day, not continuously — transition-only dedup
// (alert on ok->failed but stay silent while failed persists) makes
// "still failing," "ran clean," and "never fired" all indistinguishable
// from Discord. Every run now posts its outcome; the state file is kept
// only to track consecutiveFailures for the "(Nth consecutive run)"
// label, not to decide whether to send. The one exception is the
// WARNING severity: a trade the poller can't match to a tracked
// position (off-strategy, or opened outside this app) means a trade is
// sitting undismissed in the activity panel — a standing fact that
// doesn't change run to run the way "did the poll work this cycle"
// does, so warning stays transition-deduped (surfaced once, no
// mention) rather than re-alerting every run it sits there. See
// classifyErrors below.
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
  // alerts regardless of this count, see main() below.
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
  const { sendDiscordAlert } = await import("../lib/discord-alert");

  const prev = readState();
  const nowIso = new Date().toISOString();

  async function fail(detail: string): Promise<void> {
    console.error(`[schwab-account-poll-trigger] failed: ${detail}`);
    const consecutiveFailures = (prev.consecutiveFailures ?? 0) + 1;
    const streak = consecutiveFailures > 1 ? ` (${ordinal(consecutiveFailures)} consecutive run)` : "";
    await sendDiscordAlert(`🔴 Schwab Account Data poll failing${streak}: ${detail}\nReconnect: ${RECONNECT_URL}`);
    writeState({ lastStatus: "failed", checkedAt: nowIso, detail, consecutiveFailures });
    process.exitCode = 1;
  }
  // Transition-deduped, unlike fail()/succeed() — a warning means a
  // trade is sitting undismissed in the activity panel, a standing
  // fact that doesn't change run to run, so re-alerting every 2 hours
  // it sits there would just be noise. See the header comment.
  async function warn(detail: string, count: number): Promise<void> {
    console.warn(`[schwab-account-poll-trigger] warning: ${detail}`);
    if (prev.lastStatus !== "warning") {
      await sendDiscordAlert(
        `🟡 Schwab Account Data poll: ${count} trade(s) couldn't auto-import because they aren't part of a tracked position — not necessarily broken, just off-strategy or opened outside this app. Review and Dismiss in the activity panel.\n${detail}`,
        { mention: false },
      );
    }
    writeState({ lastStatus: "warning", checkedAt: nowIso, detail, consecutiveFailures: 0 });
    // Not a script failure — the poll itself ran fine; this is a
    // data-level heads-up, not an execution error, so the exit code
    // stays 0.
  }
  async function succeed(summary: string): Promise<void> {
    console.log(`[schwab-account-poll-trigger] ${summary}`);
    const prefix =
      prev.lastStatus === "failed"
        ? "🟢 Schwab Account Data poll recovered — connectivity restored.\n"
        : prev.lastStatus === "warning"
          ? "🟢 Schwab Account Data poll recovered from data warnings — no action was needed.\n"
          : "🟢 Schwab Account Data poll ok — ";
    await sendDiscordAlert(`${prefix}${summary}`, { mention: false });
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
    await fail(`request failed (${msg}).`);
    return;
  }

  const json = (await res.json().catch(() => ({}))) as PollResponse;
  console.log(`[schwab-account-poll-trigger] ${nowIso} status=${res.status} ok=${json.ok}`);

  // A non-2xx HTTP status (e.g. the route's own 500 on a fatal
  // exception) is always a real failure — never content-classified,
  // regardless of what the body says.
  if (!res.ok) {
    const detail = json.error ?? `HTTP ${res.status}`;
    await fail(detail);
    return;
  }

  if (!json.ok) {
    const allErrors = json.error
      ? [json.error]
      : (json.reports ?? []).filter((r) => !r.ok).flatMap((r) => r.errors);
    const detail =
      json.error ??
      ((json.reports ?? [])
        .filter((r) => !r.ok)
        .map((r) => `${r.broker}: ${r.errors.join("; ")}`)
        .join(" | ") ||
        `ok=false with no error detail (HTTP ${res.status})`);
    // No captured error strings despite ok=false is itself an
    // anomaly — classify as failed, not a silent "ok" via an empty
    // classifyErrors([]) call.
    const severity: Severity = allErrors.length > 0 ? classifyErrors(allErrors) : "failed";

    if (severity === "warning") {
      await warn(detail, allErrors.length);
      return;
    }
    await fail(detail);
    return;
  }

  const reports = json.reports ?? [];
  const totalTrades = reports.reduce((s, r) => s + (r.tradesSubmitted ?? 0), 0);
  const summary =
    reports.map((r) => `${r.broker}: seen=${r.transactionsSeen ?? 0} trades=${r.tradesSubmitted ?? 0}`).join(", ") ||
    "no accounts reported";
  await succeed(`${totalTrades} trade(s) imported — ${summary}`);
}

main().catch((e) => {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`[schwab-account-poll-trigger] fatal: ${msg}`);
  process.exitCode = 1;
});

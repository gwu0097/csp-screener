// Local trigger for the Schwab Account Data 4x/day transaction poll —
// replaces the plain curl call ~/bin/csp-schwab-account-poll.sh used
// to make directly. Added after a 2026-08-24 incident: the poll
// silently failed for ~30 hours (a poisoned refresh token — see
// lib/schwab-account.ts's refreshAcctAccessTokenWithRetry comment)
// with zero notification, since only the WEEKLY Saturday health check
// alerts, and it had already run days before the failure started.
// Discord alerting runs from here (a local script using .env.local),
// not from the deployed route itself — no app/api/* route in this
// codebase posts to Discord, so Vercel's runtime env isn't confirmed
// to have DISCORD_WEBHOOK_URL set; this mirrors the proven-working
// scripts/schwab-weekly-health.ts pattern instead of assuming that.
//
// Alerts only on a state transition (ok/warning/failed), not on every
// run in a bad state — a known-broken connection would otherwise spam
// Discord 4x/day until reconnected. Three severities, not two: a
// trade the poller can't match to a tracked position (off-strategy,
// or opened outside this app) is a "warning" — surfaced, no mention —
// distinct from a "failed" run where something is actually broken
// (dead token, network failure, a real bug). See classifyErrors below.
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
type State = { lastStatus: Severity | "unknown"; checkedAt: string; detail?: string };

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
  reports?: Array<{ broker: string; ok: boolean; errors: string[] }>;
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
  return errors.every((e) => /no matching open position/i.test(e)) ? "warning" : "failed";
}

async function main() {
  loadEnvLocal();
  const { sendDiscordAlert } = await import("../lib/discord-alert");

  const prev = readState();
  const nowIso = new Date().toISOString();

  let res: Response;
  try {
    res = await fetch(POLL_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.CRON_SECRET ?? ""}` },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[schwab-account-poll-trigger] request failed: ${msg}`);
    if (prev.lastStatus !== "failed") {
      await sendDiscordAlert(`🔴 Schwab Account Data poll: request failed (${msg}).`);
    }
    writeState({ lastStatus: "failed", checkedAt: nowIso, detail: msg });
    process.exitCode = 1;
    return;
  }

  const json = (await res.json().catch(() => ({}))) as PollResponse;
  console.log(`[schwab-account-poll-trigger] ${nowIso} status=${res.status} ok=${json.ok}`);

  // A non-2xx HTTP status (e.g. the route's own 500 on a fatal
  // exception) is always a real failure — never content-classified,
  // regardless of what the body says.
  if (!res.ok) {
    const detail = json.error ?? `HTTP ${res.status}`;
    console.error(`[schwab-account-poll-trigger] failed: ${detail}`);
    if (prev.lastStatus !== "failed") {
      await sendDiscordAlert(`🔴 Schwab Account Data poll failing: ${detail}\nReconnect: ${RECONNECT_URL}`);
    }
    writeState({ lastStatus: "failed", checkedAt: nowIso, detail });
    process.exitCode = 1;
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
      console.warn(`[schwab-account-poll-trigger] warning: ${detail}`);
      if (prev.lastStatus !== "warning") {
        await sendDiscordAlert(
          `🟡 Schwab Account Data poll: ${allErrors.length} trade(s) couldn't auto-import because they aren't part of a tracked position — not necessarily broken, just off-strategy or opened outside this app. Review and Dismiss in the activity panel.\n${detail}`,
          { mention: false },
        );
      }
      writeState({ lastStatus: "warning", checkedAt: nowIso, detail });
      // Not a script failure — the poll itself ran fine; this is a
      // data-level heads-up, not an execution error, so the exit code
      // stays 0.
      return;
    }

    console.error(`[schwab-account-poll-trigger] failed: ${detail}`);
    if (prev.lastStatus !== "failed") {
      await sendDiscordAlert(`🔴 Schwab Account Data poll failing: ${detail}\nReconnect: ${RECONNECT_URL}`);
    }
    writeState({ lastStatus: "failed", checkedAt: nowIso, detail });
    process.exitCode = 1;
    return;
  }

  if (prev.lastStatus === "failed" || prev.lastStatus === "warning") {
    await sendDiscordAlert("🟢 Schwab Account Data poll recovered — back to normal.", { mention: false });
  }
  writeState({ lastStatus: "ok", checkedAt: nowIso });
}

main().catch((e) => {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`[schwab-account-poll-trigger] fatal: ${msg}`);
  process.exitCode = 1;
});

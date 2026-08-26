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
// Alerts only on a state transition (ok -> failing, failing -> ok),
// not on every failed run — a known-broken connection would otherwise
// spam Discord 4x/day until reconnected.
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

type PollResponse = {
  ok?: boolean;
  error?: string;
  reports?: Array<{ broker: string; ok: boolean; errors: string[] }>;
};

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

  if (!res.ok || !json.ok) {
    const detail =
      json.error ??
      json.reports
        ?.filter((r) => !r.ok)
        .map((r) => `${r.broker}: ${r.errors.join("; ")}`)
        .join(" | ") ??
      `HTTP ${res.status}`;
    console.error(`[schwab-account-poll-trigger] failed: ${detail}`);
    if (prev.lastStatus !== "failed") {
      await sendDiscordAlert(`🔴 Schwab Account Data poll failing: ${detail}\nReconnect: ${RECONNECT_URL}`);
    }
    writeState({ lastStatus: "failed", checkedAt: nowIso, detail });
    process.exitCode = 1;
    return;
  }

  if (prev.lastStatus === "failed") {
    await sendDiscordAlert("🟢 Schwab Account Data poll recovered — back to normal.", { mention: false });
  }
  writeState({ lastStatus: "ok", checkedAt: nowIso });
}

main().catch((e) => {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`[schwab-account-poll-trigger] fatal: ${msg}`);
  process.exitCode = 1;
});

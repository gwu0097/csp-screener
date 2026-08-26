// Weekend Schwab token health check. Attempts a LIVE refresh-token
// exchange (lib/schwab.forceRefreshToken) — does not trust
// isSchwabConnected() or the stored expiry, since a dead refresh
// token can otherwise sit undetected for up to a week (see
// forceRefreshToken's doc comment). Silent on a routine healthy
// check; Discord alert only on failure, and a recovery confirmation
// the next time it succeeds after a prior failure.
//
// Run via com.csp.schwab-health launchd agent, Saturdays only.
// Usage: npx tsx scripts/schwab-weekly-health.ts
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
const STATE_PATH = resolve(STATE_DIR, "schwab-health-state.json");
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

async function main() {
  loadEnvLocal();
  const { forceRefreshToken } = await import("../lib/schwab");
  const { sendDiscordAlert } = await import("../lib/discord-alert");

  const prev = readState();
  const nowIso = new Date().toISOString();
  console.log(`[${nowIso}] weekly Schwab health check — prev status: ${prev.lastStatus}`);

  const result = await forceRefreshToken();

  if (result.ok) {
    console.log(
      `refresh OK — refreshTokenChanged=${result.refreshTokenChanged} newExpiry=${result.newRefreshExpiresAt}`,
    );
    if (prev.lastStatus === "failed") {
      const msg =
        `✅ Schwab reconnected successfully.\n` +
        `Live refresh verified working just now. Refresh token now valid until ${result.newRefreshExpiresAt}.`;
      const sent = await sendDiscordAlert(msg, { mention: false });
      console.log(`recovery alert sent: ${sent.ok}${sent.error ? ` (${sent.error})` : ""}`);
    }
    writeState({ lastStatus: "ok", checkedAt: nowIso });
  } else {
    const daysTxt =
      result.daysRemainingBeforeAttempt === null
        ? "unknown"
        : result.daysRemainingBeforeAttempt.toFixed(1);
    console.error(
      `refresh FAILED — error=${result.error} hadStoredExpiry=${result.hadStoredExpiry} daysRemainingBeforeAttempt=${daysTxt}`,
    );
    const msg =
      `⚠️ Schwab weekly health check FAILED — live token refresh did not succeed.\n\n` +
      `Error: ${result.error}\n` +
      (result.hadStoredExpiry
        ? `Stored records said the refresh token was valid until ${result.hadStoredExpiry} (${daysTxt} days remaining) — but Schwab rejected it live just now, so that stored value can't be trusted.\n\n`
        : `Schwab was never connected (no token on file).\n\n`) +
      `Reconnect: ${RECONNECT_URL}`;
    const sent = await sendDiscordAlert(msg);
    console.log(`failure alert sent: ${sent.ok}${sent.error ? ` (${sent.error})` : ""}`);
    writeState({ lastStatus: "failed", checkedAt: nowIso, detail: result.error });
  }
}

main().catch((e) => {
  console.error("[schwab-weekly-health] fatal:", e);
  process.exit(1);
});

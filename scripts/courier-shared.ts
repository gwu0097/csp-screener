// Shared plumbing for the local Robinhood couriers — the option-fill
// courier (scripts/robinhood-courier.ts) and the earnings-calendar
// courier (scripts/robinhood-earnings-courier.ts). Both run headless
// `claude -p` under launchd to reach the Robinhood MCP, extract JSON
// from stdout and POST it to a CRON_SECRET-gated route.
//
// Lives under scripts/, not lib/, on purpose: the couriers still import
// nothing from the server-side lib except lib/discord-alert (and the
// pure, I/O-free lib/robinhood-calendar-validate), so a
// courier failure can't be traced to an import-time coupling with
// server code. Node built-ins only here.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { execFileSync } from "node:child_process";

export const CLAUDE_BIN = "/Users/raitsai/.local/bin/claude";

export function loadEnvLocal(): void {
  const content = readFileSync(resolve(process.cwd(), ".env.local"), "utf8");
  for (const line of content.split("\n")) {
    const eq = line.indexOf("=");
    if (eq === -1 || line.trim().startsWith("#")) continue;
    const k = line.slice(0, eq).trim();
    if (!process.env[k]) process.env[k] = line.slice(eq + 1).trim();
  }
}

// Wall-clock from process start to whichever exit path fires. Create it
// at module level, not inside main() — the outer main().catch() fatal
// handler needs the same clock, and a fatal error can happen before
// main()'s own local timer would exist.
export function createRunClock(): { startedAt: number; elapsedSeconds: () => number } {
  const startedAt = Date.now();
  return { startedAt, elapsedSeconds: () => (Date.now() - startedAt) / 1000 };
}

export function ordinal(n: number): string {
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

// "1:05pm" — no leading zero on the hour, no space before am/pm. The
// couriers run on the user's own Mac via launchd, so the system's local
// timezone (not UTC) is exactly the right one to render in.
export function fmtClock(d: Date): string {
  let h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? "pm" : "am";
  h = h % 12 || 12;
  return `${h}:${String(m).padStart(2, "0")}${ampm}`;
}

export function truncateWithNote(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return `${s.slice(0, maxLen)}... [truncated, ${s.length} chars total]`;
}

export type Severity = "ok" | "warning" | "failed";
export type CourierState = {
  lastStatus: Severity | "unknown";
  checkedAt: string;
  detail?: string;
  // Runs of consecutive failed statuses, reset to 0 on anything else.
  // Used only to label "(Nth consecutive run)" — every failed run
  // alerts regardless of this count.
  consecutiveFailures?: number;
};

export function readState(path: string): CourierState {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as CourierState;
  } catch {
    return { lastStatus: "unknown", checkedAt: "" };
  }
}
export function writeState(path: string, s: CourierState): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(s, null, 2));
}

// Brace/bracket-counting extraction, not a fence regex — see the
// identical helper in lib/robinhood-account-import.ts (server-side,
// where the 2026-08-26 parse failure actually happened). Accepts either
// a top-level object or array as the first JSON value in the text,
// since a "no prose" instruction is not a guarantee Claude never wraps
// its answer.
export function extractFirstJsonValue(text: string): string {
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

export type ClaudeRunResult = { ok: true; stdout: string } | { ok: false; outcomePhrase: string; detail: string };

/** Runs `claude -p <prompt> --allowedTools <tool>` synchronously. On
 * failure returns the alert headline phrase and a detail that includes
 * whatever the child wrote before dying. */
export function runHeadlessClaude(prompt: string, allowedTool: string, timeoutMs: number): ClaudeRunResult {
  try {
    const stdout = execFileSync(CLAUDE_BIN, ["-p", prompt, "--allowedTools", allowedTool], {
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { ok: true, stdout };
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
      return { ok: false, outcomePhrase: `timed out after ${Math.round(timeoutMs / 1000)}s`, detail: captured };
    }
    return { ok: false, outcomePhrase: "headless Claude call failed", detail: `${msg} (code=${code ?? "unknown"}). ${captured}` };
  }
}

// Login expiry needs a human, so the alert names it in the headline (it's
// what the phone notification shows) instead of leaving it inside the raw
// CLI error. Claude's own login: refresh ~/.config/robinhood-agent/
// claude_oauth_token via `claude setup-token`. Robinhood's: /mcp.
export function authExpiry(detail: string): { expired: boolean; line: string } {
  const expired = /OAuth session expired|Failed to authenticate|Needs authentication|401|unauthori[sz]ed/i.test(detail);
  const line = expired
    ? "🔑 LOGIN EXPIRED — re-authenticate: Robinhood via `claude` → /mcp → robinhood; if the error says \"Failed to authenticate\", Claude's own token: `claude setup-token` → ~/.config/robinhood-agent/claude_oauth_token.\n"
    : "";
  return { expired, line };
}

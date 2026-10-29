// Real earnings date for a sandbox ("Test any ticker") run. Pure — no
// I/O — so the selection rules are unit-testable
// (lib/sandbox-earnings.test.ts). The analyze-single route feeds it the
// symbol's earnings_history rows near today.
//
// Without this the sandbox used today's date as a stand-in, so the
// Analysis Dump header claimed "earnings today, after close" and the
// paste-back box looked up a (symbol, today) analysis that never
// exists — a ticker that printed yesterday showed "No analysis saved"
// even though its analysis was on file.

export type SandboxEarningsRow = { earnings_date: string; timing: string | null };

export type SandboxEarnings = {
  earningsDate: string;
  timing: "BMO" | "AMC";
  // Saved timing was missing or unrecognised; AMC is assumed.
  timingAssumed: boolean;
};

// How far either side of today a stored print still counts as "this
// event": a week back covers the post-print week the sandbox is mostly
// used in; three weeks ahead covers an upcoming print outside the
// screener's own earnings window.
export const SANDBOX_LOOKBACK_DAYS = 7;
export const SANDBOX_LOOKAHEAD_DAYS = 21;

function dayNumber(iso: string): number {
  return Math.round(Date.parse(iso.slice(0, 10) + "T00:00:00Z") / 86400000);
}

// Nearest stored print within the window; on a tie the upcoming one
// wins. null = no print near today (the caller keeps its stand-in date
// and must not save anything against it).
export function resolveSandboxEarnings(
  todayIso: string,
  rows: readonly SandboxEarningsRow[],
): SandboxEarnings | null {
  const today = dayNumber(todayIso);
  let best: { row: SandboxEarningsRow; dist: number; upcoming: boolean } | null = null;
  for (const row of rows) {
    if (!/^\d{4}-\d{2}-\d{2}/.test(row.earnings_date)) continue;
    const offset = dayNumber(row.earnings_date) - today;
    if (offset < -SANDBOX_LOOKBACK_DAYS || offset > SANDBOX_LOOKAHEAD_DAYS) continue;
    const dist = Math.abs(offset);
    const upcoming = offset >= 0;
    if (!best || dist < best.dist || (dist === best.dist && upcoming && !best.upcoming)) {
      best = { row, dist, upcoming };
    }
  }
  if (!best) return null;
  const t = best.row.timing?.toLowerCase();
  return {
    earningsDate: best.row.earnings_date.slice(0, 10),
    timing: t === "bmo" ? "BMO" : "AMC",
    timingAssumed: t !== "bmo" && t !== "amc",
  };
}

// Weekly expiry that captures the print's reaction: the Friday on or
// after a BMO print, the Friday strictly after an AMC one (an AMC
// Friday print reacts the following Monday) — and never earlier than
// the next Friday after today, since a past expiry has no chain.
export function sandboxExpiryFor(todayIso: string, earnings: SandboxEarnings): string {
  const fridayFrom = (iso: string, strictlyAfter: boolean): number => {
    let d = dayNumber(iso) + (strictlyAfter ? 1 : 0);
    // 1970-01-01 (day 0) was a Thursday, so Friday ≡ 1 (mod 7).
    while (((d % 7) + 7) % 7 !== 1) d += 1;
    return d;
  };
  const fromPrint = fridayFrom(earnings.earningsDate, earnings.timing === "AMC");
  const fromToday = fridayFrom(todayIso, true);
  return new Date(Math.max(fromPrint, fromToday) * 86400000).toISOString().slice(0, 10);
}

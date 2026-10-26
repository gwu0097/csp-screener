// Which T0/T1 crush-capture outcomes count as failures in the health
// rollup and the capture-health panel. Pure — no I/O — so the rules are
// unit-testable (lib/crush-capture-outcomes.test.ts). Shared by the
// rollup writer (lib/earnings-capture.ts) and the panel route
// (app/api/capture-health/crush/route.ts) so the two can't disagree.

// Benign, expected skip reasons — never real failures. Same vocabulary
// returned by captureEarningsT0/T1 (see CaptureItem).
// premature_capture_session is T0's session guard declining a candidate
// outside its one valid session (AMC due tomorrow, or a BMO already
// printed) — the correctly-timed run owns it, so counting it only
// double-reported the same event as "failed" on its neighbouring days.
export const BENIGN_SKIP_REASONS: ReadonlySet<string> = new Set([
  "already_captured",
  "manual_row",
  "row_not_found",
  "no_t0_data",
  "premature_capture_session",
]);

// Not finished yet, and the job retries it on its own: the post-print
// IV hasn't dropped below the T0 baseline at this read. A row that
// never gets there is aged out by markT1RowsUnrecoverable (or caught
// sooner by checkAndMarkCorruptedBaseline) and shows up as
// unrecoverable then — counting every interim retry as "failed" turned
// the panel amber on days where nothing was wrong.
export const RETRYING_REASONS: ReadonlySet<string> = new Set(["too_early_capture"]);

// Counted in its own column (schwab_disconnected), not as errored.
const SCHWAB_DISCONNECTED = "schwab_disconnected";

// True for a skip reason that means the pipeline actually failed on
// this event. A missing or unrecognised reason is treated as a failure
// (fail closed): an unknown state should surface, not hide.
export function isCrushCaptureFailure(reason: string | null | undefined): boolean {
  if (!reason) return true;
  if (reason === SCHWAB_DISCONNECTED) return false;
  if (BENIGN_SKIP_REASONS.has(reason)) return false;
  if (RETRYING_REASONS.has(reason)) return false;
  return true;
}

export type OutstandingEvent = { symbol: string; earnings_date: string | null };
export type AttemptOutcome = { symbol: string; earnings_date: string; outcome: string };

// Failed count for one stored T1 day rollup, re-judged against the
// attempt log. Rollups written before RETRYING_REASONS existed listed
// too_early_capture retries in `outstanding`; an event only counts as
// failed if one of its recorded attempts is a real failure. An event
// with no recorded attempts (or no date) stays failed — unknown is not
// assumed fine.
export function t1DayFailedCount(
  outstanding: readonly OutstandingEvent[],
  attempts: readonly AttemptOutcome[],
): number {
  const byEvent = new Map<string, string[]>();
  for (const a of attempts) {
    const key = `${a.symbol.toUpperCase()}|${a.earnings_date}`;
    const list = byEvent.get(key);
    if (list) list.push(a.outcome);
    else byEvent.set(key, [a.outcome]);
  }
  let failed = 0;
  for (const o of outstanding) {
    if (!o.earnings_date) {
      failed += 1;
      continue;
    }
    const outcomes = byEvent.get(`${o.symbol.toUpperCase()}|${o.earnings_date}`);
    if (!outcomes || outcomes.length === 0) {
      failed += 1;
      continue;
    }
    if (outcomes.some((r) => r !== "captured" && isCrushCaptureFailure(r))) failed += 1;
  }
  return failed;
}

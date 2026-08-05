// Shared session-eligibility check for capturing a post-earnings
// reaction against a live Schwab quote or Yahoo daily bar. Lives in
// its own file, outside both lib/earnings-capture.ts and
// lib/encyclopedia.ts, specifically to avoid a circular import
// between them — encyclopedia.ts imports from earnings-capture.ts in
// the other direction (captureEarningsT0/T1, buildMaintenanceSymbolSets),
// and this predicate is needed on both sides: earnings-capture.ts's T1
// selector, encyclopedia.ts's runEncyclopediaMaintenance duplicate T1
// pass, and encyclopedia.ts's updateEncyclopedia Finnhub ingest loop
// all have to apply the IDENTICAL rule or the same-session-AMC
// contamination bug (fixed 2026-08-05) just reopens somewhere else.
//
// Session gate, not date gate. BMO: the print already happened before
// today's open, so same-day (earnings_date === todayEt) capture is
// correct. AMC (or unknown timing, treated conservatively as AMC): the
// print hasn't happened yet as of this morning if earnings_date ===
// todayEt, so the earliest eligible capture is the NEXT session
// (earnings_date < todayEt). Deliberately NOT a blanket "exclude
// earnings_date === today" filter — that would also break same-day
// BMO capture, which must keep working.
export function isT1SessionEligible(
  row: { earnings_date: string; timing: string | null },
  todayEt: string,
): boolean {
  const timing = (row.timing ?? "unknown").toLowerCase();
  if (timing === "bmo") return row.earnings_date <= todayEt;
  return row.earnings_date < todayEt;
}

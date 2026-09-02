// Resolves/confirms an earnings_date against SEC EDGAR's submissions API
// (the 8-K filing index) — the other half of the shared EDGAR
// integration built 2026-09-04 alongside lib/edgar-fiscal-period.ts.
// Shares lib/edgar-client.ts's CIK map, rate limiter, and User-Agent.
//
// Not wired into any write path yet — built for the separate queued
// "resolve earnings dates for stub rows" work, which is out of scope
// for the 2026-09-04 fiscal_quarter/eps repair. Kept in the same build
// specifically so both EDGAR integrations share one client instead of
// two independent ones drifting apart.
//
// An 8-K's own reportDate/filingDate reflect the ANNOUNCEMENT, not the
// fiscal quarter it covers (verified live, 2026-09-04) — this caller is
// for date confidence only. Never use it to resolve fiscal_quarter/
// fiscal_year/period_end; that's lib/edgar-fiscal-period.ts's job.
import { resolveCik, edgarGet, daysBetween } from "./edgar-client";
import type { EdgarResult } from "./edgar-client";

type SubmissionsResponse = {
  filings: {
    recent: {
      form: string[];
      filingDate: string[];
      reportDate: string[];
      primaryDocument: string[];
    };
  };
};

export type EdgarEightK = {
  filingDate: string;
  reportDate: string;
  primaryDocument: string;
  gapDays: number;
};

// Nearest 8-K's own reportDate is what should confirm/correct
// earnings_date — a bounded ±10 day window since this is meant to
// verify a date already believed close to correct, not discover an
// unknown one from scratch (SEC's `submissions` API also only returns
// "recent" filings by default; a full backfill of very old rows would
// need the paginated /submissions/CIK##########-submissions-{n}.json
// files this function doesn't fetch).
export async function resolveNearestEightK(
  symbol: string,
  approxDate: string,
): Promise<EdgarResult<EdgarEightK>> {
  const cikResult = await resolveCik(symbol);
  if (!cikResult.resolved) return cikResult;
  const cik = cikResult.value;

  const url = `https://data.sec.gov/submissions/CIK${cik}.json`;
  const result = await edgarGet<SubmissionsResponse>(url);
  if (!result.resolved) return result;

  const { form, filingDate, reportDate, primaryDocument } = result.value.filings.recent;
  let best: EdgarEightK | null = null;
  let bestAbsGap = Infinity;
  for (let i = 0; i < form.length; i++) {
    if (form[i] !== "8-K") continue;
    const gap = daysBetween(filingDate[i], approxDate);
    const absGap = Math.abs(gap);
    if (absGap < bestAbsGap) {
      bestAbsGap = absGap;
      best = { filingDate: filingDate[i], reportDate: reportDate[i], primaryDocument: primaryDocument[i], gapDays: gap };
    }
  }
  return best && bestAbsGap <= 10 ? { resolved: true, value: best } : { resolved: false, reason: "no_nearby_8k" };
}

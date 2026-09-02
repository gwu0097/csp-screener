// Resolves fiscal_quarter/fiscal_year/period_end for an earnings_history
// row via SEC EDGAR's XBRL companyconcept API — built for the 2026-09-04
// eps-quarter repair, where the root cause was rows lacking these
// identifiers, forcing eps-sweep.ts onto a date-proximity guess against
// Finnhub that was proven to silently pick the wrong quarter.
//
// Deliberately NOT the 8-K's own "period of report" field — verified
// live (2026-09-04) that an 8-K's reportDate is the announcement date,
// not the fiscal quarter it covers. The reliable source is the
// companyconcept API: every reported XBRL fact carries fy/fp/end tied
// to that specific value, sourced from the 10-Q/10-K that follows the
// 8-K. Matched by FILING date proximity to earningsDate (a 10-Q/10-K
// always follows its preceding 8-K chronologically, same-day to the
// 40/45-day statutory deadline for large/small filers respectively) —
// never by period-end proximity, which is exactly the axis Finnhub's
// own inconsistent labeling proved unsafe.
//
// GAAP-only, categorically — there is no non-GAAP tag in the standard
// XBRL taxonomy. This resolves PERIOD IDENTITY only; it deliberately
// does not attempt to validate or supply eps_actual/eps_estimate (see
// the 2026-09-04 audit's Q3 answer on why that's a different question).
import { resolveCik, edgarGet, daysBetween } from "./edgar-client";
import type { EdgarResult } from "./edgar-client";

type XbrlFact = {
  fy: number;
  fp: string;
  start?: string;
  end: string;
  val: number;
  form: string;
  filed: string;
  accn: string;
};
type CompanyConceptResponse = { units: Record<string, XbrlFact[]> };

// Diluted preferred (matches this table's dominant convention when it IS
// GAAP-sourced); basic as a fallback for companies that don't tag diluted.
const EPS_CONCEPTS = ["EarningsPerShareDiluted", "EarningsPerShareBasic"];
const QUARTER_BY_FP: Record<string, number> = { Q1: 1, Q2: 2, Q3: 3, Q4: 4 };
// Generous beyond the 45-day statutory 10-Q deadline for non-accelerated
// filers — a company can announce earnings before its full 45-day
// window elapses, so the gap from earnings_date to the actual filing
// can exceed 45 days without anything being wrong. Still bounded (not
// unlimited) so this can never cross into an adjacent, unrelated
// quarter — at ~91-day quarterly cadence, 60 days can't reach the next
// quarter's own filing.
const MAX_FILING_GAP_DAYS = 60;

export type FiscalPeriod = {
  fiscalQuarter: number;
  fiscalYear: number;
  periodEnd: string;
  // Bonus, not written anywhere today — GAAP actual for this period,
  // in case future work wants it. Never used to validate/correct the
  // table's own (non-GAAP-convention) eps_actual.
  gaapEpsActual: number | null;
  matchedForm: string;
  matchedFiledDate: string;
};

export async function resolveFiscalPeriod(
  symbol: string,
  earningsDate: string,
): Promise<EdgarResult<FiscalPeriod>> {
  const cikResult = await resolveCik(symbol);
  if (!cikResult.resolved) return cikResult;
  const cik = cikResult.value;

  for (const concept of EPS_CONCEPTS) {
    const url = `https://data.sec.gov/api/xbrl/companyconcept/CIK${cik}/us-gaap/${concept}.json`;
    const result = await edgarGet<CompanyConceptResponse>(url);
    if (!result.resolved) continue;

    const facts = Object.values(result.value.units).flat();
    // A single 10-Q reports the current quarter AND the prior-year
    // comparative quarter side by side, often sharing the identical
    // fy/fp/filed values — only start/end distinguish them (verified
    // live: CRM's Q2 FY2027 10-Q carries both the real Aug 2026 quarter
    // AND its Aug 2025 comparative under the same fy=2027/fp=Q2 label).
    // Restricting to genuinely quarterly-length facts (~91 days between
    // start/end) excludes 6-/9-month YTD cumulative figures the same
    // filing also reports; it does NOT by itself distinguish current
    // from comparative, since both are quarterly-length. That's the
    // second filter below (latest end date wins the tie).
    const quarterly = facts.filter((f) => {
      if (!(f.fp in QUARTER_BY_FP) || (f.form !== "10-Q" && f.form !== "10-K")) return false;
      if (!f.start) return false;
      const durationDays = daysBetween(f.end, f.start);
      return durationDays >= 80 && durationDays <= 100;
    });

    // Primary key: filed date on/after earningsDate, closest wins (a
    // 10-Q/10-K can never precede the 8-K it follows from — a negative
    // gap is always a different, earlier quarter's filing). Secondary
    // key, only breaking ties within the SAME filing: latest `end`
    // wins — the current quarter's period always ends more recently
    // than that same filing's prior-year comparative.
    let best: XbrlFact | null = null;
    let bestGap = Infinity;
    for (const f of quarterly) {
      const gap = daysBetween(f.filed, earningsDate);
      if (gap < 0) continue;
      if (gap < bestGap || (gap === bestGap && best !== null && f.end > best.end)) {
        bestGap = gap;
        best = f;
      }
    }
    if (best && bestGap <= MAX_FILING_GAP_DAYS) {
      return {
        resolved: true,
        value: {
          fiscalQuarter: QUARTER_BY_FP[best.fp],
          fiscalYear: best.fy,
          periodEnd: best.end,
          gaapEpsActual: best.val,
          matchedForm: best.form,
          matchedFiledDate: best.filed,
        },
      };
    }
  }
  return { resolved: false, reason: "no_matching_filing" };
}

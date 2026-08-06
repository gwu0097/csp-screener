// Single, dependency-free source of quarter-label computation, used
// by every consumer that renders or serializes an earnings_history
// row's "quarter" — the Analysis Dump / crush-history helpers
// (lib/earnings-history-table.ts), the History tab
// (components/crush-history-table.tsx, a "use client" component),
// and two API routes (fetch-em-history, encyclopedia csp-history).
//
// Previously 4 byte-identical hand-copied definitions of a
// report-date-only quarterLabel(dateIso) existed — one per file —
// because the obvious shared home (lib/earnings-history-table.ts)
// imports createServerClient, which a client component can't safely
// pull in. This file has zero imports specifically so every consumer,
// client or server, can import the real implementation instead of
// maintaining its own copy that "agrees today" and silently drifts.
//
// Display-only. Never feeds grading, strike selection, or any
// calculation — see lib/screener.ts / lib/encyclopedia.ts, neither of
// which imports this file.

export type QuarterLabelInput = {
  earningsDate: string; // YYYY-MM-DD — the announcement date, always present
  fiscalQuarter: number | null; // 1-4, from the company's own reporting (Finnhub/Yahoo)
  fiscalYear: number | null; // the company's own fiscal year number
  periodEnd: string | null; // YYYY-MM-DD — the real fiscal quarter-end date
};

export type QuarterLabelResult = {
  // "FQ2 27" — null when fiscal data isn't available for this row.
  fiscalLabel: string | null;
  // "CQ2 26" — always present.
  calendarLabel: string;
  // Whether calendarLabel came from the real period_end date or the
  // legacy report-date heuristic (only used when period_end is null).
  calendarSource: "period_end" | "report_date_fallback";
  // false => render the calendar-only "unknown fiscal" marker, never
  // a fabricated fiscal label.
  fiscalKnown: boolean;
  // Ready-to-print combined text: "FQ2 27 · CQ2 26" when fiscal is
  // known, "CQ2 26 (fiscal ?)" when it isn't.
  combined: string;
};

// The real calendar quarter of a period-end date — its own quarter,
// its own year. This is NOT the same computation as the legacy
// report-date heuristic below; period_end already IS the quarter
// boundary, so this is a direct month->quarter bucket with no
// reporting-lag assumption needed.
function calendarLabelFromPeriodEnd(periodEndIso: string): string {
  const [y, m] = periodEndIso.split("-").map(Number);
  if (!y || !m) return "CQ? —";
  const q = Math.ceil(m / 3);
  return `CQ${q} ${String(y).slice(-2)}`;
}

// Legacy heuristic, kept ONLY as the fallback for rows with no
// period_end: buckets the REPORT date under a fixed ~1-month
// reporting-lag assumption (Jan-Mar report -> prior year's Q4 period,
// Apr-Jun -> Q1, Jul-Sep -> Q2, Oct-Dec -> Q3). This is what every one
// of the 4 old quarterLabel(dateIso) copies computed, unconditionally,
// for every row — now scoped to exactly the case it's actually valid
// for (no better data available), not applied blindly.
function calendarLabelFromReportDateFallback(dateIso: string): string {
  const [y, m] = dateIso.split("-").map(Number);
  if (!y || !m) return "CQ? —";
  let q: number;
  let year: number;
  if (m <= 3) {
    q = 4;
    year = y - 1;
  } else if (m <= 6) {
    q = 1;
    year = y;
  } else if (m <= 9) {
    q = 2;
    year = y;
  } else {
    q = 3;
    year = y;
  }
  return `CQ${q} ${String(year).slice(-2)}`;
}

export function quarterLabel(input: QuarterLabelInput): QuarterLabelResult {
  const periodEnd = input.periodEnd;
  const calendarSource: QuarterLabelResult["calendarSource"] =
    periodEnd !== null ? "period_end" : "report_date_fallback";
  const calendarLabel =
    periodEnd !== null
      ? calendarLabelFromPeriodEnd(periodEnd)
      : calendarLabelFromReportDateFallback(input.earningsDate);

  const fiscalKnown = input.fiscalQuarter !== null && input.fiscalYear !== null;
  const fiscalLabel = fiscalKnown
    ? `FQ${input.fiscalQuarter} ${String(input.fiscalYear).slice(-2)}`
    : null;

  const combined = fiscalKnown ? `${fiscalLabel} · ${calendarLabel}` : `${calendarLabel} (fiscal ?)`;

  return { fiscalLabel, calendarLabel, calendarSource, fiscalKnown, combined };
}

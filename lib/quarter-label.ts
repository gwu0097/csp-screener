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

// Whether an ISO date matches one of representativeDate()'s four
// placeholder slots (05-15/08-15/11-15/02-15, any year) — the synthetic
// date crush-history-table.tsx's placeholder rows are keyed on before a
// real date is known. Landing exactly here on a manual save is USUALLY
// the placeholder never having been corrected (the 2026-08-11 audit
// found 23 such rows, all fabricated), but not always — CAVA's real
// 2025-05-15 Q1 print coincidentally lands on the same slot. So this is
// a soft signal, not proof of a bad date: callers should downgrade
// confidence and ask for a second look, not reject the save outright.
export function isRepresentativeDateSlot(iso: string): boolean {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return false;
  const month = Number(m[1]);
  const day = Number(m[2]);
  if (day !== 15) return false;
  return month === 5 || month === 8 || month === 11 || month === 2;
}

// Whether an ISO date falls on a Saturday or Sunday. Unlike the
// placeholder-slot check above, this is a hard fact, not a soft
// signal — no real announcement or price reaction can occur on a day
// the market isn't open, so a caller should reject it outright rather
// than downgrade confidence and keep it.
export function isWeekend(iso: string): boolean {
  const d = new Date(iso + "T00:00:00Z");
  const day = d.getUTCDay();
  return day === 0 || day === 6;
}

// Calendar-quarter SLOT bucketing (report-date, ~1-month-lag heuristic) —
// a separate concern from quarterLabel's DISPLAYED label above. Used to
// decide which of N padded row slots an event belongs in, and (new) to
// compute the real-world date range a missing slot's suggestion should be
// matched against. Moved here from components/crush-history-table.tsx
// (2026-08-19) so the fetch-history route's server-side gap detection and
// the table's client-side placeholder rendering can't independently drift
// on what "the missing quarter" means — they now share one implementation.
export type QuarterYear = { q: 1 | 2 | 3 | 4; y: number };

export function quarterOfDate(dateIso: string): QuarterYear {
  const [y, m] = dateIso.split("-").map(Number);
  if (m <= 3) return { q: 4, y: y - 1 };
  if (m <= 6) return { q: 1, y };
  if (m <= 9) return { q: 2, y };
  return { q: 3, y };
}

export function quarterYearLabel(qy: QuarterYear): string {
  return `Q${qy.q} ${qy.y}`;
}

export function previousQuarter(qy: QuarterYear): QuarterYear {
  return qy.q === 1 ? { q: 4, y: qy.y - 1 } : { q: (qy.q - 1) as 1 | 2 | 3, y: qy.y };
}

// A stable, deterministic report-date for a quarter with no real event
// yet — used as the placeholder row's key (and the date a manual entry
// lands on if filled in before a real fetch ever finds the actual date).
// Mirrors quarterLabel's own date->label mapping in reverse (Q1 reports
// Apr-Jun, Q2 Jul-Sep, Q3 Oct-Dec, Q4 Jan-Mar of the following year) so
// quarterLabel(representativeDate(qy)) always round-trips back to qy.
export function representativeDate(qy: QuarterYear): string {
  const byQuarter: Record<1 | 2 | 3 | 4, { y: number; m: number }> = {
    1: { y: qy.y, m: 5 },
    2: { y: qy.y, m: 8 },
    3: { y: qy.y, m: 11 },
    4: { y: qy.y + 1, m: 2 },
  };
  const { y, m } = byQuarter[qy.q];
  return `${y}-${String(m).padStart(2, "0")}-15`;
}

// The real-world date range a quarter slot's actual announcement could
// fall in — quarterOfDate's own month buckets (Q1=Apr-Jun, Q2=Jul-Sep,
// Q3=Oct-Dec, Q4=Jan-Mar of the following year), used to test whether a
// suggested date from an external source actually belongs to THIS slot
// rather than an adjacent one.
export function quarterDateRange(qy: QuarterYear): { start: string; end: string } {
  const bounds: Record<1 | 2 | 3 | 4, { startY: number; startM: number; endY: number; endM: number; endD: number }> = {
    1: { startY: qy.y, startM: 4, endY: qy.y, endM: 6, endD: 30 },
    2: { startY: qy.y, startM: 7, endY: qy.y, endM: 9, endD: 30 },
    3: { startY: qy.y, startM: 10, endY: qy.y, endM: 12, endD: 31 },
    4: { startY: qy.y + 1, startM: 1, endY: qy.y + 1, endM: 3, endD: 31 },
  };
  const b = bounds[qy.q];
  return {
    start: `${b.startY}-${String(b.startM).padStart(2, "0")}-01`,
    end: `${b.endY}-${String(b.endM).padStart(2, "0")}-${String(b.endD).padStart(2, "0")}`,
  };
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

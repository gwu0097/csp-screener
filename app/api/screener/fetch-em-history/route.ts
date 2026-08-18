import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import {
  gradeFromRatio,
  type CrushHistoryEvent,
} from "@/lib/earnings-history-table";
import {
  quarterLabel,
  quarterOfDate,
  quarterYearLabel,
  previousQuarter,
  quarterDateRange,
  type QuarterYear,
} from "@/lib/quarter-label";
import { fetchFinnhubEarningsCalendar, type CalendarEntry } from "@/lib/encyclopedia";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// Per-symbol fetch from the screener row. 2026-08-19 rework: no longer
// silently writes rows. The prior version (via updateEncyclopedia /
// Finnhub, or a Yahoo-fallback auto-upsert) wrote real earnings_history
// rows with no confirmation step at all — directly at odds with "do not
// auto-accept." Now this route only COMPUTES suggestions and returns
// them; every write happens through /api/screener/earnings-history/update,
// same as a hand-typed manual entry, only once the user explicitly
// confirms (see components/crush-history-table.tsx's pendingResolve
// dialog).
//
// Single source: fetchFinnhubEarningsCalendar (lib/encyclopedia.ts) is
// Yahoo-backed despite its name (see that function's own doc comment —
// it reads Yahoo's quoteSummary earnings module, not Finnhub, because
// Finnhub's free tier only returns the next upcoming entry). Labeled
// "yahoo" everywhere in this route's output, not "finnhub" — there is
// no second, independent source to compare it against, so no agreement
// indicator either (2026-08-19 audit: getFinnhubEarningsPeriods and
// getYahooPastAnnouncements both ultimately read the same
// earningsChart.quarterly array).
export const maxDuration = 30;

const HISTORY_QUARTER_COUNT = 8;

function todayEasternIso(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

type DateSuggestionStatus = "suggested" | "outside_coverage" | "no_match" | "source_error";
type DateSuggestion = {
  quarterLabel: string;
  rangeStart: string;
  rangeEnd: string;
  status: DateSuggestionStatus;
  date: string | null;
  hour: "bmo" | "amc" | null;
};

type SessionSuggestionStatus = "suggested" | "not_found" | "source_error";
type SessionSuggestion = {
  earningsDate: string;
  status: SessionSuggestionStatus;
  hour: "bmo" | "amc" | null;
};

type Body = { symbol?: unknown };

export async function POST(req: NextRequest) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const symbol =
    typeof body.symbol === "string" ? body.symbol.trim().toUpperCase() : "";
  if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol)) {
    return NextResponse.json({ error: "Invalid symbol" }, { status: 400 });
  }

  const sb = createServerClient();

  // Existing rows for this symbol — used both to find which of the 8
  // quarter slots are missing a date, and which real rows are missing
  // a session.
  const existingRes = await sb
    .from("earnings_history")
    .select("earnings_date,timing,actual_move_pct,implied_move_pct")
    .eq("symbol", symbol);
  if (existingRes.error) {
    return NextResponse.json({ error: existingRes.error.message }, { status: 500 });
  }
  type ExistingRow = {
    earnings_date: string;
    timing: "bmo" | "amc" | "unknown" | null;
    actual_move_pct: number | null;
    implied_move_pct: number | null;
  };
  const existingRows = (existingRes.data ?? []) as ExistingRow[];

  const todayIso = todayEasternIso();
  const pinnedQY = quarterOfDate(todayIso);
  const byQuarter = new Map<string, ExistingRow>();
  for (const r of existingRows) {
    const label = quarterYearLabel(quarterOfDate(r.earnings_date));
    if (!byQuarter.has(label)) byQuarter.set(label, r);
  }

  // Same 8-quarter walk-back as the client's placeholder loop
  // (components/crush-history-table.tsx) — shared quarter-label helpers
  // so "which quarter is missing" can't independently drift between
  // client and server.
  const missingQuarters: Array<{ qy: QuarterYear; label: string }> = [];
  const sessionlessRows: ExistingRow[] = [];
  {
    let cursor = quarterOfDate(todayIso);
    for (let i = 0; i < HISTORY_QUARTER_COUNT; i += 1) {
      if (cursor.q !== pinnedQY.q || cursor.y !== pinnedQY.y) {
        const label = quarterYearLabel(cursor);
        const real = byQuarter.get(label);
        if (!real) {
          missingQuarters.push({ qy: cursor, label });
        } else if (real.timing === null || real.timing === "unknown") {
          sessionlessRows.push(real);
        }
      }
      cursor = previousQuarter(cursor);
    }
  }

  // One calendar fetch per symbol, reused for every missing quarter AND
  // every sessionless row — Yahoo's earningsChart.quarterly only ever
  // returns ~4 most recent quarters (documented limitation), so this is
  // cheap and there's nothing to gain from fetching per-quarter.
  let calendar: CalendarEntry[] = [];
  let calendarError: string | null = null;
  try {
    calendar = await fetchFinnhubEarningsCalendar(symbol);
  } catch (e) {
    calendarError = e instanceof Error ? e.message : "source lookup failed";
    console.warn(`[fetch-em-history] calendar fetch failed for ${symbol}: ${calendarError}`);
  }
  const oldestCovered = calendar.length > 0 ? calendar.map((c) => c.announcementDate).sort()[0] : null;

  const dateSuggestions: DateSuggestion[] = [];
  for (const { qy, label } of missingQuarters) {
    const range = quarterDateRange(qy);
    if (calendarError) {
      dateSuggestions.push({ quarterLabel: label, rangeStart: range.start, rangeEnd: range.end, status: "source_error", date: null, hour: null });
      continue;
    }
    const match = calendar.find((c) => c.announcementDate >= range.start && c.announcementDate <= range.end);
    if (match) {
      dateSuggestions.push({
        quarterLabel: label,
        rangeStart: range.start,
        rangeEnd: range.end,
        status: "suggested",
        date: match.announcementDate,
        hour: match.hour === "bmo" || match.hour === "amc" ? match.hour : null,
      });
      continue;
    }
    // Outside coverage vs no-match are genuinely different diagnoses:
    // "outside_coverage" means the source's window structurally doesn't
    // reach this quarter at all (re-fetching will never help); "no_match"
    // means the window reaches this far but nothing landed here (a real,
    // if rarer, gap — a skipped quarter, fiscal-year shift, etc.).
    const status: DateSuggestionStatus =
      oldestCovered !== null && range.end < oldestCovered ? "outside_coverage" : "no_match";
    dateSuggestions.push({ quarterLabel: label, rangeStart: range.start, rangeEnd: range.end, status, date: null, hour: null });
  }

  const sessionSuggestions: SessionSuggestion[] = [];
  for (const row of sessionlessRows) {
    if (calendarError) {
      sessionSuggestions.push({ earningsDate: row.earnings_date, status: "source_error", hour: null });
      continue;
    }
    const match = calendar.find((c) => c.announcementDate === row.earnings_date);
    if (match && (match.hour === "bmo" || match.hour === "amc")) {
      sessionSuggestions.push({ earningsDate: row.earnings_date, status: "suggested", hour: match.hour });
    } else {
      sessionSuggestions.push({ earningsDate: row.earnings_date, status: "not_found", hour: null });
    }
  }

  const unresolvedQuarters: Array<{ quarterLabel: string; reason: "no_date" | "no_session"; detail: string }> = [];
  for (const s of dateSuggestions) {
    if (s.status === "suggested") continue;
    const detail =
      s.status === "outside_coverage"
        ? "outside source coverage, manual date required"
        : s.status === "no_match"
          ? "no matching date in source data, manual date required"
          : "source lookup failed";
    unresolvedQuarters.push({ quarterLabel: s.quarterLabel, reason: "no_date", detail });
  }
  for (const s of sessionSuggestions) {
    if (s.status === "suggested") continue;
    const label = quarterYearLabel(quarterOfDate(s.earningsDate));
    const detail =
      s.status === "not_found"
        ? "no session in source data, manual session required"
        : "source lookup failed";
    unresolvedQuarters.push({ quarterLabel: label, reason: "no_session", detail });
  }

  // Re-fetch the full crush history so the client can drop-in replace
  // its rendered events list.
  const refreshed = await sb
    .from("earnings_history")
    .select(
      "earnings_date,implied_move_pct,actual_move_pct,move_ratio,implied_move_source,implied_move_expiry,implied_move_read_date,date_confidence,fiscal_quarter,fiscal_year,period_end,t1_unrecoverable,timing",
    )
    .eq("symbol", symbol)
    .order("earnings_date", { ascending: false })
    .limit(8);
  const events: CrushHistoryEvent[] = ((refreshed.data ?? []) as Array<{
    earnings_date: string;
    implied_move_pct: number | null;
    actual_move_pct: number | null;
    move_ratio: number | null;
    implied_move_source: string | null;
    implied_move_expiry: string | null;
    implied_move_read_date: string | null;
    date_confidence: "confirmed" | "low" | null;
    fiscal_quarter: number | null;
    fiscal_year: number | null;
    period_end: string | null;
    t1_unrecoverable: boolean | null;
    timing: "bmo" | "amc" | "unknown" | null;
  }>).map((row) => {
    const ratio =
      row.move_ratio ??
      (row.actual_move_pct !== null &&
      row.implied_move_pct !== null &&
      row.implied_move_pct > 0
        ? Math.abs(row.actual_move_pct) / row.implied_move_pct
        : null);
    const label = quarterLabel({
      earningsDate: row.earnings_date,
      fiscalQuarter: row.fiscal_quarter,
      fiscalYear: row.fiscal_year,
      periodEnd: row.period_end,
    });
    return {
      earningsDate: row.earnings_date,
      qtrLabel: label.combined,
      fiscalQuarter: row.fiscal_quarter,
      fiscalYear: row.fiscal_year,
      periodEnd: row.period_end,
      fiscalKnown: label.fiscalKnown,
      impliedMovePct: row.implied_move_pct,
      actualMovePct: row.actual_move_pct,
      ratio,
      grade: gradeFromRatio(ratio),
      impliedMoveSource: row.implied_move_source,
      impliedMoveExpiry: row.implied_move_expiry,
      impliedMoveReadDate: row.implied_move_read_date,
      dateConfidence: row.date_confidence,
      t1Unrecoverable: row.t1_unrecoverable === true,
      timing: row.timing,
    };
  });

  const eventsWithActual = events.filter((e) => e.actualMovePct !== null).length;
  const eventsWithEm = events.filter(
    (e) => e.actualMovePct !== null && e.impliedMovePct !== null,
  ).length;

  console.log(
    `[fetch-em-history] ${symbol}: missingQuarters=${missingQuarters.length} sessionless=${sessionlessRows.length} ` +
      `suggested=${dateSuggestions.filter((s) => s.status === "suggested").length + sessionSuggestions.filter((s) => s.status === "suggested").length} ` +
      `unresolved=${unresolvedQuarters.length} (eventsWithActual=${eventsWithActual} eventsWithEm=${eventsWithEm})`,
  );

  return NextResponse.json({
    eventsWithActual,
    eventsWithEm,
    events,
    dateSuggestions,
    sessionSuggestions,
    unresolvedQuarters,
  });
}

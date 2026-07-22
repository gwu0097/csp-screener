import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import {
  gradeFromRatio,
  type CrushHistoryEvent,
} from "@/lib/earnings-history-table";
import {
  getFinnhubEarningsPeriods,
} from "@/lib/earnings";
import {
  fetchYahooPriceAction,
  updateEncyclopedia,
} from "@/lib/encyclopedia";
import { getYahooPastAnnouncements } from "@/lib/yahoo";

export const dynamic = "force-dynamic";
export const revalidate = 0;
// Per-symbol fetch from the screener row. Seeds historical actual
// moves (Finnhub → encyclopedia ingest, Yahoo fallback) and returns
// the refreshed crush events. Historical implied moves are no longer
// backfilled — the paid options-history data source was cancelled;
// implied moves now only come from live screener runs (Schwab chain
// at analysis time). Rows already backfilled keep their values.
export const maxDuration = 60;

function quarterLabel(dateIso: string): string {
  const [y, m] = dateIso.split("-").map(Number);
  if (!y || !m) return "—";
  if (m <= 3) return `Q4 ${y - 1}`;
  if (m <= 6) return `Q1 ${y}`;
  if (m <= 9) return `Q2 ${y}`;
  return `Q3 ${y}`;
}

// Seeds historical earnings_history rows when the table has no
// actual_move_pct events for the symbol. Tries Finnhub /stock/earnings
// first (which gives fiscal quarter-end periods that updateEncyclopedia
// then maps to real announcement dates via Yahoo), then falls back to
// Yahoo's earningsChart.quarterly[].reportedDate when Finnhub returns
// nothing. Either path computes actual move % from Yahoo price bars.
type SeedReport = {
  finnhubPeriods: number;
  yahooDates: number;
  rowsAdded: number;
  source: "finnhub" | "yahoo" | "none";
  detail: string;
};

async function seedHistoricalRows(symbol: string): Promise<SeedReport> {
  const sb = createServerClient();
  const finnhubPeriods = await getFinnhubEarningsPeriods(symbol);
  if (finnhubPeriods.length > 0) {
    try {
      const summary = await updateEncyclopedia(symbol);
      return {
        finnhubPeriods: finnhubPeriods.length,
        yahooDates: 0,
        rowsAdded: summary.newRecords + summary.updatedRecords,
        source: "finnhub",
        detail: `finnhub returned ${finnhubPeriods.length} periods; encyclopedia ingest added ${summary.newRecords} new + ${summary.updatedRecords} updated`,
      };
    } catch (e) {
      console.warn(
        `[fetch-em] seed via Finnhub/encyclopedia failed for ${symbol}: ${e instanceof Error ? e.message : e}`,
      );
    }
  }

  // Yahoo fallback: pull announcement dates directly, then compute
  // actual move % from Yahoo bars and upsert into earnings_history.
  const yahooAnnouncements = await getYahooPastAnnouncements(symbol);
  if (yahooAnnouncements.length === 0) {
    return {
      finnhubPeriods: finnhubPeriods.length,
      yahooDates: 0,
      rowsAdded: 0,
      source: "none",
      detail: `finnhub=${finnhubPeriods.length} periods; yahoo=0 announcements — nothing to seed`,
    };
  }

  // Hand-entered rows (from the earnings-history table's inline EM/
  // Actual editor) must never be overwritten by this seed path — same
  // rule as the Finnhub/updateEncyclopedia path in lib/encyclopedia.ts.
  const manualRes = await sb
    .from("earnings_history")
    .select("earnings_date")
    .eq("symbol", symbol)
    .eq("implied_move_source", "manual");
  const manualDates = new Set(
    ((manualRes.data ?? []) as Array<{ earnings_date: string }>).map((r) => r.earnings_date),
  );

  let added = 0;
  for (const ann of yahooAnnouncements) {
    if (manualDates.has(ann.iso)) continue;
    const price = await fetchYahooPriceAction(symbol, ann.iso);
    const payload: Record<string, unknown> = {
      symbol,
      earnings_date: ann.iso,
      price_before: price.price_before,
      price_after: price.price_after,
      price_at_expiry: price.price_at_expiry,
      actual_move_pct: price.actual_move_pct,
      data_source: "yahoo",
      is_complete:
        price.price_before !== null && price.price_after !== null,
    };
    const up = await sb
      .from("earnings_history")
      .upsert(payload, { onConflict: "symbol,earnings_date" });
    if (up.error) {
      console.warn(
        `[fetch-em] yahoo seed upsert failed for ${symbol}@${ann.iso}: ${up.error.message}`,
      );
      continue;
    }
    added += 1;
  }
  return {
    finnhubPeriods: finnhubPeriods.length,
    yahooDates: yahooAnnouncements.length,
    rowsAdded: added,
    source: "yahoo",
    detail: `finnhub=${finnhubPeriods.length} periods; yahoo=${yahooAnnouncements.length} announcements; upserted ${added} rows`,
  };
}

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
  const initialRead = await sb
    .from("earnings_history")
    .select("earnings_date,actual_move_pct")
    .eq("symbol", symbol);
  if (initialRead.error) {
    return NextResponse.json({ error: initialRead.error.message }, { status: 500 });
  }
  const historicalCount = ((initialRead.data ?? []) as Array<{
    actual_move_pct: number | null;
  }>).filter((row) => row.actual_move_pct !== null).length;

  // Seed when the table is cold for this symbol (fewer than 3 rows
  // with an actual move).
  let seedReport: SeedReport | null = null;
  if (historicalCount < 3) {
    seedReport = await seedHistoricalRows(symbol);
    console.log(`[fetch-em] seed ${symbol}: ${seedReport.detail}`);
  }
  const seedAdded = seedReport?.rowsAdded ?? 0;
  const messages: string[] = [];
  if (seedReport) {
    messages.push(`seed (${seedReport.source}): ${seedReport.detail}`);
  }

  // Re-fetch the full crush history so the client can drop-in
  // replace its rendered events list with the latest grades.
  const refreshed = await sb
    .from("earnings_history")
    .select(
      "earnings_date,implied_move_pct,actual_move_pct,move_ratio,implied_move_source",
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
  }>).map((row) => {
    const ratio =
      row.move_ratio ??
      (row.actual_move_pct !== null &&
      row.implied_move_pct !== null &&
      row.implied_move_pct > 0
        ? Math.abs(row.actual_move_pct) / row.implied_move_pct
        : null);
    return {
      earningsDate: row.earnings_date,
      qtrLabel: quarterLabel(row.earnings_date),
      impliedMovePct: row.implied_move_pct,
      actualMovePct: row.actual_move_pct,
      ratio,
      grade: gradeFromRatio(ratio),
      impliedMoveSource: row.implied_move_source,
    };
  });

  const eventsWithActual = events.filter((e) => e.actualMovePct !== null).length;
  const eventsWithEm = events.filter(
    (e) => e.actualMovePct !== null && e.impliedMovePct !== null,
  ).length;

  console.log(
    `[fetch-em-history] ${symbol}: seedAdded=${seedAdded} ` +
      `(eventsWithActual=${eventsWithActual} eventsWithEm=${eventsWithEm})`,
  );

  return NextResponse.json({
    seedAdded,
    eventsWithActual,
    eventsWithEm,
    events,
    messages,
  });
}

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
import {
  POLYGON_DEPTH_CUTOFF,
  processPolygonEvent,
  type EarningsRow,
  type ProcessOutcome,
} from "@/lib/polygon-em";

export const dynamic = "force-dynamic";
export const revalidate = 0;
// Per-symbol fetch from the screener row. Each event makes 3 Polygon
// aggs calls with 13s spacers (free-tier safe), so wall-clock per
// event ≈ 40s. Vercel Hobby caps at 60s, so we cap the per-invocation
// event count at 1 and let the client auto-loop the route until
// remainingMissing hits 0. Bulk paid-tier backfill lives in
// /api/screener/backfill-em-polygon (uses noSleep=true).
export const maxDuration = 60;

const EVENTS_PER_CALL = 1;

function quarterLabel(dateIso: string): string {
  const [y, m] = dateIso.split("-").map(Number);
  if (!y || !m) return "—";
  if (m <= 3) return `Q4 ${y - 1}`;
  if (m <= 6) return `Q1 ${y}`;
  if (m <= 9) return `Q2 ${y}`;
  return `Q3 ${y}`;
}

const processEvent = (row: EarningsRow) => processPolygonEvent(row);

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

  let added = 0;
  for (const ann of yahooAnnouncements) {
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

  console.log(
    `[fetch-em] symbol: ${symbol} key exists: ${!!process.env.POLYGON_API_KEY} using fallback: ${!process.env.POLYGON_API_KEY}`,
  );

  const sb = createServerClient();
  // Pull every row for the symbol in the Polygon window — we need
  // the full list both to pick targets and to recompute the crush
  // events the UI consumes.
  const initialRead = await sb
    .from("earnings_history")
    .select(
      "symbol,earnings_date,actual_move_pct,implied_move_pct,implied_move_source,move_ratio,price_before",
    )
    .eq("symbol", symbol)
    .gte("earnings_date", POLYGON_DEPTH_CUTOFF)
    .order("earnings_date", { ascending: false });
  if (initialRead.error) {
    return NextResponse.json({ error: initialRead.error.message }, { status: 500 });
  }
  let rows = (initialRead.data ?? []) as EarningsRow[];

  // Seed step. If we have fewer than 3 historical rows with an actual
  // move, the polygon EM-populate step has nothing to chew on. Seed
  // historical events from Finnhub (preferred) or Yahoo (fallback)
  // before computing targets so the button can recover from a cold
  // earnings_history table.
  const historicalCount = rows.filter(
    (row) => row.actual_move_pct !== null,
  ).length;
  let seedReport: SeedReport | null = null;
  let seededThisCall = false;
  if (historicalCount < 3) {
    seedReport = await seedHistoricalRows(symbol);
    console.log(
      `[fetch-em] seed ${symbol}: ${seedReport.detail}`,
    );
    if (seedReport.rowsAdded > 0) {
      seededThisCall = true;
      const reread = await sb
        .from("earnings_history")
        .select(
          "symbol,earnings_date,actual_move_pct,implied_move_pct,implied_move_source,move_ratio,price_before",
        )
        .eq("symbol", symbol)
        .gte("earnings_date", POLYGON_DEPTH_CUTOFF)
        .order("earnings_date", { ascending: false });
      if (!reread.error) {
        rows = (reread.data ?? []) as EarningsRow[];
      }
    }
  }

  const targets = rows.filter(
    (row) =>
      row.actual_move_pct !== null && row.implied_move_pct === null,
  );

  // No more than EVENTS_PER_CALL processed per invocation — keeps
  // total wall-clock under the 60 s ceiling. The client loops the
  // route until remainingMissing === 0. When we just seeded fresh
  // historical rows we skip polygon this iteration to leave headroom
  // under the 60 s cap; the client's loop will pick up the new
  // targets on the next call.
  const slice = seededThisCall ? [] : targets.slice(0, EVENTS_PER_CALL);
  // seedAdded = historical actual moves written by the seed step
  // (Finnhub→encyclopedia or Yahoo fallback). Distinct from
  // emPopulated, which counts Polygon-derived implied moves added
  // by processEvent. The combined `populated` field stays in the
  // response for back-compat with older client code.
  const seedAdded = seededThisCall ? (seedReport?.rowsAdded ?? 0) : 0;
  let emPopulated = 0;
  let skipped = 0;
  const messages: string[] = [];
  if (seedReport) {
    messages.push(`seed (${seedReport.source}): ${seedReport.detail}`);
  }

  for (const row of slice) {
    let outcome: ProcessOutcome;
    try {
      outcome = await processEvent(row);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      console.error(`[fetch-em] ${symbol} ${row.earnings_date} threw:`, e);
      outcome = { kind: "error", reason };
    }
    if (outcome.kind === "error" || outcome.kind === "skip_no_contracts" || outcome.kind === "skip_no_data") {
      console.log(
        `[fetch-em] ${symbol} ${row.earnings_date} ${outcome.kind}: ${"reason" in outcome ? outcome.reason : ""}`,
      );
    }
    if (outcome.kind === "populated") {
      const upd = await sb
        .from("earnings_history")
        .update({
          implied_move_pct: outcome.emPct,
          implied_move_source: "polygon",
        })
        .eq("symbol", symbol)
        .eq("earnings_date", row.earnings_date);
      if (upd.error) {
        messages.push(`${row.earnings_date}: DB write failed`);
      } else {
        emPopulated += 1;
        messages.push(
          `${row.earnings_date}: EM=${(outcome.emPct * 100).toFixed(2)}% @ strike $${outcome.strike}${outcome.usedFallback ? " (used 5-BD fallback)" : ""}`,
        );
      }
    } else if (outcome.kind === "skip_too_old") {
      skipped += 1;
      messages.push(`${row.earnings_date}: outside 24-month window`);
    } else if (outcome.kind === "skip_no_contracts") {
      skipped += 1;
      messages.push(`${row.earnings_date}: ${outcome.reason}`);
    } else if (outcome.kind === "skip_no_data") {
      skipped += 1;
      messages.push(`${row.earnings_date}: ${outcome.reason}`);
    } else {
      skipped += 1;
      messages.push(`${row.earnings_date}: ${outcome.reason}`);
    }
  }
  const populated = seedAdded + emPopulated;

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
  const remainingMissing = events.filter(
    (e) => e.actualMovePct !== null && e.impliedMovePct === null,
  ).length;

  console.log(
    `[fetch-em-history] ${symbol}: seedAdded=${seedAdded} emPopulated=${emPopulated} skipped=${skipped} ` +
      `remaining=${remainingMissing} (eventsWithActual=${eventsWithActual} eventsWithEm=${eventsWithEm}, processed ${slice.length}/${targets.length})`,
  );

  return NextResponse.json({
    populated,
    seedAdded,
    emPopulated,
    eventsWithActual,
    eventsWithEm,
    skipped,
    remainingMissing,
    processed: slice.length,
    totalMissingAtStart: targets.length,
    events,
    messages,
  });
}

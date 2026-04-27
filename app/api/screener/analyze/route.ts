import { NextRequest, NextResponse } from "next/server";
import { getBatchPrices } from "@/lib/price";
import { getOptionsChain, isSchwabConnected } from "@/lib/schwab";
import {
  runStagesThreeFour,
  calculateThreeLayerGrade,
  getPersonalHistory,
  ScreenerResult,
} from "@/lib/screener";
import { getEarningsNewsContext } from "@/lib/perplexity";
import { getMarketContext } from "@/lib/market";
import { createServerClient } from "@/lib/supabase";
import { type Fill } from "@/lib/positions";
import { buildSnapshotRow } from "@/lib/snapshots";
import { runEncyclopediaMaintenance } from "@/lib/encyclopedia";

export const dynamic = "force-dynamic";
export const revalidate = 0;
// Stage 3-4 analysis pulls Schwab options chains for every candidate +
// Perplexity earnings news per symbol + market context + per-position
// snapshots. Heavy users with many open positions easily exceed 60s on
// cold runs. Pro-plan ceiling.
export const maxDuration = 300;

type Body = {
  candidates?: unknown;
  opportunityAvailable?: boolean;
  trackedSymbols?: string[];
};

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

// Snapshots current option price + P&L + Greeks for every open position.
// Writes one row per position into position_snapshots. Called synchronously
// after candidate scoring per user directive (correctness > latency).
// Per-field math lives in lib/snapshots.ts so the close-time snapshot path
// in /api/trades/bulk-create produces identical rows.
async function writePositionSnapshots(): Promise<{ written: number; errors: string[] }> {
  const errors: string[] = [];
  let written = 0;
  try {
    const supabase = createServerClient();
    const { data: opens, error: pErr } = await supabase
      .from("positions")
      .select(
        "id, symbol, strike, expiry, total_contracts, avg_premium_sold, opened_date, entry_stock_price, entry_em_pct",
      )
      .eq("status", "open");
    if (pErr) {
      return { written: 0, errors: [`fetch open positions: ${pErr.message}`] };
    }
    const positions = (opens ?? []) as Array<{
      id: string;
      symbol: string;
      strike: number;
      expiry: string;
      total_contracts: number;
      avg_premium_sold: number | null;
      opened_date: string | null;
      entry_stock_price: number | null;
      entry_em_pct: number | null;
    }>;
    if (positions.length === 0) return { written: 0, errors: [] };

    const positionIds = positions.map((p) => p.id);
    const { data: fillsRaw } = await supabase
      .from("fills")
      .select("position_id, fill_type, contracts, premium, fill_date")
      .in("position_id", positionIds);
    const fillsByPosition = new Map<string, Fill[]>();
    for (const f of (fillsRaw ?? []) as Array<Fill & { position_id: string }>) {
      const arr = fillsByPosition.get(f.position_id) ?? [];
      arr.push({
        fill_type: f.fill_type,
        contracts: f.contracts,
        premium: f.premium,
        fill_date: f.fill_date,
      });
      fillsByPosition.set(f.position_id, arr);
    }

    // One chain fetch per unique symbol. Multiple positions on the same
    // ticker (different strikes/expiries) share a single chain fetch;
    // pickPutContract picks the right expiry in-memory with tolerance,
    // which is resilient to stored-expiry drift (weekend settlement dates).
    const chainCache = new Map<string, Awaited<ReturnType<typeof getOptionsChain>> | null>();
    await Promise.all(
      Array.from(new Set(positions.map((p) => p.symbol))).map(async (sym) => {
        try {
          const chain = await getOptionsChain(sym);
          chainCache.set(sym, chain);
        } catch (e) {
          console.warn(`[snapshots] chain(${sym}) failed: ${e instanceof Error ? e.message : e}`);
          chainCache.set(sym, null);
        }
      }),
    );

    const nowIso = new Date().toISOString();
    const todayStr = nowIso.slice(0, 10);
    console.log(`[snapshots] processing ${positions.length} open positions`);
    for (const p of positions) {
      const chain = chainCache.get(p.symbol) ?? null;
      // On expiry day the position is about to resolve one way or the
      // other — flag the snapshot as close_snapshot so the intelligence
      // layer can separate "final reading" from intraday captures even
      // when the user never manually closes (auto-expire / assignment).
      const isExpiryDay = (p.expiry ?? "") <= todayStr;
      const row = buildSnapshotRow(p, chain, fillsByPosition.get(p.id) ?? [], {
        nowIso,
        closeSnapshot: isExpiryDay,
      });
      const { error: iErr } = await supabase.from("position_snapshots").insert(row);
      if (iErr) {
        console.warn(
          `[snapshots] ${p.symbol} $${p.strike} exp=${p.expiry}: insert failed — ${iErr.message}`,
        );
        errors.push(`${p.symbol}: ${iErr.message}`);
        continue;
      }
      console.log(
        `[snapshots] ${p.symbol} $${p.strike} exp=${p.expiry}: written close=${isExpiryDay} chain=${chain ? "ok" : "null"} stock=${row.stock_price} opt=${row.option_price} iv=${row.current_iv} delta=${row.current_delta}`,
      );
      written += 1;
    }
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
  }
  return { written, errors };
}

// Upserts tracked_tickers with the latest grades. Runs once per analyze
// invocation AFTER all results are available.
async function upsertTrackedTickers(
  results: ScreenerResult[],
  tracked: Set<string>,
  vix: number | null,
): Promise<{ upserted: number; errors: string[] }> {
  const errors: string[] = [];
  let upserted = 0;
  if (tracked.size === 0) return { upserted: 0, errors: [] };
  try {
    const supabase = createServerClient();
    const screenedDate = todayIso();
    for (const r of results) {
      if (!tracked.has(r.symbol.toUpperCase())) continue;
      if (!r.threeLayer) continue;
      const row = {
        symbol: r.symbol.toUpperCase(),
        expiry: r.expiry,
        screened_date: screenedDate,
        suggested_strike: r.stageFour?.suggestedStrike ?? null,
        entry_crush_grade: r.threeLayer.industryFactors.crushGrade,
        entry_opportunity_grade: r.threeLayer.industryFactors.opportunityGrade,
        entry_final_grade: r.threeLayer.finalGrade,
        entry_iv_edge: r.threeLayer.industryFactors.ivEdge,
        entry_em_pct: r.stageThree?.details?.expectedMovePct ?? null,
        entry_vix: vix,
        entry_news_summary: r.threeLayer.regimeFactors.newsSummary,
        entry_stock_price: r.price,
      };
      const { error: uErr } = await supabase
        .from("tracked_tickers")
        .upsert(row, { onConflict: "symbol,expiry,screened_date" });
      if (uErr) {
        errors.push(`${r.symbol}: ${uErr.message}`);
        continue;
      }
      upserted += 1;
    }
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
  }
  return { upserted, errors };
}

export async function POST(req: NextRequest) {
  const { connected } = await isSchwabConnected().catch(() => ({ connected: false }));
  if (!connected) {
    return NextResponse.json(
      { error: "Schwab not connected. Connect it from Settings to run analysis." },
      { status: 400 },
    );
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!Array.isArray(body.candidates)) {
    return NextResponse.json({ error: "Missing candidates array" }, { status: 400 });
  }

  const candidates = body.candidates as ScreenerResult[];
  const tracked = new Set(
    (body.trackedSymbols ?? []).map((s) => String(s).toUpperCase()),
  );

  // Deliberately NOT early-returning on empty candidates. Run Analysis on
  // a day with no screener candidates still needs to snapshot open
  // positions (Greeks/IV/delta time series) and run encyclopedia
  // maintenance. Skipping those would lose the intraday data we use
  // for pattern learning.

  // Shared context: batch prices + VIX/SPY. These are cheap to fetch and
  // shared across every candidate.
  const [prices, market] = await Promise.all([
    getBatchPrices(candidates.map((c) => c.symbol)),
    getMarketContext().catch(() => ({ vix: null, spyPrice: null, regime: null, warning: null })),
  ]);

  // Per-candidate scoring in parallel — each does stage 3/4 + Perplexity
  // + personal-history lookup, then combines into a three-layer grade.
  const resultPromises = candidates.map(async (base): Promise<ScreenerResult> => {
    const symbol = base.symbol.toUpperCase();
    const refreshedPrice = prices[symbol] ?? base.price ?? 0;
    const scored = await runStagesThreeFour({ ...base, price: refreshedPrice });

    if (!scored.stageThree || !scored.stageFour) return scored;

    const [news, personal] = await Promise.all([
      getEarningsNewsContext(base.symbol, base.symbol).catch(() => ({
        summary: "News fetch failed",
        sentiment: "neutral" as const,
        hasActiveOverhang: false,
        overhangDescription: null,
        sources: [],
        gradePenalty: 0,
      })),
      getPersonalHistory(base.symbol).catch(() => ({
        tradeCount: 0,
        winRate: null,
        avgRoc: null,
        dataInsufficient: true,
      })),
    ]);

    const threeLayer = calculateThreeLayerGrade(
      scored.stageThree,
      scored.stageFour,
      news,
      personal,
      market.vix,
    );
    return { ...scored, threeLayer };
  });

  const results = await Promise.all(resultPromises);
  // Candidates that actually produced a three-layer grade. This is what the
  // user sees ranked on the board; stages 3/4 failures (e.g. missing chain)
  // count as "returned" but not "scored".
  const scoredCount = results.filter((r) => r.threeLayer !== null).length;

  // Upsert tracked_tickers + write snapshots in parallel AFTER scoring.
  // Both block the response per user directive (correctness > latency).
  const [trackedResult, snapshotResult] = await Promise.all([
    upsertTrackedTickers(results, tracked, market.vix),
    writePositionSnapshots(),
  ]);

  // Encyclopedia maintenance: T0/T1 capture for today-AMC / tomorrow-BMO
  // announcements on relevant symbols, price-at-expiry backfill, and
  // Perplexity narrative backfill. Every step is idempotent — skips rows
  // that already have the target column populated. Errors surface in the
  // report but never block the analyze response.
  let encyclopediaUpdates = 0;
  try {
    const report = await runEncyclopediaMaintenance();
    encyclopediaUpdates =
      report.t0Captured.length +
      report.t1Captured.length +
      report.expiryBackfilled.length +
      report.perplexityBackfilled.length;
    console.log(
      `[analyze:encyclopedia] symbols=${report.symbolsProcessed} t0=${report.t0Captured.length} t1=${report.t1Captured.length} expiry=${report.expiryBackfilled.length} perplexity=${report.perplexityBackfilled.length} errors=${report.errors.length}`,
    );
  } catch (e) {
    console.warn(
      `[analyze:encyclopedia] runEncyclopediaMaintenance threw: ${e instanceof Error ? e.message : e}`,
    );
  }

  console.log(
    `[analyze] ${results.length} candidates (${scoredCount} scored), tracked_upserted=${trackedResult.upserted}, snapshots_written=${snapshotResult.written}, encyclopedia_updates=${encyclopediaUpdates}, errors: tracked=${trackedResult.errors.length} snapshots=${snapshotResult.errors.length}`,
  );

  return NextResponse.json({
    connected: true,
    results,
    prices,
    scoredCount,
    trackedUpserted: trackedResult.upserted,
    snapshotsWritten: snapshotResult.written,
    encyclopediaUpdates,
  });
}

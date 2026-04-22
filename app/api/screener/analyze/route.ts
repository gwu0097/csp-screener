import { NextRequest, NextResponse } from "next/server";
import { getBatchPrices } from "@/lib/price";
import { getOptionsChain, isSchwabConnected, SchwabOptionContract } from "@/lib/schwab";
import {
  runStagesThreeFour,
  calculateThreeLayerGrade,
  getPersonalHistory,
  ScreenerResult,
} from "@/lib/screener";
import { getEarningsNewsContext } from "@/lib/perplexity";
import { getMarketContext } from "@/lib/market";
import { createServerClient } from "@/lib/supabase";
import { remainingContracts, type Fill } from "@/lib/positions";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const maxDuration = 60;

type Body = {
  candidates?: unknown;
  opportunityAvailable?: boolean;
  trackedSymbols?: string[];
};

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

// Pull the option at the provided strike from a put chain. Used when we
// snapshot open positions so we can price the mark + greeks off Schwab.
function pickContract(
  chain: Awaited<ReturnType<typeof getOptionsChain>>,
  strike: number,
  expiry: string,
): SchwabOptionContract | null {
  const keys = Object.keys(chain.putExpDateMap ?? {});
  const expKey = keys.find((k) => k.startsWith(expiry));
  if (!expKey) return null;
  const strikes = chain.putExpDateMap[expKey];
  const direct = strikes[String(Number(strike))] ?? strikes[strike.toFixed(2)] ?? null;
  if (direct && direct.length > 0) return direct[0];
  let best: SchwabOptionContract | null = null;
  let bestDiff = Infinity;
  for (const arr of Object.values(strikes)) {
    for (const c of arr) {
      const d = Math.abs(c.strikePrice - strike);
      if (d < bestDiff) {
        best = c;
        bestDiff = d;
      }
    }
  }
  return best;
}

// Snapshots current option price + P&L for every open position. Writes
// one row per position into position_snapshots. Called synchronously
// after candidate scoring per user directive (correctness > latency).
async function writePositionSnapshots(): Promise<{ written: number; errors: string[] }> {
  const errors: string[] = [];
  let written = 0;
  try {
    const supabase = createServerClient();
    const { data: opens, error: pErr } = await supabase
      .from("positions")
      .select("id, symbol, strike, expiry, total_contracts, avg_premium_sold")
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
    }>;
    if (positions.length === 0) return { written: 0, errors: [] };

    // Fetch fills to compute remaining contracts (P&L applies to remaining).
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

    // One chain fetch per unique (symbol, expiry) pair — a position might
    // share chain with another position on the same expiry.
    const chainKey = (sym: string, exp: string) => `${sym}|${exp}`;
    const chainCache = new Map<string, Awaited<ReturnType<typeof getOptionsChain>> | null>();
    await Promise.all(
      Array.from(new Set(positions.map((p) => chainKey(p.symbol, p.expiry)))).map(async (k) => {
        const [sym, exp] = k.split("|");
        try {
          const chain = await getOptionsChain(sym, exp);
          chainCache.set(k, chain);
        } catch (e) {
          console.warn(`[snapshots] chain(${sym},${exp}) failed: ${e instanceof Error ? e.message : e}`);
          chainCache.set(k, null);
        }
      }),
    );

    const now = new Date().toISOString();
    for (const p of positions) {
      const chain = chainCache.get(chainKey(p.symbol, p.expiry));
      const contract = chain ? pickContract(chain, Number(p.strike), p.expiry) : null;
      const optionPrice = contract?.mark ?? null;
      const stockPrice =
        chain?.underlying?.mark ??
        chain?.underlying?.last ??
        chain?.underlyingPrice ??
        null;
      const remaining = remainingContracts(fillsByPosition.get(p.id) ?? []);
      const soldPremium = Number(p.avg_premium_sold ?? 0);
      let pnlDollars: number | null = null;
      let pnlPct: number | null = null;
      if (optionPrice !== null && soldPremium > 0 && remaining > 0) {
        pnlDollars = (soldPremium - optionPrice) * remaining * 100;
        pnlPct = (soldPremium - optionPrice) / soldPremium;
      }
      const { error: iErr } = await supabase.from("position_snapshots").insert({
        position_id: p.id,
        snapshot_time: now,
        stock_price: stockPrice,
        option_price: optionPrice,
        pnl_pct: pnlPct,
        pnl_dollars: pnlDollars,
      });
      if (iErr) {
        errors.push(`${p.symbol}: ${iErr.message}`);
        continue;
      }
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

  if (candidates.length === 0) {
    return NextResponse.json({ connected: true, results: [], prices: {} });
  }

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

  // Upsert tracked_tickers + write snapshots in parallel AFTER scoring.
  // Both block the response per user directive (correctness > latency).
  const [trackedResult, snapshotResult] = await Promise.all([
    upsertTrackedTickers(results, tracked, market.vix),
    writePositionSnapshots(),
  ]);

  console.log(
    `[analyze] ${results.length} candidates, tracked_upserted=${trackedResult.upserted}, snapshots_written=${snapshotResult.written}, errors: tracked=${trackedResult.errors.length} snapshots=${snapshotResult.errors.length}`,
  );

  return NextResponse.json({
    connected: true,
    results,
    prices,
    trackedUpserted: trackedResult.upserted,
    snapshotsWritten: snapshotResult.written,
  });
}

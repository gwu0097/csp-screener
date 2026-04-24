import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { getOptionsChain, SchwabOptionContract } from "@/lib/schwab";
import { getCurrentPrice, getHistoricalPrices } from "@/lib/yahoo";
import { getMarketContext } from "@/lib/market";
import {
  recommendPosition,
  postEarningsMomentum,
  isTwoDayDrop,
  remainingContracts,
  URGENCY_ORDER,
  type Urgency,
  type Momentum,
  type Fill,
  type PositionRow,
} from "@/lib/positions";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type PostEarningsRecView = {
  recommendation: "CLOSE" | "HOLD" | "PARTIAL" | "MONITOR";
  confidence: "HIGH" | "MEDIUM" | "LOW";
  reasoning: string;
  ruleFired: string;
  analysisDate: string;
  moveRatio: number | null;
  ivCrushed: boolean | null;
  ivCrushMagnitude: number | null;
  breachedTwoXem: boolean | null;
  analystSentiment: string | null;
  recoveryLikelihood: string | null;
  stockPctFromStrike: number | null;
};

type OpenPosition = {
  id: string;
  symbol: string;
  broker: string;
  strike: number;
  expiry: string;
  optionType: "put" | "call";
  totalContracts: number;      // contracts originally opened
  remainingContracts: number;  // contracts still open
  avgPremiumSold: number | null;
  openedDate: string;
  currentStockPrice: number | null;
  currentMark: number | null;
  currentBid: number | null;
  currentAsk: number | null;
  currentDelta: number | null;
  currentTheta: number | null;
  currentIv: number | null;
  dte: number;
  pnlDollars: number | null;
  pnlPct: number | null;
  distanceToStrikePct: number | null;
  thetaDecayTotal: number | null;
  momentum: Momentum | null;
  urgency: Urgency;
  recommendationReason: string;
  postEarningsRec: PostEarningsRecView | null;
  fills: Fill[];
  // Entry snapshot — populated at position-open time from the screener's
  // three-layer grade. Used by the expanded position card for the
  // left-column "what did we see at entry" panel.
  entryFinalGrade: string | null;
  entryCrushGrade: string | null;
  entryOpportunityGrade: string | null;
  entryIndustryGrade: string | null;
  entryRegimeGrade: string | null;
  entryIvEdge: number | null;
  entryEmPct: number | null;
  entryVix: number | null;
  entryStockPrice: number | null;
};

function daysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / (24 * 60 * 60 * 1000));
}

function pickContractFromChain(
  chain: Awaited<ReturnType<typeof getOptionsChain>>,
  strike: number,
  expiry: string,
): SchwabOptionContract | null {
  const keys = Object.keys(chain.putExpDateMap ?? {});
  const expKey = keys.find((k) => k.startsWith(expiry));
  if (!expKey) return null;
  const strikes = chain.putExpDateMap[expKey];
  const wanted = String(Number(strike));
  const direct = strikes[wanted] ?? strikes[strike.toFixed(2)] ?? null;
  if (direct && direct.length > 0) return direct[0];
  let best: SchwabOptionContract | null = null;
  let bestDiff = Infinity;
  for (const contracts of Object.values(strikes)) {
    for (const c of contracts) {
      const d = Math.abs(c.strikePrice - strike);
      if (d < bestDiff) {
        best = c;
        bestDiff = d;
      }
    }
  }
  return best;
}

// Wraps an async upstream with a hard timeout; resolves to null on timeout
// or throw so a single slow/failed call can't stall the whole batch.
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      console.warn(`[positions] ${label} timed out after ${ms}ms`);
      resolve(null);
    }, ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        console.warn(`[positions] ${label} threw: ${e instanceof Error ? e.message : e}`);
        resolve(null);
      },
    );
  });
}

export async function GET(req: NextRequest) {
  const opportunityAvailable =
    req.nextUrl.searchParams.get("opportunityAvailable") === "true";
  const live = req.nextUrl.searchParams.get("live") === "true";

  const supabase = createServerClient();

  // 1. Open positions + all their fills.
  const { data: posRows, error: pErr } = await supabase
    .from<PositionRow>("positions")
    .select("*")
    .eq("status", "open")
    .order("opened_date", { ascending: true });
  if (pErr) {
    return NextResponse.json({ error: pErr.message }, { status: 500 });
  }
  const positionsList = (posRows ?? []) as PositionRow[];

  // Fetch all fills for these positions in one call.
  const positionIds = positionsList.map((p) => p.id);
  const fillsByPosition = new Map<string, Fill[]>();
  if (positionIds.length > 0) {
    const { data: fillsRows } = await supabase
      .from<Fill & { position_id: string }>("fills")
      .select("position_id, fill_type, contracts, premium, fill_date")
      .in("position_id", positionIds);
    for (const f of (fillsRows ?? []) as Array<Fill & { position_id: string }>) {
      const arr = fillsByPosition.get(f.position_id) ?? [];
      arr.push({
        fill_type: f.fill_type,
        contracts: f.contracts,
        premium: f.premium,
        fill_date: f.fill_date,
      });
      fillsByPosition.set(f.position_id, arr);
    }
  }

  const now = new Date();

  // Fetch the latest post-earnings recommendation per position in one
  // query. We take the newest row per position (by analysis_date desc)
  // and dedupe in memory, so a same-day rerun still shows today's rec.
  const recsByPosition = new Map<string, PostEarningsRecView>();
  if (positionIds.length > 0) {
    const recRes = await supabase
      .from("post_earnings_recommendations")
      .select(
        "position_id,analysis_date,move_ratio,iv_crushed,iv_crush_magnitude,breached_two_x_em,analyst_sentiment,recovery_likelihood,stock_pct_from_strike,recommendation,confidence,reasoning,rule_fired",
      )
      .in("position_id", positionIds)
      .order("analysis_date", { ascending: false });
    const allRecs = (recRes.data ?? []) as Array<{
      position_id: string;
      analysis_date: string;
      move_ratio: number | null;
      iv_crushed: boolean | null;
      iv_crush_magnitude: number | null;
      breached_two_x_em: boolean | null;
      analyst_sentiment: string | null;
      recovery_likelihood: string | null;
      stock_pct_from_strike: number | null;
      recommendation: "CLOSE" | "HOLD" | "PARTIAL" | "MONITOR";
      confidence: "HIGH" | "MEDIUM" | "LOW";
      reasoning: string;
      rule_fired: string;
    }>;
    for (const r of allRecs) {
      if (recsByPosition.has(r.position_id)) continue;
      recsByPosition.set(r.position_id, {
        recommendation: r.recommendation,
        confidence: r.confidence,
        reasoning: r.reasoning,
        ruleFired: r.rule_fired,
        analysisDate: r.analysis_date,
        moveRatio: r.move_ratio,
        ivCrushed: r.iv_crushed,
        ivCrushMagnitude: r.iv_crush_magnitude,
        breachedTwoXem: r.breached_two_x_em,
        analystSentiment: r.analyst_sentiment,
        recoveryLikelihood: r.recovery_likelihood,
        stockPctFromStrike: r.stock_pct_from_strike,
      });
    }
  }

  const marketPromise = getMarketContext();

  const positionPromises = positionsList.map(async (p) => {
    const fills = fillsByPosition.get(p.id) ?? [];
    const remaining = remainingContracts(fills);
    const strike = Number(p.strike);
    const expiry = p.expiry;
    const dte = daysBetween(now, new Date(expiry + "T00:00:00Z"));

    const spotPromise = withTimeout(getCurrentPrice(p.symbol), 5000, `spot(${p.symbol})`);
    const chainPromise = live
      ? withTimeout(getOptionsChain(p.symbol, expiry), 15000, `chain(${p.symbol})`)
      : Promise.resolve(null);
    const barsPromise = live
      ? withTimeout(
          getHistoricalPrices(
            p.symbol,
            new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000),
            now,
          ),
          5000,
          `bars(${p.symbol})`,
        ).then((r) => r ?? [])
      : Promise.resolve([] as Awaited<ReturnType<typeof getHistoricalPrices>>);

    const [yahooPrice, chain, bars] = await Promise.all([
      spotPromise,
      chainPromise,
      barsPromise,
    ]);

    const contract = chain ? pickContractFromChain(chain, strike, expiry) : null;
    const currentStockPrice =
      chain?.underlying?.mark ??
      chain?.underlying?.last ??
      chain?.underlyingPrice ??
      yahooPrice ??
      null;

    const mark = contract?.mark ?? null;
    const bid = contract?.bid ?? null;
    const ask = contract?.ask ?? null;
    const delta = contract?.delta ?? null;
    const theta = contract?.theta ?? null;
    const rawIv = contract?.volatility ?? null;
    const iv = rawIv !== null ? (rawIv > 1 ? rawIv / 100 : rawIv) : null;

    const premiumSold = Number(p.avg_premium_sold ?? 0);
    const pnlDollars =
      mark !== null && premiumSold > 0
        ? (premiumSold - mark) * remaining * 100
        : null;
    const pnlPct =
      mark !== null && premiumSold > 0 ? ((premiumSold - mark) / premiumSold) * 100 : null;

    const distanceToStrikePct =
      currentStockPrice !== null && currentStockPrice > 0
        ? ((currentStockPrice - strike) / currentStockPrice) * 100
        : null;

    const closesArr = bars.map((b) => b.close).filter((c) => c > 0);
    const twoDayDrop = isTwoDayDrop(closesArr);

    const momentum =
      currentStockPrice !== null ? postEarningsMomentum(null, currentStockPrice) : null;

    const rec = recommendPosition({
      profitPct: pnlPct ?? 0,
      distanceToStrikePct: distanceToStrikePct ?? 100,
      dte: Math.max(0, dte),
      entryDelta: null,
      currentDelta: delta,
      currentTheta: theta,
      entryStockPrice: null,
      currentStockPrice: currentStockPrice ?? 0,
      twoDayDrop,
      opportunityAvailable,
    });

    const thetaDecayTotal =
      theta !== null && dte > 0 ? theta * dte * remaining * 100 : null;

    const out: OpenPosition = {
      id: p.id,
      symbol: p.symbol,
      broker: p.broker,
      strike,
      expiry,
      optionType: "put",
      totalContracts: p.total_contracts,
      remainingContracts: remaining,
      avgPremiumSold: p.avg_premium_sold !== null ? Number(p.avg_premium_sold) : null,
      openedDate: p.opened_date,
      currentStockPrice,
      currentMark: mark,
      currentBid: bid,
      currentAsk: ask,
      currentDelta: delta,
      currentTheta: theta,
      currentIv: iv,
      dte: Math.max(0, dte),
      pnlDollars,
      pnlPct,
      distanceToStrikePct,
      thetaDecayTotal,
      momentum,
      urgency: rec.urgency,
      recommendationReason: rec.reason,
      postEarningsRec: recsByPosition.get(p.id) ?? null,
      fills: fills
        .slice()
        .sort((a, b) => a.fill_date.localeCompare(b.fill_date)),
      entryFinalGrade: (p as unknown as { entry_final_grade?: string | null }).entry_final_grade ?? null,
      entryCrushGrade: (p as unknown as { entry_crush_grade?: string | null }).entry_crush_grade ?? null,
      entryOpportunityGrade:
        (p as unknown as { entry_opportunity_grade?: string | null }).entry_opportunity_grade ?? null,
      entryIndustryGrade:
        (p as unknown as { entry_industry_grade?: string | null }).entry_industry_grade ?? null,
      entryRegimeGrade:
        (p as unknown as { entry_regime_grade?: string | null }).entry_regime_grade ?? null,
      entryIvEdge: (p as unknown as { entry_iv_edge?: number | null }).entry_iv_edge ?? null,
      entryEmPct: (p as unknown as { entry_em_pct?: number | null }).entry_em_pct ?? null,
      entryVix: (p as unknown as { entry_vix?: number | null }).entry_vix ?? null,
      entryStockPrice:
        (p as unknown as { entry_stock_price?: number | null }).entry_stock_price ?? null,
    };
    return out;
  });

  const [market, positions] = await Promise.all([
    marketPromise,
    Promise.all(positionPromises),
  ]);

  positions.sort((a, b) => {
    const u = URGENCY_ORDER[a.urgency] - URGENCY_ORDER[b.urgency];
    if (u !== 0) return u;
    return a.dte - b.dte;
  });

  return NextResponse.json({
    market,
    positions,
    opportunityAvailable,
    live,
  });
}

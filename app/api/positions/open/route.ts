import { NextRequest, NextResponse } from "next/server";
import { createServerClient, TradeRow } from "@/lib/supabase";
import { getOptionsChain, SchwabOptionContract } from "@/lib/schwab";
import { getCurrentPrice, getHistoricalPrices } from "@/lib/yahoo";
import { getMarketContext } from "@/lib/market";
import {
  recommendPosition,
  postEarningsMomentum,
  isTwoDayDrop,
  URGENCY_ORDER,
  type Urgency,
  type Momentum,
} from "@/lib/positions";

export const dynamic = "force-dynamic";
export const maxDuration = 60; // many symbols in parallel

type OpenPosition = {
  id: string;
  symbol: string;
  broker: string;
  action: "open";
  contracts: number;        // remaining contracts after child closes
  originalContracts: number;
  strike: number;
  expiry: string;
  optionType: "put";        // screener produces puts; extend later if needed
  premiumSold: number;
  tradeDate: string;
  entryStockPrice: number | null;
  entryDelta: number | null;
  // Live data
  currentStockPrice: number | null;
  currentMark: number | null;
  currentBid: number | null;
  currentAsk: number | null;
  currentDelta: number | null;
  currentTheta: number | null;
  currentIv: number | null;
  dte: number;
  // Derived
  pnlDollars: number | null;
  pnlPct: number | null;
  distanceToStrikePct: number | null;
  thetaDecayTotal: number | null; // theta * dte * contracts * 100 (dollar value)
  momentum: Momentum | null;
  urgency: Urgency;
  recommendationReason: string;
  // Partial close history for this parent.
  closes: Array<{
    id: string;
    closedAt: string | null;
    premiumBought: number | null;
    contracts: number;
  }>;
  unmatched: false;
};

type UnmatchedClose = {
  id: string;
  symbol: string;
  broker: string;
  action: "close";
  contracts: number;
  strike: number;
  expiry: string;
  premiumBought: number | null;
  closedAt: string | null;
  unmatched: true;
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
  // Schwab keys strikes as decimal strings; exact match first, then nearest.
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

export async function GET(req: NextRequest) {
  const opportunityAvailable =
    req.nextUrl.searchParams.get("opportunityAvailable") === "true";

  const supabase = createServerClient();
  const { data: rows, error } = await supabase
    .from("trades")
    .select("*")
    .order("trade_date", { ascending: false });
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const allTrades = (rows ?? []) as TradeRow[];

  // --- Diagnostic logs (kept in while we investigate the "0 positions"
  // issue from screenshot imports). Safe to trim later. ---
  const actionCounts: Record<string, number> = {};
  const closedAtSet = { set: 0, null: 0 };
  const parentIdSet = { set: 0, null: 0 };
  for (const t of allTrades) {
    const key = t.action === null || t.action === undefined ? "null" : String(t.action);
    actionCounts[key] = (actionCounts[key] ?? 0) + 1;
    if (t.closed_at) closedAtSet.set += 1;
    else closedAtSet.null += 1;
    if (t.parent_trade_id) parentIdSet.set += 1;
    else parentIdSet.null += 1;
  }
  console.log(
    `[positions] fetched ${allTrades.length} trades from supabase. ` +
      `action distribution: ${JSON.stringify(actionCounts)}. ` +
      `closed_at: ${JSON.stringify(closedAtSet)}. ` +
      `parent_trade_id: ${JSON.stringify(parentIdSet)}.`,
  );
  console.log(
    `[positions] opens filter: t.action === 'open' AND !t.closed_at`,
  );

  // action='open' AND not already closed via the legacy PATCH flow
  // (same-row closed_at set instead of a child close record).
  const opens = allTrades.filter((t) => t.action === "open" && !t.closed_at);
  const closes = allTrades.filter((t) => t.action === "close");
  console.log(
    `[positions] after filter — opens=${opens.length}, closes=${closes.length}. ` +
      `(raw opens before closed_at filter: ${allTrades.filter((t) => t.action === "open").length})`,
  );

  // Bucket closes by parent id for partial-close math.
  const closesByParent = new Map<string, TradeRow[]>();
  for (const c of closes) {
    if (!c.parent_trade_id) continue;
    const arr = closesByParent.get(c.parent_trade_id) ?? [];
    arr.push(c);
    closesByParent.set(c.parent_trade_id, arr);
  }

  // Compute remaining qty; only render positions with remaining > 0.
  const withRemaining = opens.map((p) => {
    const kids = closesByParent.get(p.id) ?? [];
    const closedQty = kids.reduce((sum, k) => sum + (k.contracts ?? 0), 0);
    const original = p.contracts ?? 1;
    return { parent: p, remaining: original - closedQty, kids, original };
  });
  const activeParents = withRemaining.filter((r) => r.remaining > 0);
  console.log(
    `[positions] remaining-qty filter: ${withRemaining.length} opens → ${activeParents.length} active ` +
      `(${withRemaining.length - activeParents.length} fully closed).`,
  );
  if (withRemaining.length > 0 && activeParents.length === 0) {
    console.warn(
      `[positions] ALL opens have remaining=0. Sample first 5:\n` +
        withRemaining
          .slice(0, 5)
          .map(
            (r) =>
              `  ${r.parent.symbol} ${r.parent.strike} ${r.parent.expiry} ` +
              `contracts=${r.original} closed=${r.original - r.remaining} remaining=${r.remaining} id=${r.parent.id}`,
          )
          .join("\n"),
    );
  }

  const now = new Date();

  // Fetch market context + per-position live data in parallel.
  const marketPromise = getMarketContext();
  const positionPromises = activeParents.map(async (r) => {
    const { parent, remaining, kids, original } = r;
    const symbol = parent.symbol;
    const strike = Number(parent.strike);
    const expiry = parent.expiry;
    const dte = daysBetween(now, new Date(expiry + "T00:00:00Z"));

    const [chain, yahooPrice, bars] = await Promise.all([
      getOptionsChain(symbol, expiry).catch((e) => {
        console.warn(`[positions:${symbol}] chain failed: ${e instanceof Error ? e.message : e}`);
        return null;
      }),
      getCurrentPrice(symbol),
      getHistoricalPrices(
        symbol,
        new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000),
        now,
      ),
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

    const premiumSold = Number(parent.premium_sold) || 0;
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

    const closes = bars.map((b) => b.close).filter((c) => c > 0);
    const twoDayDrop = isTwoDayDrop(closes);

    const entryStockPrice =
      parent.stock_price_at_entry ?? parent.entry_stock_price ?? null;
    const momentum =
      currentStockPrice !== null ? postEarningsMomentum(entryStockPrice, currentStockPrice) : null;

    const rec = recommendPosition({
      profitPct: pnlPct ?? 0,
      distanceToStrikePct: distanceToStrikePct ?? 100,
      dte: Math.max(0, dte),
      entryDelta: parent.delta_at_entry,
      currentDelta: delta,
      currentTheta: theta,
      entryStockPrice,
      currentStockPrice: currentStockPrice ?? 0,
      twoDayDrop,
      opportunityAvailable,
    });

    const thetaDecayTotal =
      theta !== null && dte > 0 ? theta * dte * remaining * 100 : null;

    const out: OpenPosition = {
      id: parent.id,
      symbol,
      broker: parent.broker ?? "schwab",
      action: "open",
      contracts: remaining,
      originalContracts: original,
      strike,
      expiry,
      optionType: "put",
      premiumSold,
      tradeDate: parent.trade_date,
      entryStockPrice,
      entryDelta: parent.delta_at_entry,
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
      closes: kids
        .sort((a, b) => (a.closed_at ?? a.trade_date).localeCompare(b.closed_at ?? b.trade_date))
        .map((k) => ({
          id: k.id,
          closedAt: k.closed_at,
          premiumBought: k.premium_bought,
          contracts: k.contracts ?? 0,
        })),
      unmatched: false,
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

  // Orphan closes: action='close' with no parent_trade_id. Surface for manual
  // reconciliation (matches user's "flag unmatched, don't reject" answer).
  const unmatchedCloses: UnmatchedClose[] = closes
    .filter((c) => c.parent_trade_id === null)
    .map((c) => ({
      id: c.id,
      symbol: c.symbol,
      broker: c.broker ?? "schwab",
      action: "close",
      contracts: c.contracts ?? 0,
      strike: Number(c.strike),
      expiry: c.expiry,
      premiumBought: c.premium_bought,
      closedAt: c.closed_at,
      unmatched: true,
    }));

  return NextResponse.json({
    market,
    positions,
    unmatchedCloses,
    opportunityAvailable,
  });
}

// Shared position_snapshots row builder. Used by:
//   - /api/screener/analyze: snapshots every open position on Run Analysis
//   - /api/trades/bulk-create: snapshots the position at close time
//
// Keep the per-field math in one place so the intraday time series has
// consistent units across both call sites.
import {
  getOptionsChain,
  type SchwabOptionContract,
  type SchwabOptionsChain,
} from "@/lib/schwab";
import { remainingContracts, type Fill } from "@/lib/positions";

export type SnapshotPosition = {
  id: string;
  symbol: string;
  strike: number;
  expiry: string;
  avg_premium_sold: number | null;
  opened_date: string | null;
  entry_stock_price: number | null;
  entry_em_pct: number | null;
};

export type SnapshotRow = {
  position_id: string;
  snapshot_time: string;
  stock_price: number | null;
  option_price: number | null;
  pnl_pct: number | null;
  pnl_dollars: number | null;
  current_iv: number | null;
  current_delta: number | null;
  current_theta: number | null;
  actual_move_pct: number | null;
  move_ratio: number | null;
  days_since_entry: number | null;
  pct_premium_remaining: number | null;
  close_snapshot: boolean;
};

// Pull the put at the given strike out of a Schwab chain. Snapshots
// work on the existing position's strike, so this is effectively an
// exact-match lookup with a fallback to the closest strike in case
// Schwab normalizes the key differently (e.g. "68" vs "68.0").
export function pickPutContract(
  chain: SchwabOptionsChain,
  strike: number,
  expiry: string,
): SchwabOptionContract | null {
  const keys = Object.keys(chain.putExpDateMap ?? {});
  const expKey = keys.find((k) => k.startsWith(expiry));
  if (!expKey) return null;
  const strikes = chain.putExpDateMap[expKey];
  const direct =
    strikes[String(Number(strike))] ?? strikes[strike.toFixed(2)] ?? null;
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

// Fetch the chain for a single (symbol, expiry) with graceful fallback.
// Callers above this layer (analyze route) prefer a batched parallel fetch;
// bulk-create close snapshots only ever need one chain per click.
export async function fetchChainSafe(
  symbol: string,
  expiry: string,
): Promise<SchwabOptionsChain | null> {
  try {
    return await getOptionsChain(symbol, expiry);
  } catch (e) {
    console.warn(
      `[snapshots] chain(${symbol},${expiry}) failed: ${e instanceof Error ? e.message : e}`,
    );
    return null;
  }
}

// Builds the full snapshot row for a position + live chain snapshot.
// Every computed field is null-safe: a position missing entry_stock_price
// or a missing chain just yields nulls on the dependent fields, we never
// throw. `closeSnapshot` tags rows captured at the moment the user closed
// so downstream analytics can separate "final condition" from "intraday".
export function buildSnapshotRow(
  position: SnapshotPosition,
  chain: SchwabOptionsChain | null,
  fills: Fill[],
  opts: { nowIso: string; closeSnapshot: boolean },
): SnapshotRow {
  const contract = chain ? pickPutContract(chain, Number(position.strike), position.expiry) : null;
  const optionPrice = contract?.mark ?? null;
  const stockPrice =
    chain?.underlying?.mark ??
    chain?.underlying?.last ??
    chain?.underlyingPrice ??
    null;

  const remaining = remainingContracts(fills);
  const soldPremium = Number(position.avg_premium_sold ?? 0);
  let pnlDollars: number | null = null;
  let pnlPct: number | null = null;
  if (optionPrice !== null && soldPremium > 0 && remaining > 0) {
    pnlDollars = (soldPremium - optionPrice) * remaining * 100;
    pnlPct = (soldPremium - optionPrice) / soldPremium;
  }

  // Schwab returns volatility as a percent (193.2 = 193.2% IV). Store as
  // decimal to match entry_em_pct / entry_iv_edge conventions.
  const currentIv =
    contract && Number.isFinite(contract.volatility) ? contract.volatility / 100 : null;
  const currentDelta =
    contract && Number.isFinite(contract.delta) ? contract.delta : null;
  const currentTheta =
    contract && Number.isFinite(contract.theta) ? contract.theta : null;

  const entryPx = Number(position.entry_stock_price ?? 0);
  const actualMovePct =
    stockPrice !== null && entryPx > 0 ? Math.abs(stockPrice - entryPx) / entryPx : null;
  const entryEm = Number(position.entry_em_pct ?? 0);
  const moveRatio =
    actualMovePct !== null && entryEm > 0 ? actualMovePct / entryEm : null;

  // opened_date is YYYY-MM-DD; parse as UTC midnight to avoid TZ drift.
  let daysSinceEntry: number | null = null;
  if (position.opened_date) {
    const openedMs = new Date(position.opened_date + "T00:00:00Z").getTime();
    const todayMs = new Date(opts.nowIso.slice(0, 10) + "T00:00:00Z").getTime();
    if (Number.isFinite(openedMs) && Number.isFinite(todayMs)) {
      daysSinceEntry = Math.max(0, Math.floor((todayMs - openedMs) / 86400000));
    }
  }

  // 1.0 = no decay, 0.0 = fully decayed, >1.0 = option now priced above entry.
  const pctPremiumRemaining =
    optionPrice !== null && soldPremium > 0 ? optionPrice / soldPremium : null;

  return {
    position_id: position.id,
    snapshot_time: opts.nowIso,
    stock_price: stockPrice,
    option_price: optionPrice,
    pnl_pct: pnlPct,
    pnl_dollars: pnlDollars,
    current_iv: currentIv,
    current_delta: currentDelta,
    current_theta: currentTheta,
    actual_move_pct: actualMovePct,
    move_ratio: moveRatio,
    days_since_entry: daysSinceEntry,
    pct_premium_remaining: pctPremiumRemaining,
    close_snapshot: opts.closeSnapshot,
  };
}

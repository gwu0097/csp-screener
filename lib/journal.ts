import type { TradeRow } from "./supabase";

// A "realized trade" is one open-close pair. The schema supports two shapes
// because we migrated from single-row close (legacy: same row has both
// premium_sold and premium_bought set) to parent+child close (new style,
// where each partial close is its own action='close' row linked via
// parent_trade_id). Both are unified into this flat type for aggregation.
export type RealizedTrade = {
  parentId: string;
  symbol: string;
  strike: number;
  expiry: string;
  broker: string;
  tradeDate: string;        // YYYY-MM-DD — when the sell-to-open happened
  closedAt: string;         // YYYY-MM-DD — when the buy-to-close happened
  premiumSold: number;
  premiumBought: number;
  contracts: number;
  pnl: number;              // dollars
  rocPct: number;           // (net credit / strike) * 100 — CSP return on collateral
  holdDays: number;
  dayOfWeek: number;        // 0 Sun .. 6 Sat — based on tradeDate
  strikeMultiple: number | null;
  crushGrade: string | null;
  opportunityGrade: string | null;
  outcome: "win" | "loss";
};

function toIso(d: string): string {
  return d.length >= 10 ? d.slice(0, 10) : d;
}

function daysBetween(aIso: string, bIso: string): number {
  const a = new Date(toIso(aIso) + "T00:00:00Z").getTime();
  const b = new Date(toIso(bIso) + "T00:00:00Z").getTime();
  return Math.max(0, Math.round((b - a) / (24 * 60 * 60 * 1000)));
}

function pairFromRows(parent: TradeRow, close: Pick<TradeRow, "closed_at" | "premium_bought" | "contracts">): RealizedTrade | null {
  const closedAt = close.closed_at;
  const premiumBought = close.premium_bought;
  if (!closedAt || premiumBought === null) return null;
  const strike = Number(parent.strike);
  if (!(strike > 0)) return null;
  const premiumSold = Number(parent.premium_sold);
  const contracts = close.contracts ?? parent.contracts ?? 1;
  const net = premiumSold - Number(premiumBought);
  const pnl = net * contracts * 100;
  const rocPct = (net / strike) * 100;
  return {
    parentId: parent.id,
    symbol: parent.symbol,
    strike,
    expiry: parent.expiry,
    broker: parent.broker ?? "schwab",
    tradeDate: toIso(parent.trade_date),
    closedAt: toIso(closedAt),
    premiumSold,
    premiumBought: Number(premiumBought),
    contracts,
    pnl,
    rocPct,
    holdDays: daysBetween(parent.trade_date, closedAt),
    dayOfWeek: new Date(toIso(parent.trade_date) + "T00:00:00Z").getUTCDay(),
    strikeMultiple: parent.strike_multiple !== null ? Number(parent.strike_multiple) : null,
    crushGrade: parent.crush_grade,
    opportunityGrade: parent.opportunity_grade,
    outcome: pnl >= 0 ? "win" : "loss",
  };
}

export function extractRealizedTrades(rows: TradeRow[]): RealizedTrade[] {
  const out: RealizedTrade[] = [];
  const byId = new Map<string, TradeRow>();
  for (const r of rows) byId.set(r.id, r);

  // New-style: action='close' children linked to an open parent.
  for (const c of rows) {
    if (c.action !== "close") continue;
    if (!c.parent_trade_id) continue;
    const parent = byId.get(c.parent_trade_id);
    if (!parent) continue;
    const t = pairFromRows(parent, c);
    if (t) out.push(t);
  }

  // Legacy: single row with premium_bought + closed_at set on the parent
  // itself AND no new-style child closes already consuming it.
  for (const r of rows) {
    if (r.action === "close") continue;
    if (r.premium_bought === null || !r.closed_at) continue;
    const hasChild = rows.some((x) => x.action === "close" && x.parent_trade_id === r.id);
    if (hasChild) continue;
    const t = pairFromRows(r, { closed_at: r.closed_at, premium_bought: r.premium_bought, contracts: r.contracts });
    if (t) out.push(t);
  }

  return out.sort((a, b) => a.closedAt.localeCompare(b.closedAt));
}

// ---------- Aggregates ----------

export type JournalSummary = {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;              // percent
  avgWin: number;
  avgLoss: number;
  expectancy: number;           // per-trade expected value
  realizedPnlAll: number;
  realizedPnlYtd: number;
  realizedPnlMonth: number;
  realizedPnlWeek: number;
  realizedPnlToday: number;
  avgRocPct: number;
  medianRocPct: number;
  bestRocPct: number;
  worstRocPct: number;
};

function sum(arr: number[]): number {
  return arr.reduce((a, b) => a + b, 0);
}

function median(sortedAsc: number[]): number {
  const n = sortedAsc.length;
  if (n === 0) return 0;
  return n % 2 ? sortedAsc[(n - 1) / 2] : (sortedAsc[n / 2 - 1] + sortedAsc[n / 2]) / 2;
}

export function computeSummary(trades: RealizedTrade[]): JournalSummary {
  const total = trades.length;
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const winRate = total > 0 ? (wins.length / total) * 100 : 0;
  const avgWin = wins.length > 0 ? sum(wins.map((t) => t.pnl)) / wins.length : 0;
  const avgLoss = losses.length > 0 ? sum(losses.map((t) => t.pnl)) / losses.length : 0;
  const expectancy = (winRate / 100) * avgWin + ((100 - winRate) / 100) * avgLoss;

  const today = new Date().toISOString().slice(0, 10);
  const year = today.slice(0, 4);
  const month = today.slice(0, 7);
  const weekCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const ytd = trades.filter((t) => t.closedAt >= `${year}-01-01`);
  const mth = trades.filter((t) => t.closedAt >= `${month}-01`);
  const wk = trades.filter((t) => t.closedAt >= weekCutoff);
  const td = trades.filter((t) => t.closedAt === today);

  const rocs = trades.map((t) => t.rocPct).sort((a, b) => a - b);
  return {
    totalTrades: total,
    wins: wins.length,
    losses: losses.length,
    winRate,
    avgWin,
    avgLoss,
    expectancy,
    realizedPnlAll: sum(trades.map((t) => t.pnl)),
    realizedPnlYtd: sum(ytd.map((t) => t.pnl)),
    realizedPnlMonth: sum(mth.map((t) => t.pnl)),
    realizedPnlWeek: sum(wk.map((t) => t.pnl)),
    realizedPnlToday: sum(td.map((t) => t.pnl)),
    avgRocPct: rocs.length > 0 ? sum(rocs) / rocs.length : 0,
    medianRocPct: median(rocs),
    bestRocPct: rocs.length > 0 ? rocs[rocs.length - 1] : 0,
    worstRocPct: rocs.length > 0 ? rocs[0] : 0,
  };
}

export type TickerRow = {
  symbol: string;
  pnl: number;
  wins: number;
  losses: number;
  total: number;
  winRate: number;
  avgRocPct: number;
  avgHoldDays: number;
};

export function computeByTicker(trades: RealizedTrade[]): TickerRow[] {
  const buckets = new Map<string, RealizedTrade[]>();
  for (const t of trades) {
    const arr = buckets.get(t.symbol) ?? [];
    arr.push(t);
    buckets.set(t.symbol, arr);
  }
  const rows: TickerRow[] = [];
  Array.from(buckets.entries()).forEach(([symbol, ts]) => {
    const wins = ts.filter((t: RealizedTrade) => t.pnl > 0).length;
    const losses = ts.filter((t: RealizedTrade) => t.pnl <= 0).length;
    rows.push({
      symbol,
      pnl: sum(ts.map((t: RealizedTrade) => t.pnl)),
      wins,
      losses,
      total: ts.length,
      winRate: ts.length > 0 ? (wins / ts.length) * 100 : 0,
      avgRocPct: ts.length > 0 ? sum(ts.map((t: RealizedTrade) => t.rocPct)) / ts.length : 0,
      avgHoldDays: ts.length > 0 ? sum(ts.map((t: RealizedTrade) => t.holdDays)) / ts.length : 0,
    });
  });
  return rows.sort((a, b) => b.pnl - a.pnl);
}

// ---------- Insights ----------

export type Bucket = { count: number; winRate: number; avgPnl: number };

function summarizeBucket(ts: RealizedTrade[]): Bucket {
  const wins = ts.filter((t) => t.pnl > 0).length;
  return {
    count: ts.length,
    winRate: ts.length > 0 ? (wins / ts.length) * 100 : 0,
    avgPnl: ts.length > 0 ? sum(ts.map((t) => t.pnl)) / ts.length : 0,
  };
}

export type StrikeInsight = {
  x15: Bucket;
  x20: Bucket;
  recommendation: string;
};

// Strike multiple buckets are tolerant: 1.5x = [1.25, 1.75), 2.0x = [1.75, 2.25).
export function computeStrikeInsight(trades: RealizedTrade[]): StrikeInsight {
  const has = trades.filter((t) => t.strikeMultiple !== null) as (RealizedTrade & { strikeMultiple: number })[];
  const x15 = summarizeBucket(has.filter((t) => t.strikeMultiple >= 1.25 && t.strikeMultiple < 1.75));
  const x20 = summarizeBucket(has.filter((t) => t.strikeMultiple >= 1.75 && t.strikeMultiple < 2.25));
  let recommendation = "Not enough labeled trades yet (log strike_multiple when opening)";
  if (x15.count >= 5 && x20.count >= 5) {
    // Risk-adjusted heuristic: win rate × avg P&L. A coarse proxy, not Sharpe.
    const s15 = x15.winRate * x15.avgPnl;
    const s20 = x20.winRate * x20.avgPnl;
    if (Math.abs(s15 - s20) / Math.max(Math.abs(s15), Math.abs(s20), 1) < 0.1) {
      recommendation = "1.5x and 2x are roughly equal — pick based on current IV";
    } else {
      recommendation = s15 > s20 ? "1.5x EM has the better risk-adjusted return so far" : "2x EM has the better risk-adjusted return so far";
    }
  }
  return { x15, x20, recommendation };
}

export type DayInsight = {
  day: string;
  dayIndex: number;
} & Bucket;

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function computeDayInsight(trades: RealizedTrade[]): DayInsight[] {
  const out: DayInsight[] = [];
  for (let d = 1; d <= 5; d++) {
    const bucket = summarizeBucket(trades.filter((t) => t.dayOfWeek === d));
    if (bucket.count > 0) {
      out.push({ day: DAY_NAMES[d], dayIndex: d, ...bucket });
    }
  }
  return out;
}

export type HoldBucket = "same-day" | "1 day" | "2+ days";
export type HoldInsight = { bucket: HoldBucket } & Bucket;

export function computeHoldInsight(trades: RealizedTrade[]): HoldInsight[] {
  return [
    { bucket: "same-day", ...summarizeBucket(trades.filter((t) => t.holdDays === 0)) },
    { bucket: "1 day", ...summarizeBucket(trades.filter((t) => t.holdDays === 1)) },
    { bucket: "2+ days", ...summarizeBucket(trades.filter((t) => t.holdDays >= 2)) },
  ];
}

export type EquityPoint = { date: string; pnl: number; cumPnl: number };

// Equity curve = realized cumulative P&L over time, ordered by closedAt.
// Multiple closes on the same day are summed into one point so the chart
// doesn't zig-zag intra-day.
export function computeEquityCurve(trades: RealizedTrade[]): EquityPoint[] {
  const byDate = new Map<string, number>();
  for (const t of trades) {
    byDate.set(t.closedAt, (byDate.get(t.closedAt) ?? 0) + t.pnl);
  }
  const dates = Array.from(byDate.keys()).sort();
  let running = 0;
  const points: EquityPoint[] = [];
  for (const date of dates) {
    const pnl = byDate.get(date) ?? 0;
    running += pnl;
    points.push({ date, pnl, cumPnl: running });
  }
  return points;
}

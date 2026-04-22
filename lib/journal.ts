// Types consumed by the journal UI (components/journal-view.tsx,
// components/equity-curve.tsx). The aggregation logic that used to live
// here ran against the old single-row trades table; it now lives in
// app/api/journal/stats/route.ts against the positions+fills schema.

export type RealizedTrade = {
  parentId: string;
  symbol: string;
  strike: number;
  expiry: string;
  broker: string;
  tradeDate: string; // YYYY-MM-DD — when the sell-to-open happened
  closedAt: string;  // YYYY-MM-DD — when the buy-to-close happened
  premiumSold: number;
  premiumBought: number;
  contracts: number;
  pnl: number;       // dollars
  rocPct: number;    // (net credit / strike) * 100
  holdDays: number;
  dayOfWeek: number; // 0 Sun .. 6 Sat
  strikeMultiple: number | null;
  crushGrade: string | null;
  opportunityGrade: string | null;
  outcome: "win" | "loss";
};

export type JournalSummary = {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
  expectancy: number;
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

export type Bucket = { count: number; winRate: number; avgPnl: number };

export type StrikeInsight = {
  x15: Bucket;
  x20: Bucket;
  recommendation: string;
};

export type DayInsight = { day: string; dayIndex: number } & Bucket;
export type HoldBucket = "same-day" | "1 day" | "2+ days";
export type HoldInsight = { bucket: HoldBucket } & Bucket;

export type EquityPoint = { date: string; pnl: number; cumPnl: number };

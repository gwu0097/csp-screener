// Shared types + recommendation engine for /positions.
// Pure functions: no I/O here, so they're trivially unit-testable.
//
// Two layers live here:
//   1. Recommendation engine (Urgency/Momentum + recommendPosition)
//   2. Fill aggregation helpers (remaining contracts, avg premiums, pnl)
//
// The fill helpers back the new positions+fills schema: every trade order
// is a Fill row, summed into a Position row by symbol/strike/expiry/broker.

// ---------- Fill aggregation ----------

export type FillType = "open" | "close";

export type Fill = {
  fill_type: FillType;
  contracts: number;
  premium: number;
  fill_date: string;
};

export type PositionRow = {
  id: string;
  symbol: string;
  strike: number;
  expiry: string;
  broker: string;
  total_contracts: number;
  avg_premium_sold: number | null;
  status: "open" | "closed";
  opened_date: string;
  closed_date: string | null;
  realized_pnl: number | null;
  fills?: Fill[];
};

// Remaining open contracts on a position = opens - closes. Zero when the
// position is fully closed out.
export function remainingContracts(fills: Fill[]): number {
  const opened = fills
    .filter((f) => f.fill_type === "open")
    .reduce((sum, f) => sum + f.contracts, 0);
  const closed = fills
    .filter((f) => f.fill_type === "close")
    .reduce((sum, f) => sum + f.contracts, 0);
  return opened - closed;
}

// Contract-weighted average premium across all open fills.
export function avgPremiumSold(fills: Fill[]): number {
  const opens = fills.filter((f) => f.fill_type === "open");
  const totalContracts = opens.reduce((s, f) => s + f.contracts, 0);
  if (totalContracts === 0) return 0;
  const totalPremium = opens.reduce((s, f) => s + f.premium * f.contracts, 0);
  return totalPremium / totalContracts;
}

// Contract-weighted average premium across all close fills.
export function avgPremiumBought(fills: Fill[]): number {
  const closes = fills.filter((f) => f.fill_type === "close");
  const totalContracts = closes.reduce((s, f) => s + f.contracts, 0);
  if (totalContracts === 0) return 0;
  const totalPremium = closes.reduce((s, f) => s + f.premium * f.contracts, 0);
  return totalPremium / totalContracts;
}

// Realized P&L in dollars: (avg sold − avg bought) × contracts_closed × 100.
// Positive when the short closed for less credit than received.
export function realizedPnl(fills: Fill[]): number {
  const sold = avgPremiumSold(fills);
  const bought = avgPremiumBought(fills);
  const closedContracts = fills
    .filter((f) => f.fill_type === "close")
    .reduce((s, f) => s + f.contracts, 0);
  return (sold - bought) * closedContracts * 100;
}

// ---------- Recommendation engine ----------

export type Urgency = "EMERGENCY_CUT" | "CUT" | "MONITOR" | "HOLD";
export type Momentum = "BULLISH" | "NEUTRAL" | "BEARISH";

export const URGENCY_ORDER: Record<Urgency, number> = {
  EMERGENCY_CUT: 0,
  CUT: 1,
  MONITOR: 2,
  HOLD: 3,
};

export type PositionSignals = {
  profitPct: number;            // % of premium captured: 50 = half the credit pocketed
  distanceToStrikePct: number;  // (stock - strike) / stock * 100
  dte: number;
  entryDelta: number | null;
  currentDelta: number | null;
  currentTheta: number | null;  // buyer-perspective: <0 means seller benefits
  entryStockPrice: number | null;
  currentStockPrice: number;
  twoDayDrop: boolean;          // two consecutive down days in the last few bars
  opportunityAvailable: boolean;// screener has today's Strong/Marginal candidates
};

// Decides what to do with an open CSP. Order of checks matters — first match
// wins, and the order reflects user-spec priority (EMERGENCY > CUT > MONITOR
// > HOLD). See the spec under "GET /api/positions/open" in the project README.
export function recommendPosition(s: PositionSignals): { urgency: Urgency; reason: string } {
  const absEntryDelta = s.entryDelta !== null ? Math.abs(s.entryDelta) : null;
  const absCurrDelta = s.currentDelta !== null ? Math.abs(s.currentDelta) : null;
  const deltaDoubled =
    absEntryDelta !== null && absCurrDelta !== null && absEntryDelta > 0
      ? absCurrDelta >= 2 * absEntryDelta
      : false;
  const deltaIncreasedSignificantly =
    absEntryDelta !== null && absCurrDelta !== null && absEntryDelta > 0
      ? absCurrDelta >= 1.5 * absEntryDelta
      : false;
  const stockTrendingAway =
    s.entryStockPrice !== null && s.currentStockPrice > s.entryStockPrice;
  const thetaStillWorking =
    s.currentTheta !== null && s.currentTheta < 0 && s.dte > 0;
  const safeDistance = s.distanceToStrikePct >= 10;

  // EMERGENCY_CUT
  if (s.distanceToStrikePct < 2) {
    return { urgency: "EMERGENCY_CUT", reason: "Stock less than 2% from strike — assignment risk" };
  }
  if (s.twoDayDrop && s.distanceToStrikePct < 8) {
    return {
      urgency: "EMERGENCY_CUT",
      reason: "Two consecutive down days and cushion under 8% — exit before gap down",
    };
  }

  // CUT
  if (s.profitPct >= 70) {
    return { urgency: "CUT", reason: `${s.profitPct.toFixed(0)}% of credit captured — take the win` };
  }
  if (s.profitPct >= 50 && s.opportunityAvailable) {
    return {
      urgency: "CUT",
      reason: "50%+ captured and a better setup is on today's screener",
    };
  }
  if (deltaDoubled && s.profitPct < 20) {
    return {
      urgency: "CUT",
      reason: "Delta doubled but premium hasn't — stock moving against you",
    };
  }
  if (s.dte === 1) {
    return { urgency: "CUT", reason: "1 DTE — close or roll before expiry" };
  }

  // MONITOR
  if (s.profitPct >= 30 && s.profitPct < 50 && deltaIncreasedSignificantly) {
    return {
      urgency: "MONITOR",
      reason: "Profit 30-50% but delta climbing — tighten your trigger",
    };
  }
  if (s.distanceToStrikePct < 5) {
    return {
      urgency: "MONITOR",
      reason: `Only ${s.distanceToStrikePct.toFixed(1)}% from strike`,
    };
  }
  if (s.profitPct < 0 && s.dte > 1) {
    return {
      urgency: "MONITOR",
      reason: `Down ${(-s.profitPct).toFixed(0)}% on the credit — watch closely`,
    };
  }

  // HOLD
  if (s.profitPct >= 30 && s.profitPct < 50 && stockTrendingAway) {
    return { urgency: "HOLD", reason: "30-50% captured and stock drifting away from strike" };
  }
  if (s.profitPct < 30 && thetaStillWorking && safeDistance) {
    return { urgency: "HOLD", reason: "Theta working, safe distance — let it ride" };
  }
  return { urgency: "HOLD", reason: "No exit trigger hit" };
}

// Post-earnings momentum proxy: we don't store "price at earnings" per trade,
// but CSPs are opened shortly after the announcement, so entry price is close
// enough. ±2% is our neutrality band.
export function postEarningsMomentum(
  entryPrice: number | null,
  currentPrice: number,
): Momentum | null {
  if (entryPrice === null || entryPrice <= 0) return null;
  const pct = (currentPrice - entryPrice) / entryPrice;
  if (pct > 0.02) return "BULLISH";
  if (pct < -0.02) return "BEARISH";
  return "NEUTRAL";
}

// True if the last two closes are strictly descending (implying momentum is
// down). Expects `closes` sorted oldest-first; uses only the final two bars.
export function isTwoDayDrop(closes: number[]): boolean {
  if (closes.length < 3) return false;
  const [c3, c2, c1] = closes.slice(-3);
  return c1 < c2 && c2 < c3;
}

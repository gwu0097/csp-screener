// Pure exit-urgency rules for an open option position (no I/O) — split
// out of lib/positions.ts so it can be unit-tested with node --test.
// lib/positions.ts re-exports everything here for existing importers.

export type Urgency = "EMERGENCY_CUT" | "CUT" | "MONITOR" | "HOLD";
export type Momentum = "BULLISH" | "NEUTRAL" | "BEARISH";

export const URGENCY_ORDER: Record<Urgency, number> = {
  EMERGENCY_CUT: 0,
  CUT: 1,
  MONITOR: 2,
  HOLD: 3,
};

export type PositionSignals = {
  profitPct: number | null;            // % of premium captured: 50 = half the credit pocketed
  // Safety-signed distance: positive = OTM/safe, negative = ITM —
  // already flipped for calls by the caller via safetyNumerator().
  // See that function's comment for why the raw (stock-strike)/stock
  // sign can't be used directly once calls exist.
  distanceToStrikePct: number;
  dte: number;
  entryDelta: number | null;
  currentDelta: number | null;
  currentTheta: number | null;  // buyer-perspective: <0 means seller benefits
  entryStockPrice: number | null;
  currentStockPrice: number;
  twoDayDrop: boolean;          // two consecutive down days in the last few bars
  opportunityAvailable: boolean;// screener has today's Strong/Marginal candidates
  optionType: "put" | "call";
};

// Decides what to do with an open CSP. Order of checks matters — first match
// wins, and the order reflects user-spec priority (EMERGENCY > CUT > MONITOR
// > HOLD). See the spec under "GET /api/positions/open" in the project README.
export function recommendPosition(s: PositionSignals): { urgency: Urgency; reason: string } {
  // profitPct null = P&L unknown (no mark, no recent snapshot). Every
  // profit-based rule is skipped rather than reading it as 0% captured;
  // the distance/delta rules still apply, and the fallthrough says so.
  const profit = s.profitPct;
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
  // "Away" means away from the strike, in the safe direction — up for
  // a put (strike is below), down for a call (strike is above).
  const stockTrendingAway =
    s.entryStockPrice !== null &&
    (s.optionType === "call"
      ? s.currentStockPrice < s.entryStockPrice
      : s.currentStockPrice > s.entryStockPrice);
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
  if (profit !== null && profit >= 70) {
    return { urgency: "CUT", reason: `${profit.toFixed(0)}% of credit captured — take the win` };
  }
  if (profit !== null && profit >= 50 && s.opportunityAvailable) {
    return {
      urgency: "CUT",
      reason: "50%+ captured and a better setup is on today's screener",
    };
  }
  if (deltaDoubled && profit !== null && profit < 20) {
    return {
      urgency: "CUT",
      reason: "Delta doubled but premium hasn't — stock moving against you",
    };
  }
  if (s.dte === 1) {
    return { urgency: "CUT", reason: "1 DTE — close or roll before expiry" };
  }

  // MONITOR
  if (profit !== null && profit >= 30 && profit < 50 && deltaIncreasedSignificantly) {
    return {
      urgency: "MONITOR",
      reason: "Profit 30-50% but delta climbing — tighten your trigger",
    };
  }
  if (s.distanceToStrikePct < 5) {
    return {
      urgency: "MONITOR",
      reason: `Only ${s.distanceToStrikePct.toFixed(1)}% from strike${profit === null ? " (P&L unverified)" : ""}`,
    };
  }
  if (profit !== null && profit < 0 && s.dte > 1) {
    return {
      urgency: "MONITOR",
      reason: `Down ${(-profit).toFixed(0)}% on the credit — watch closely`,
    };
  }

  // HOLD
  if (profit === null) {
    return { urgency: "HOLD", reason: "No distance trigger hit — P&L unverified (no recent price)" };
  }
  if (profit >= 30 && profit < 50 && stockTrendingAway) {
    return { urgency: "HOLD", reason: "30-50% captured and stock drifting away from strike" };
  }
  if (profit < 30 && thetaStillWorking && safeDistance) {
    return { urgency: "HOLD", reason: "Theta working, safe distance — let it ride" };
  }
  return { urgency: "HOLD", reason: "No exit trigger hit" };
}

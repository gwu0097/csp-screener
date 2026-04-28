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
  // Present when the row was hydrated from /api/positions/open. Optional
  // so the type stays compatible with paths that don't carry the id
  // (tests, internal aggregators).
  id?: string;
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

// Refetch fills, recompute aggregates, and write them back onto the
// position row. Shared between bulk-create's per-fill loop and the
// add/edit/delete fill routes used by the position-card edit panel.
// The supabase client param uses the project's `RestClient` wrapper —
// any object with a Supabase-shaped `.from(...)` call works.
//
// Returns the recomputed status so callers can fire post-close hooks
// (the screener-results outcome recorder, for example) only when this
// recalc actually flipped the position.
type RecalcClient = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from: (table: string) => any;
};
export async function recalculatePositionFromFills(
  positionId: string,
  sb: RecalcClient,
): Promise<
  | { ok: true; status: "open" | "closed"; totalOpened: number; remaining: number }
  | { ok: false; error: string }
> {
  const fetched = await sb
    .from("fills")
    .select("fill_type, contracts, premium, fill_date")
    .eq("position_id", positionId);
  if (fetched.error) {
    return { ok: false, error: `refetch fills failed — ${fetched.error.message}` };
  }
  const fills = (fetched.data ?? []) as Fill[];
  const remaining = remainingContracts(fills);
  const totalOpened = fills
    .filter((f) => f.fill_type === "open")
    .reduce((s, f) => s + f.contracts, 0);
  const sold = avgPremiumSold(fills);
  const status: "open" | "closed" =
    remaining === 0 && totalOpened > 0 ? "closed" : "open";
  const closedDate =
    status === "closed"
      ? fills
          .filter((f) => f.fill_type === "close")
          .map((f) => f.fill_date)
          .sort()
          .pop() ?? null
      : null;
  const pnl = realizedPnl(fills);
  const upd = await sb
    .from("positions")
    .update({
      total_contracts: totalOpened,
      avg_premium_sold: totalOpened > 0 ? sold : null,
      status,
      closed_date: closedDate,
      realized_pnl: pnl,
      updated_at: new Date().toISOString(),
    })
    .eq("id", positionId);
  if (upd.error) {
    return { ok: false, error: `position update failed — ${upd.error.message}` };
  }
  return { ok: true, status, totalOpened, remaining };
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

// ---------- Priority-based status badge ----------
//
// Replaces the mechanical urgency enum with a priority cascade that reads
// every intelligence signal we have (expiry date, latest snapshot, most
// recent post-earnings rec, live stock price) and emits a single status
// badge + tooltip. First matching rule wins.
//
// Priority order:
//   1. Expiry day — ITM / PIN RISK / EXPIRING / MONITOR variants
//   2. Post-earnings recommendation (HIGH/MEDIUM confidence only)
//   3. Max profit (pct_premium_remaining < 10% OR deep OTM fallback)
//   4. Move-ratio danger (realized > 1.2× implied, still has DTE)
//   5. Delta health check (>|0.35| emergency, >|0.20| monitor)
//   6. Default: HOLD
//
// Pure function — no DB, no I/O. Callers pass the already-fetched
// snapshot + rec so this stays cheap to call in a tight loop.

export type BadgeColor = "green" | "amber" | "red";
export type BadgeResult = {
  badge: string;
  label: string;
  color: BadgeColor;
  tooltip: string;
  ruleFired: string;
};

export type PositionBadgeInput = {
  position: { strike: number; expiry: string };
  latestSnapshot: {
    stock_price: number | null;
    option_price: number | null;
    current_delta: number | null;
    move_ratio: number | null;
    pct_premium_remaining: number | null;
  } | null;
  postEarningsRec: {
    recommendation: "CLOSE" | "HOLD" | "PARTIAL" | "MONITOR";
    confidence: "HIGH" | "MEDIUM" | "LOW";
    reasoning: string;
  } | null;
  currentStockPrice: number | null;
};

function todayUtcIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function firstSentence(s: string): string {
  const idx = s.indexOf(".");
  if (idx < 0) return s.trim();
  return s.slice(0, idx + 1).trim();
}

export function computePositionBadge(input: PositionBadgeInput): BadgeResult {
  const { position, latestSnapshot, postEarningsRec, currentStockPrice } = input;
  const today = todayUtcIso();
  const isExpiryDay = position.expiry === today;

  const stockPrice =
    currentStockPrice ?? latestSnapshot?.stock_price ?? null;
  const optionPrice = latestSnapshot?.option_price ?? null;
  const pctFromStrike =
    stockPrice !== null && position.strike > 0
      ? (stockPrice - position.strike) / position.strike
      : null;

  // ---------- PRIORITY 1: expiry day ----------
  if (isExpiryDay) {
    // ITM — real danger on expiry day
    if (pctFromStrike !== null && pctFromStrike < -0.005) {
      return {
        badge: "EMERGENCY_CUT",
        label: "EMERGENCY CUT",
        color: "red",
        tooltip:
          "Position is ITM on expiry day. Assignment risk is real. Close immediately.",
        ruleFired: "EXPIRY_ITM",
      };
    }
    // Pin risk — within 1% OTM
    if (
      pctFromStrike !== null &&
      pctFromStrike >= -0.005 &&
      pctFromStrike < 0.01
    ) {
      return {
        badge: "PIN_RISK",
        label: "PIN RISK",
        color: "amber",
        tooltip: `Stock is ${(pctFromStrike * 100).toFixed(1)}% from strike on expiry day. Pin risk possible — monitor closely until market close.`,
        ruleFired: "EXPIRY_PIN_RISK",
      };
    }
    // Clearly expiring worthless:
    //  - Deep OTM (>= 20%) regardless of option price
    //  - Normal OTM (>= 2%) with option near zero (< $0.15) or unknown
    if (
      pctFromStrike !== null &&
      (pctFromStrike >= 0.2 ||
        (pctFromStrike >= 0.02 && (optionPrice === null || optionPrice < 0.15)))
    ) {
      return {
        badge: "EXPIRING",
        label: "EXPIRING ✓",
        color: "green",
        tooltip: `${(pctFromStrike * 100).toFixed(1)}% OTM on expiry day — expires worthless. Closing costs exceed remaining risk.`,
        ruleFired: "EXPIRY_WORTHLESS",
      };
    }
    // OTM but option still has residual value — monitor through close.
    if (pctFromStrike !== null && pctFromStrike >= 0.01) {
      return {
        badge: "MONITOR",
        label: "MONITOR",
        color: "amber",
        tooltip:
          "Expiry today. OTM but option still has residual value. Watch through close.",
        ruleFired: "EXPIRY_MONITOR",
      };
    }
    // Expiry day but no price data — fall through to lower priorities.
  }

  // ---------- PRIORITY 2: post-earnings rec (HIGH/MEDIUM only) ----------
  if (
    postEarningsRec &&
    (postEarningsRec.confidence === "HIGH" || postEarningsRec.confidence === "MEDIUM")
  ) {
    const r = postEarningsRec.recommendation;
    const c = postEarningsRec.confidence;
    const sentence = firstSentence(postEarningsRec.reasoning);
    if (r === "CLOSE" && c === "HIGH") {
      return {
        badge: "CLOSE",
        label: "CLOSE",
        color: "red",
        tooltip: `Post-earnings: ${sentence}`,
        ruleFired: "POST_EARNINGS_CLOSE_HIGH",
      };
    }
    if (r === "HOLD" && c === "HIGH") {
      return {
        badge: "HOLD",
        label: "HOLD",
        color: "green",
        tooltip: `Post-earnings: ${sentence}`,
        ruleFired: "POST_EARNINGS_HOLD_HIGH",
      };
    }
    if (r === "CLOSE" && c === "MEDIUM") {
      return {
        badge: "MONITOR",
        label: "MONITOR",
        color: "amber",
        tooltip: `Post-earnings leans close (medium confidence): ${sentence}`,
        ruleFired: "POST_EARNINGS_CLOSE_MEDIUM",
      };
    }
    if (r === "HOLD" && c === "MEDIUM") {
      return {
        badge: "HOLD",
        label: "HOLD",
        color: "green",
        tooltip: `Post-earnings leans hold (medium confidence): ${sentence}`,
        ruleFired: "POST_EARNINGS_HOLD_MEDIUM",
      };
    }
    if (r === "PARTIAL") {
      return {
        badge: "MONITOR",
        label: "PARTIAL",
        color: "amber",
        tooltip: `Post-earnings: consider closing 50%. ${sentence}`,
        ruleFired: "POST_EARNINGS_PARTIAL",
      };
    }
    // LOW confidence and anything else falls through.
  }

  // ---------- PRIORITY 3: max profit (premium captured) ----------
  const pctPremiumRemaining = latestSnapshot?.pct_premium_remaining ?? null;
  // Deep OTM fallback when we don't have pct_premium_remaining —
  // stock >20% above strike on a put means the option is functionally
  // worthless even without an option price to confirm.
  const deepOtm =
    pctFromStrike !== null && pctFromStrike > 0.2;
  if (
    (pctPremiumRemaining !== null && pctPremiumRemaining < 0.1) ||
    (pctPremiumRemaining === null && deepOtm)
  ) {
    const captured =
      pctPremiumRemaining !== null
        ? `${Math.round((1 - pctPremiumRemaining) * 100)}%`
        : ">90%";
    return {
      badge: "MAX_PROFIT",
      label: "MAX PROFIT",
      color: "green",
      tooltip: `${captured} of premium captured. Closing costs exceed remaining value — let it expire.`,
      ruleFired: "MAX_PROFIT",
    };
  }

  // ---------- PRIORITY 4: move ratio danger ----------
  const moveRatio = latestSnapshot?.move_ratio ?? null;
  const daysToExpiry = (() => {
    const t = new Date(today + "T00:00:00Z").getTime();
    const e = new Date(position.expiry + "T00:00:00Z").getTime();
    if (!Number.isFinite(t) || !Number.isFinite(e)) return 0;
    return Math.floor((e - t) / 86400000);
  })();
  if (moveRatio !== null && moveRatio > 1.2 && daysToExpiry > 0) {
    return {
      badge: "CLOSE",
      label: "CLOSE",
      color: "red",
      tooltip: `Stock moved ${moveRatio.toFixed(2)}x the implied move. Premium likely expanded — consider closing.`,
      ruleFired: "MOVE_RATIO_EXCEEDED",
    };
  }

  // ---------- PRIORITY 5: delta health ----------
  const delta = latestSnapshot?.current_delta ?? null;
  if (delta !== null && Math.abs(delta) > 0.35) {
    return {
      badge: "EMERGENCY_CUT",
      label: "EMERGENCY CUT",
      color: "red",
      tooltip: `Delta ${delta.toFixed(2)} — high assignment risk. Position has moved significantly against you.`,
      ruleFired: "DELTA_HIGH",
    };
  }
  if (delta !== null && Math.abs(delta) > 0.2) {
    return {
      badge: "MONITOR",
      label: "MONITOR",
      color: "amber",
      tooltip: `Delta ${delta.toFixed(2)} — position needs monitoring. Watch for further movement toward strike.`,
      ruleFired: "DELTA_ELEVATED",
    };
  }

  // ---------- DEFAULT ----------
  return {
    badge: "HOLD",
    label: "HOLD",
    color: "green",
    tooltip: "Position looks healthy. No action needed.",
    ruleFired: "DEFAULT_HOLD",
  };
}

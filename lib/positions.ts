// Shared types + recommendation engine for /positions.
// Pure functions: no I/O here, so they're trivially unit-testable.

import { isAfterMarketCloseET } from "@/lib/expire-positions";
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

// 'short' = sold-to-open (CSP credit, the historical default).
// 'long'  = bought-to-open (long calls/puts). Inverts the realized
// P&L sign — see realizedPnl() below.
export type PositionDirection = "short" | "long";

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
  // Optional so legacy reads (and pre-migration deploys) compile —
  // every consumer falls back to 'short' when missing. The column has
  // DEFAULT 'short' so every existing row materializes correctly once
  // the migration lands.
  direction?: PositionDirection | null;
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

// Realized P&L in dollars.
//   short: (avg_open_credit − avg_close_debit) × contracts × 100
//          positive when the short was bought back for less than sold.
//   long:  (avg_close_credit − avg_open_debit) × contracts × 100
//          positive when the long was sold for more than paid.
// The `avgPremiumSold` / `avgPremiumBought` helper names reflect the
// CSP-default semantics — on a long position they're really
// "open paid" / "close received". The function names are stable for
// readability; only the sign flips.
export function realizedPnl(
  fills: Fill[],
  direction: PositionDirection = "short",
): number {
  const openAvg = avgPremiumSold(fills);
  const closeAvg = avgPremiumBought(fills);
  const closedContracts = fills
    .filter((f) => f.fill_type === "close")
    .reduce((s, f) => s + f.contracts, 0);
  if (direction === "long") {
    return (closeAvg - openAvg) * closedContracts * 100;
  }
  return (openAvg - closeAvg) * closedContracts * 100;
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
  | {
      ok: true;
      status: "open" | "closed" | "expired_worthless" | "assigned";
      totalOpened: number;
      remaining: number;
    }
  | { ok: false; error: string }
> {
  // Fetch direction first so the realized-P&L formula picks the right
  // sign for long vs short positions. Pre-migration rows return the
  // column as undefined (or the whole select errors with "column
  // missing") — falling back to 'short' keeps existing CSP math intact.
  // position_type drives the share-vs-contract math below; entry_stock_price
  // is the cost-basis fallback for stock positions whose `open` fill predates
  // the open-fill-on-assignment fix. status/closed_date/expiry feed the
  // terminal-status guard below.
  let direction: PositionDirection = "short";
  let positionType: string | null = null;
  let entryStockPrice: number | null = null;
  let currentStatus: string | null = null;
  let existingClosedDate: string | null = null;
  let expiry: string | null = null;
  const posRes = await sb
    .from("positions")
    .select("direction, position_type, entry_stock_price, status, closed_date, expiry")
    .eq("id", positionId)
    .limit(1);
  if (!posRes.error) {
    const row = (posRes.data ?? [])[0] as
      | {
          direction?: string | null;
          position_type?: string | null;
          entry_stock_price?: number | null;
          status?: string | null;
          closed_date?: string | null;
          expiry?: string | null;
        }
      | undefined;
    if (row?.direction === "long") direction = "long";
    positionType = row?.position_type ?? null;
    entryStockPrice =
      typeof row?.entry_stock_price === "number" ? row.entry_stock_price : null;
    currentStatus = row?.status ?? null;
    existingClosedDate = row?.closed_date ?? null;
    expiry = row?.expiry ?? null;
  }

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
  const lastCloseDate =
    fills
      .filter((f) => f.fill_type === "close")
      .map((f) => f.fill_date)
      .sort()
      .pop() ?? null;

  // Stock positions: `contracts` are shares, the `open` fill is the
  // assignment (entry) and `close` fills are sales. total_contracts
  // tracks REMAINING shares (so a fully-sold lot reads 0), and realized
  // P&L is (sale − cost basis) × shares with NO ×100 options multiplier.
  if (positionType === "stock_long") {
    const opens = fills.filter((f) => f.fill_type === "open");
    const openShares = opens.reduce((s, f) => s + f.contracts, 0);
    const openValue = opens.reduce((s, f) => s + f.premium * f.contracts, 0);
    const costBasis =
      openShares > 0 ? openValue / openShares : entryStockPrice ?? 0;
    const stockPnl = fills
      .filter((f) => f.fill_type === "close")
      .reduce((s, f) => s + (f.premium - costBasis) * f.contracts, 0);
    const remainingShares = remaining; // open − close shares
    const stockStatus: "open" | "closed" =
      remainingShares <= 0 && openShares > 0 ? "closed" : "open";
    const upd = await sb
      .from("positions")
      .update({
        total_contracts: Math.max(0, remainingShares),
        avg_premium_sold: null,
        status: stockStatus,
        closed_date: stockStatus === "closed" ? lastCloseDate : null,
        realized_pnl: Math.round(stockPnl * 100) / 100,
        updated_at: new Date().toISOString(),
      })
      .eq("id", positionId);
    if (upd.error) {
      return { ok: false, error: `position update failed — ${upd.error.message}` };
    }
    return { ok: true, status: stockStatus, totalOpened: openShares, remaining: remainingShares };
  }

  const sold = avgPremiumSold(fills);

  // Terminal-status guard: expired_worthless / assigned positions were
  // closed by expiry accounting. Newer rows have the synthetic $0 close
  // in the ledger; legacy ones don't (the expire flow used to only
  // UPDATE the position row). Either way, never flip them back to
  // "open" — that would resurface them in the expiry modal and wipe
  // the recorded outcome. Any ledger remainder is treated as closed at
  // $0 on the recorded close date, matching lib/expire-positions.
  if (currentStatus === "expired_worthless" || currentStatus === "assigned") {
    const augmented: Fill[] =
      remaining > 0
        ? [
            ...fills,
            {
              fill_type: "close",
              contracts: remaining,
              premium: 0,
              fill_date: existingClosedDate ?? expiry ?? lastCloseDate ?? "",
            },
          ]
        : fills;
    const terminalPnl =
      Math.round(realizedPnl(augmented, direction) * 100) / 100;
    const upd = await sb
      .from("positions")
      .update({
        total_contracts: totalOpened,
        avg_premium_sold: totalOpened > 0 ? sold : null,
        status: currentStatus,
        closed_date: existingClosedDate ?? expiry ?? lastCloseDate,
        realized_pnl: terminalPnl,
        updated_at: new Date().toISOString(),
      })
      .eq("id", positionId);
    if (upd.error) {
      return { ok: false, error: `position update failed — ${upd.error.message}` };
    }
    return { ok: true, status: currentStatus, totalOpened, remaining: 0 };
  }

  const status: "open" | "closed" =
    remaining === 0 && totalOpened > 0 ? "closed" : "open";
  const closedDate = status === "closed" ? lastCloseDate : null;
  const pnl = realizedPnl(fills, direction);
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

// Covered-call assignment ("called away") is the mirror image of a
// put assignment: instead of creating a new stock_long lot, shares
// leave an EXISTING one. Used by both the early "Mark as assigned"
// button (mark-assigned/route.ts) and the bulk expiry-confirmation
// flow (confirm-expire/route.ts) so the lot-matching rule can't drift
// between the two entry points.
//
// Only acts when exactly one open stock_long lot for the symbol has
// enough remaining shares to cover the assignment — auto-picking
// among multiple candidate lots (or partially covering one) would
// silently mis-book cost basis, so ambiguous cases are left for the
// user to resolve manually via Sell Shares instead.
export async function reduceStockLotForCallAssignment(
  sb: RecalcClient,
  userId: string,
  symbol: string,
  shares: number,
  strike: number,
  assignmentDate: string,
): Promise<
  | { ok: true; stockPositionId: string }
  | { ok: false; reason: "no_lot" | "ambiguous_lot" | "insert_failed"; detail?: string }
> {
  const lotsRes = await sb
    .from("positions")
    .select("id,total_contracts")
    .eq("user_id", userId)
    .eq("symbol", symbol)
    .eq("position_type", "stock_long")
    .eq("status", "open");
  const lots = ((lotsRes as { data: unknown }).data ?? []) as Array<{
    id: string;
    total_contracts: number;
  }>;
  const eligible = lots.filter((l) => l.total_contracts >= shares);
  if (eligible.length === 0) return { ok: false, reason: "no_lot" };
  if (eligible.length > 1) return { ok: false, reason: "ambiguous_lot" };

  const lot = eligible[0];
  const closeFill = await sb.from("fills").insert({
    position_id: lot.id,
    user_id: userId,
    fill_type: "close",
    contracts: shares,
    premium: strike,
    fill_date: assignmentDate,
  });
  if ((closeFill as { error: { message: string } | null }).error) {
    return {
      ok: false,
      reason: "insert_failed",
      detail: (closeFill as { error: { message: string } }).error.message,
    };
  }
  const recalc = await recalculatePositionFromFills(lot.id, sb);
  if (!recalc.ok) {
    console.warn(`[reduceStockLotForCallAssignment] recalc failed for ${lot.id}: ${recalc.error}`);
  }
  return { ok: true, stockPositionId: lot.id };
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
  position: { strike: number; expiry: string; optionType?: "put" | "call" };
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
    // The print this rec is about (post_earnings_recommendations.
    // earnings_date) — null only for rows written before that column
    // existed. Used to expire a stale rec; see
    // POST_EARNINGS_REC_EXPIRY_SESSIONS below. Deliberately NOT
    // analysis_date: the daily maintenance pass re-upserts the row
    // (and bumps analysis_date) every time it successfully re-touches
    // an open position, even though move_ratio never changes — using
    // analysis_date would make a rec look fresh forever as long as the
    // cron keeps hitting it.
    earningsDate: string | null;
  } | null;
  currentStockPrice: number | null;
};

function todayUtcIso(): string {
  return new Date().toISOString().slice(0, 10);
}

// Trading sessions (weekdays only, no market-holiday calendar — same
// simplification lib/campaigns.ts's tradingDaysBetween already makes)
// between two ISO dates, inclusive of the start day. A same-day rec is
// 0 sessions old.
function tradingSessionsSince(fromIso: string, toIso: string): number {
  let count = 0;
  const cur = new Date(fromIso + "T00:00:00Z");
  const end = new Date(toIso + "T00:00:00Z");
  while (cur <= end) {
    const day = cur.getUTCDay();
    if (day !== 0 && day !== 6) count += 1;
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return Math.max(0, count - 1);
}

// A post-earnings rec answers "what should I do about the print" — a
// question with a shelf life. move_ratio is frozen at earnings day, so
// re-running the same rule on a later day produces the identical
// verdict at the identical confidence, forever; CLOSE_MEDIUM_MOVE kept
// firing at MEDIUM for CRWV/NBIS days after the print with no decay at
// all (the audit that motivated this: RKLB's LOW confidence wasn't
// decay either — its move_ratio never exceeded the CLOSE threshold in
// the first place). Past this many trading sessions since the print,
// the rec is treated as expired for badge purposes — forced out of
// Priority 2's HIGH/MEDIUM gate regardless of its original confidence.
// A single hard cutoff rather than a multi-step ladder: easier to
// reason about and validate, and by the time this many sessions have
// passed the weekly contract the rec was scoped to has usually already
// rolled past its own expiry anyway. Editable.
export const POST_EARNINGS_REC_EXPIRY_SESSIONS = 3;

function isPostEarningsRecExpired(earningsDate: string | null, today: string): boolean {
  if (earningsDate === null) return false;
  return tradingSessionsSince(earningsDate, today) >= POST_EARNINGS_REC_EXPIRY_SESSIONS;
}

function firstSentence(s: string): string {
  const idx = s.indexOf(".");
  if (idx < 0) return s.trim();
  return s.slice(0, idx + 1).trim();
}

// Signed "safety numerator" — positive means OTM/safe, negative means
// ITM/danger, for EITHER put or call. A short put is safe with spot
// ABOVE strike; a short call is safe with spot BELOW strike, so the
// sign of (stockPrice - strike) must flip for calls. Every distance-
// to-strike computation touching an option position (this file,
// app/api/positions/open/route.ts, lib/expire-positions.ts) must go
// through this rather than inlining the raw fraction — that's exactly
// the class of bug that made every one of those hardcoded to put-only
// semantics before covered calls existed. Callers divide by whatever
// denominator (strike or spot) and scale (fraction or percent) they
// already use — this only fixes the sign.
export function safetyNumerator(
  stockPrice: number,
  strike: number,
  optionType: "put" | "call",
): number {
  return optionType === "call" ? strike - stockPrice : stockPrice - strike;
}

export function computePositionBadge(input: PositionBadgeInput): BadgeResult {
  const { position, latestSnapshot, postEarningsRec, currentStockPrice } = input;
  const today = todayUtcIso();
  const isExpiryDay = position.expiry === today;
  const optionType = position.optionType ?? "put";

  const stockPrice =
    currentStockPrice ?? latestSnapshot?.stock_price ?? null;
  const optionPrice = latestSnapshot?.option_price ?? null;
  const pctFromStrike =
    stockPrice !== null && position.strike > 0
      ? safetyNumerator(stockPrice, position.strike, optionType) / position.strike
      : null;

  // ---------- PRIORITY 1: expiry day ----------
  if (isExpiryDay) {
    // After-close + comfortably OTM → eligible for the same-day
    // confirmation flow. Show a green "EXPIRES TODAY ✓" so the user
    // knows the modal will pick this row up. Stricter than the live
    // "EXPIRING ✓" rule below (>5% vs ≥2% with low option price)
    // because the same-day after-close path doesn't get the benefit
    // of an overnight assignment-notice window.
    if (
      isAfterMarketCloseET() &&
      pctFromStrike !== null &&
      pctFromStrike > 0.05
    ) {
      return {
        badge: "EXPIRES_TODAY",
        label: "EXPIRES TODAY ✓",
        color: "green",
        tooltip: `${(pctFromStrike * 100).toFixed(1)}% OTM after market close — eligible to confirm worthless. Confirm in the modal at the top of the page.`,
        ruleFired: "EXPIRES_TODAY_AFTER_CLOSE",
      };
    }
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

  // ---------- PRIORITY 2: max profit (premium captured) ----------
  // Ahead of the post-earnings rec (was Priority 3, below it) — a
  // position marked at a penny with the print behind it is at max
  // profit regardless of what the stock did on the print. A stale
  // MEDIUM-confidence CLOSE rec (see Priority 3 below) can't tell you
  // anything the current mark doesn't already say more directly.
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

  // ---------- PRIORITY 3: post-earnings rec (HIGH/MEDIUM, not expired) ----------
  // Expired (POST_EARNINGS_REC_EXPIRY_SESSIONS trading sessions past the
  // print) forces this out of the gate regardless of stored confidence
  // — move_ratio is frozen at earnings day, so an un-expired check here
  // would let CLOSE_MEDIUM_MOVE keep re-firing at MEDIUM indefinitely.
  const recExpired =
    postEarningsRec !== null && isPostEarningsRecExpired(postEarningsRec.earningsDate, today);
  if (
    postEarningsRec &&
    !recExpired &&
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

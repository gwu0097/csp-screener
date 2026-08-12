// Liquidity-aware suggested strike — a SECOND, display-only strike
// alongside the 2x EM recommendation. Does not touch suggestedStrike,
// reference_strike, the liquidity grade, the Tradable cascade, or the
// yield gate; see the strike-selector audit this responds to.
//
// The audit found the strike selector (lib/screener.ts's
// pickStrikeNearestWithDiff) reads no chain data at all — it picks the
// nearest LISTED strike to spot*(1-2*EM) by dollar distance only. On
// chains where OI/volume exist, the picked strike's median OI is 61 and
// median spread is 100% of mid; round-number strikes carry ~3.5x the
// OI of half-step strikes, so the pure-math target routinely lands on
// a rung the market doesn't trade.
//
// This was attempted once before and reverted (see
// evaluateReferenceStrike's comment, lib/screener.ts) — an inward walk
// with no real floor landed on a $0.10 bid / $1.55 ask contract with no
// last trade, "a worse trade wearing a passing badge." The floor here
// is a real one (OI + spread together, not "any nonzero bid"), and the
// search prefers OUTWARD (more cushion) over inward, only falling
// inward when nothing qualifies outward within a bounded distance —
// the audit found that where a liquid strike exists on both sides, the
// closer-to-spot one pays ~4x the premium and carries ~2x the OI, so an
// unconstrained "nearest liquid" search would systematically erode
// cushion even though every liquidity number improved.
//
// Zero server dependencies, same reasoning as lib/liquidity.ts/
// lib/tradable-grade.ts: a pure function over already-fetched chain
// data, callable from anywhere without a second implementation.

import { computeLiquidityRead, type Grade } from "@/lib/liquidity";

// ---- editable thresholds ----

// Rule (d1) from the audit, as the starting point.
export const LIQUID_STRIKE_OI_FLOOR = 25;
export const LIQUID_STRIKE_SPREAD_CAP_PCT = 50;
// How far the search is willing to look for a qualifying strike, in
// units of the reference move (emPct, or the historical-median
// fallback when IV is unavailable — whatever produced the 2x EM target
// itself). Scale-invariant across price levels, unlike a flat dollar
// bound (LITE at $642 vs. a $20 stock shouldn't share one $ cap). 0.5
// is generous relative to the audit's own findings — rule (d1)'s
// median drift was 0.087x EM, its harsher sibling (d2) 0.290x EM — so
// this bound rarely rejects a real (d1)-shaped match while still being
// a genuine, finite stop rather than an unbounded walk.
export const LIQUID_STRIKE_SEARCH_BOUND_X_EM = 0.5;

export type LiquidityStrikeCandidate = {
  strike: number;
  oi: number;
  volume: number;
  bid: number;
  ask: number;
  mark: number;
  premiumFill: number;
  delta: number;
};

export type LiquidityStrikeSuggestion = {
  status: "already_qualifies" | "snapped" | "none_qualify";
  // Present for already_qualifies (== anchor) and snapped; null for
  // none_qualify — no strike is silently substituted.
  strike: number | null;
  oi: number | null;
  volume: number | null;
  spreadPct: number | null;
  premiumFill: number | null;
  delta: number | null;
  grade: Grade | null;
  driftDollars: number | null;
  driftXEm: number | null;
  direction: "outward" | "inward" | null;
  // Human-readable "why it moved" (or why it didn't) — always non-null
  // so a caller never has to synthesize its own copy of this logic.
  reason: string;
};

function spreadPctOfMid(c: { bid: number; ask: number; mark: number }): number {
  const mid = c.mark > 0 ? c.mark : (c.bid + c.ask) / 2;
  if (!(mid > 0)) return 200;
  return ((c.ask - c.bid) / mid) * 100;
}

function qualifies(oi: number, spreadPct: number): boolean {
  return oi >= LIQUID_STRIKE_OI_FLOOR && spreadPct < LIQUID_STRIKE_SPREAD_CAP_PCT;
}

export function computeLiquidityAwareSuggestion(params: {
  // The already-picked 2x EM strike (suggestedStrike) and its own
  // OI/volume/spread — the SAME numbers runStageFour already computed
  // for opportunityGrade's liquidity cap, passed in rather than
  // recomputed.
  anchorStrike: number;
  anchorOi: number;
  anchorVolume: number;
  anchorSpreadPct: number;
  anchorPremiumFill: number;
  anchorDelta: number;
  // The reference move behind the 2x EM math (emPct, or the
  // historical-median fallback) — used only to scale the search bound.
  referenceMove: number;
  candidates: LiquidityStrikeCandidate[];
}): LiquidityStrikeSuggestion {
  const {
    anchorStrike,
    anchorOi,
    anchorVolume,
    anchorSpreadPct,
    anchorPremiumFill,
    anchorDelta,
    referenceMove,
    candidates,
  } = params;

  const anchorGrade = computeLiquidityRead(anchorOi, anchorVolume, anchorSpreadPct).grade;
  const anchorText = `2x EM $${anchorStrike.toFixed(2)} — ${anchorOi} OI, ${anchorSpreadPct.toFixed(0)}% spread`;

  if (qualifies(anchorOi, anchorSpreadPct)) {
    return {
      status: "already_qualifies",
      strike: anchorStrike,
      oi: anchorOi,
      volume: anchorVolume,
      spreadPct: anchorSpreadPct,
      premiumFill: anchorPremiumFill,
      delta: anchorDelta,
      grade: anchorGrade,
      driftDollars: 0,
      driftXEm: 0,
      direction: null,
      reason: `${anchorText}. Already meets the liquidity floor (OI ≥ ${LIQUID_STRIKE_OI_FLOOR}, spread < ${LIQUID_STRIKE_SPREAD_CAP_PCT}%).`,
    };
  }

  const bound = referenceMove > 0 ? referenceMove * LIQUID_STRIKE_SEARCH_BOUND_X_EM * anchorStrike : 0;
  // spot isn't passed separately — anchorStrike is already within a few
  // dollars of spot*(1-2*referenceMove), close enough that scaling the
  // bound off it (rather than a separate spot figure) makes no material
  // difference and keeps this function's inputs to what's already on
  // hand at the call site.
  const inBounds = (s: LiquidityStrikeCandidate) => Math.abs(s.strike - anchorStrike) <= bound && s.strike !== anchorStrike;

  const outward = candidates
    .filter((s) => inBounds(s) && s.strike < anchorStrike && qualifies(s.oi, spreadPctOfMid(s)))
    .sort((a, b) => Math.abs(a.strike - anchorStrike) - Math.abs(b.strike - anchorStrike));
  const inward = candidates
    .filter((s) => inBounds(s) && s.strike > anchorStrike && qualifies(s.oi, spreadPctOfMid(s)))
    .sort((a, b) => Math.abs(a.strike - anchorStrike) - Math.abs(b.strike - anchorStrike));

  const picked = outward[0] ?? inward[0] ?? null;
  const direction: "outward" | "inward" | null = picked ? (outward[0] ? "outward" : "inward") : null;

  if (!picked) {
    return {
      status: "none_qualify",
      strike: null,
      oi: null,
      volume: null,
      spreadPct: null,
      premiumFill: null,
      delta: null,
      grade: null,
      driftDollars: null,
      driftXEm: null,
      direction: null,
      reason: `${anchorText}. No strike within ${(LIQUID_STRIKE_SEARCH_BOUND_X_EM).toFixed(2)}x EM meets the liquidity floor (OI ≥ ${LIQUID_STRIKE_OI_FLOOR}, spread < ${LIQUID_STRIKE_SPREAD_CAP_PCT}%).`,
    };
  }

  const pickedSpreadPct = spreadPctOfMid(picked);
  const pickedGrade = computeLiquidityRead(picked.oi, picked.volume, pickedSpreadPct).grade;
  const driftDollars = picked.strike - anchorStrike;
  const driftXEm = anchorStrike > 0 && referenceMove > 0 ? driftDollars / anchorStrike / referenceMove : null;

  return {
    status: "snapped",
    strike: picked.strike,
    oi: picked.oi,
    volume: picked.volume,
    spreadPct: pickedSpreadPct,
    premiumFill: picked.premiumFill,
    delta: picked.delta,
    grade: pickedGrade,
    driftDollars,
    driftXEm,
    direction,
    reason: `${anchorText}. Suggested $${picked.strike.toFixed(2)} — ${picked.oi} OI, ${pickedSpreadPct.toFixed(0)}% spread.`,
  };
}

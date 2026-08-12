// Graduated liquidity read for the Opportunity grade — the fix for the
// grade audit's finding that liquidity was never an input beyond "is
// there a bid at all" (noBid). A 7-OI/3-volume/100%-spread strike graded
// identically to a 3,897-OI/3%-spread chain at the same yield.
//
// Zero server dependencies (no Schwab/Supabase imports) so this module
// is shared verbatim by lib/screener.ts (server, runStageFour) and
// components/screener-view.tsx (client, the CustomStrikeAnalyzer/
// OptionsChainTab what-if preview) — one function, not two hand-kept-
// in-sync copies. That's a deliberate departure from this codebase's
// existing pattern of duplicating small grade helpers into a "Client"
// twin (gradeFromYieldClient, gradeFromRulesClient, dropGradeClient):
// those duplicates are historical, already-drifting-risk debt: this
// function has no reason to duplicate since it has nothing
// server-specific to strip out, so sharing it outright removes the
// sync risk entirely rather than adding another synced pair to maintain.
//
// Thresholds below are anchored to the actual distribution of OI/
// volume/spread at RECOMMENDED strikes across screener_results —
// 222 samples, 27 graded runs, 2026-07-13 to 2026-08-12, excluding
// noBid (bid<=0) rows (those are already a hard F via the untouched
// noBid gate, and bid=0 forces spread to exactly 200% of mid by
// construction — unrelated to this scale):
//   OI:      p50=0    p75=20    p90=262    p95=1087   p99=1405
//   volume:  p50=0    p75=4     p90=94     p95=283    p99=910
//   spread:  p25=30.6 p50=66.7  p75=133.3  p90=171.4
// The median recommended strike has ZERO recorded OI and ZERO volume —
// depth is the exception, not the norm, in this population. Bucket
// boundaries below sit at p75/p90 for depth and p25/p50/p75 for spread;
// re-run scripts/liquidity-distribution-report.ts periodically and
// adjust these constants directly if the shape drifts.

export type Grade = "A" | "B" | "C" | "F";

// ---- editable thresholds ----

export const LIQUIDITY_OI_DEEP = 250; // ~p90
export const LIQUIDITY_OI_MODERATE = 20; // ~p75
export const LIQUIDITY_VOLUME_DEEP = 90; // ~p90
export const LIQUIDITY_VOLUME_MODERATE = 4; // ~p75

export const LIQUIDITY_SPREAD_TIGHT_PCT = 30; // ~p25
export const LIQUIDITY_SPREAD_TYPICAL_PCT = 70; // ~p50
export const LIQUIDITY_SPREAD_WIDE_PCT = 135; // ~p75

// Depth (OI + volume) vs. spread weighting — a design choice, not a
// percentile: "depth should carry more weight than quoted spread" per
// the liquidity-gate audit, since a wide QUOTED spread often still
// fills near mid on a chain with real depth (the observation
// dictionary's thin_chain_workable_limit case), while zero depth means
// there's no one on the other side regardless of what the quote says.
export const LIQUIDITY_DEPTH_WEIGHT = 70;
export const LIQUIDITY_SPREAD_WEIGHT = 30;

export const LIQUIDITY_GRADE_A_THRESHOLD = 80;
export const LIQUIDITY_GRADE_B_THRESHOLD = 55;
export const LIQUIDITY_GRADE_C_THRESHOLD = 25;

export type LiquidityRead = {
  grade: Grade;
  score: number; // 0-100
  depthTier: "none" | "thin" | "moderate" | "deep";
  spreadTier: "tight" | "typical" | "wide" | "very_wide";
  // Human-readable reason, for the row/expanded-panel helper text (item
  // 4) — always non-null so a caller never has to synthesize its own
  // copy of this logic to explain a grade.
  reason: string;
};

function depthTierAndPoints(oi: number, volume: number): { tier: LiquidityRead["depthTier"]; points: number } {
  const half = LIQUIDITY_DEPTH_WEIGHT / 2;
  const oiFrac = oi >= LIQUIDITY_OI_DEEP ? 1 : oi >= LIQUIDITY_OI_MODERATE ? 0.6 : oi > 0 ? 0.25 : 0;
  const volFrac =
    volume >= LIQUIDITY_VOLUME_DEEP ? 1 : volume >= LIQUIDITY_VOLUME_MODERATE ? 0.6 : volume > 0 ? 0.25 : 0;
  const points = half * oiFrac + half * volFrac;
  const minFrac = Math.min(oiFrac, volFrac);
  const tier: LiquidityRead["depthTier"] =
    minFrac >= 1 ? "deep" : minFrac >= 0.6 ? "moderate" : minFrac > 0 ? "thin" : "none";
  return { tier, points };
}

function spreadTierAndPoints(spreadPct: number): { tier: LiquidityRead["spreadTier"]; points: number } {
  if (spreadPct <= LIQUIDITY_SPREAD_TIGHT_PCT) return { tier: "tight", points: LIQUIDITY_SPREAD_WEIGHT };
  if (spreadPct <= LIQUIDITY_SPREAD_TYPICAL_PCT) return { tier: "typical", points: LIQUIDITY_SPREAD_WEIGHT * 0.67 };
  if (spreadPct <= LIQUIDITY_SPREAD_WIDE_PCT) return { tier: "wide", points: LIQUIDITY_SPREAD_WEIGHT * 0.33 };
  return { tier: "very_wide", points: 0 };
}

function gradeFromScore(score: number): Grade {
  if (score >= LIQUIDITY_GRADE_A_THRESHOLD) return "A";
  if (score >= LIQUIDITY_GRADE_B_THRESHOLD) return "B";
  if (score >= LIQUIDITY_GRADE_C_THRESHOLD) return "C";
  return "F";
}

const DEPTH_LABEL: Record<LiquidityRead["depthTier"], string> = {
  deep: "deep",
  moderate: "moderate",
  thin: "thin",
  none: "no recorded",
};
const SPREAD_LABEL: Record<LiquidityRead["spreadTier"], string> = {
  tight: "tight",
  typical: "typical",
  wide: "wide",
  very_wide: "very wide",
};

// Pure — no hard-kill here (noBid stays the only hard-kill, applied by
// the caller). Depth dominates: a thin-depth strike can't reach A/B
// regardless of how tight the quoted spread happens to be, and a
// deep-depth strike degrades only gradually as spread widens (the
// thin_chain_workable_limit case — real OI/volume with a wide quote
// still often fills near mid, so it should NOT read the same as a
// strike nobody is trading).
export function computeLiquidityRead(oi: number, volume: number, spreadPct: number): LiquidityRead {
  const depth = depthTierAndPoints(oi, volume);
  const spread = spreadTierAndPoints(spreadPct);
  const score = Math.round(depth.points + spread.points);
  const grade = gradeFromScore(score);
  const reason = `${DEPTH_LABEL[depth.tier]} depth (OI ${oi}, volume ${volume}), ${SPREAD_LABEL[spread.tier]} spread (${spreadPct.toFixed(0)}% of mid)`;
  return { grade, score, depthTier: depth.tier, spreadTier: spread.tier, reason };
}

const GRADE_ORDER: Record<Grade, number> = { F: 0, C: 1, B: 2, A: 3 };

// Opportunity grade = the WORSE of yield grade and liquidity grade —
// liquidity can only cap a grade down, never boost a thin-yield strike
// up. yieldGrade's own thresholds (gradeFromYield in lib/screener.ts)
// are untouched by this.
export function capGradeByLiquidity(yieldGrade: Grade, liquidityGrade: Grade): Grade {
  return GRADE_ORDER[liquidityGrade] < GRADE_ORDER[yieldGrade] ? liquidityGrade : yieldGrade;
}

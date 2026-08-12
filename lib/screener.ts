import {
  getOptionsChain,
  getOptionsChainRange,
  schwabGet,
  SchwabOptionContract,
  SchwabOptionsChain,
} from "@/lib/schwab";
import {
  getHistoricalEarningsMovements,
  getMarketCap,
  EarningsMove,
} from "@/lib/yahoo";
import type { PerplexityNewsResult } from "@/lib/perplexity";
import { createServerClient } from "@/lib/supabase";
import {
  getAnalystEstimates,
  getEarningsSurpriseHistory,
} from "@/lib/earnings";
import { getOrFetchDailyBars } from "@/lib/daily-bars-cache";
import {
  ACTIVE_OVERHANG,
  BUSINESS_SIMPLICITY,
  IndustryClass,
  cacheMarketCapBillions,
  getCachedMarketCapBillions,
} from "@/lib/classification";
import {
  getCrushHistory,
  gradeFromRatio,
  persistFlowSnapshot,
  persistLiveImpliedMove,
  computeLossMultiplierLadder,
  getPopulationMeanMoveRatio,
  type CrushHistoryEvent,
  type LossMultiplierResult,
} from "@/lib/earnings-history-table";
import { computeOptionsFlow, type OptionsFlow } from "@/lib/options-flow";
import { computeLiquidityRead, capGradeByLiquidity } from "@/lib/liquidity";

// ---------- Hard-kill thresholds ----------
// The price floor, market-cap floor, and Stage 2 tier gate live in
// the active screener config (lib/screener-config.ts → screener_configs
// table) and are applied by /api/screener/screen — no duplicates here.

// ---------- Types ----------

export type EarningsCandidate = {
  symbol: string;
  price: number;
  earningsDate: string; // YYYY-MM-DD
  earningsTiming: "BMO" | "AMC";
  daysToExpiry: number;
  expiry: string; // YYYY-MM-DD Friday
};

export type StageOneResult = { pass: boolean; reason: string; details: Record<string, string | number | boolean | null> };

export type StageTwoResult = {
  score: number;
  maxScore: 9;
  pass: boolean;
  reason: string;
  details: {
    businessSimplicity: number;
    marketCapTier: number;
    analystDispersion: number;
    activeOverhangPenalty: number;
    industryPenalty: number; // 0 or -2
    marketCapBillions: number | null;
    industryClass: IndustryClass;
  };
};

export type StageThreeResult = {
  score: number;
  // Dynamic: sum of only the sub-score maximums that were actually
  // computable for this candidate (see combineCrushComponents). 25 when
  // every component had data; lower when one or more were excluded for
  // lack of data. Never a component scored as 0 for missing data — it's
  // dropped from both score and maxScore instead.
  maxScore: number;
  pass: boolean;
  crushGrade: "A" | "B" | "C" | "F";
  threshold: number;
  // True when we have fewer than 3 historical earnings moves — the F grade in
  // this case reflects missing data, not a genuinely weak crusher.
  insufficientData: boolean;
  details: {
    historicalMoveScore: number;
    consistencyScore: number;
    termStructureScore: number;
    ivEdgeScore: number;
    surpriseScore: number;
    // Which of the five components actually had enough data to be
    // scored — a component with computed=false was excluded from both
    // score and maxScore, never scored as a penalizing 0.
    scoreComponentsComputed: {
      historicalMove: boolean;
      consistency: boolean;
      termStructure: boolean;
      ivEdge: boolean;
      surprise: boolean;
    };
    medianHistoricalMovePct: number | null;
    // Diagnostic only (display/sort) — median of Yahoo's raw
    // historicalMoves actual-move array. NOT the scoring input anymore;
    // see historicalMoveRatio.
    // RAW per-quarter realized/implied-at-the-time ratio, MEANED across
    // every quarter with a valid pair (any implied_move_source — see
    // buildQuarterlyMoveRatio). Diagnostic — historicalMoveScore is now
    // built from historicalMoveRatioShrunk below, not this value
    // directly (PASS_2E: raw per-ticker means are systematically
    // inflated at low n — see applyShrinkage's docblock).
    historicalMoveRatio: number | null;
    // Count of quarters that contributed a valid ratio to the mean
    // above. 0 means historicalMove was excluded from the composite
    // entirely (see scoreComponentsComputed.historicalMove).
    historicalMoveRatioN: number;
    // The estimate historicalMoveScore is ACTUALLY computed from —
    // historicalMoveRatio shrunk toward populationMeanRatio by
    // shrinkageK "worth" of population evidence. null iff
    // historicalMoveRatioN===0 (nothing to shrink, component excluded).
    historicalMoveRatioShrunk: number | null;
    populationMeanRatio: number;
    shrinkageK: number;
    // Full per-quarter diagnostic breakdown — source used, exclusion
    // reason, DB-vs-Yahoo divergence flag. Powers the crush caption and
    // the CLI re-grade validator; not rendered directly in the UI.
    historicalMoveRatioQuarters: QuarterRatioDetail[];
    // Mean of each SCHWAB-VERIFIED (schwab/schwab_t0 source only)
    // historical event's own realized/implied-at-the-time ratio — a
    // narrower, higher-trust population than historicalMoveRatio above.
    // Feeds computeVerifiedModifier, applied post-hoc in
    // runStagesThreeFour once crushHistory is available — placeholder
    // null/0 here.
    crushRatio: number | null;
    // Human-readable band the verified ratio landed in (e.g. "severe
    // miss (>2.0x)"), or null when crushRatioVerifiedN is 0.
    crushRatioSeverity: string | null;
    crushRatioCapSampleWeight: number;
    // Count of Schwab-verified quarters the ratio/weight above are based
    // on — distinct from historicalMoves.length. 0 is the common case
    // today (~19% of tickers have any); visible so a 0 isn't mistaken
    // for "no data available" rather than "no VERIFIED data available."
    // At 0, computeVerifiedModifier returns delta 0 — genuinely neutral,
    // not a ceiling.
    crushRatioVerifiedN: number;
    // Grade steps applied by computeVerifiedModifier (+raises/-lowers/0
    // neutral) — replaces the old ceiling-only crushRatioCap.
    crushVerifiedModifierDelta: number;
    // True when the modifier actually changed the grade the composite
    // score (or the encyclopedia fallback) would otherwise have produced.
    crushRatioCapApplied: boolean;
    // Implied move actually used downstream (crush scoring, stage 4
    // strike selection). Straddle-derived when available; see
    // impliedMoveMethod for which method produced this value.
    expectedMovePct: number | null;
    // "straddle" = ATM straddle mid / spot (Fix A, preferred).
    // "iv_formula_degraded" = fell back to the old single-put IV × √t
    // formula because no call chain or no usable straddle quote
    // existed — never silent, always flagged here.
    impliedMoveMethod: "straddle" | "iv_formula_degraded" | null;
    impliedMoveDegradedReason: string | null;
    // Diagnostic only, not used by any scoring — the old formula's
    // value computed alongside the real one whenever possible, purely
    // so before/after comparisons don't require a second run.
    impliedMovePctIvFormula: number | null;
    weeklyIv: number | null;
    monthlyIv: number | null;
    realizedVol30d: number | null;
    // True when termStructureScore is a degenerate 0, not a real
    // signal: the monthly-IV-window fetch landed on the same expiry
    // date as the (possibly monthly-fallback) candidate.expiry, so
    // "weekly vs monthly" collapsed to "expiry vs itself". NOT folded
    // into the crush composite — that renormalization is out of scope
    // this pass (crush-composite-weighting backlog). Segment on it
    // instead. See PASS_2A checkpoint notes.
    termStructureExcluded?: boolean;
    // |spot - strike| / spot for the straddle's nearest-strike ATM
    // pick. Null when method=iv_formula_degraded (no straddle to
    // measure). See atmDistanceFlag for the derived threshold.
    atmDistancePct: number | null;
    // Static intrinsic value of the ITM leg as a fraction of the
    // straddle mid. Diagnostic — FBP measured 73.2%, a normal tight
    // strike grid measures low single digits.
    intrinsicPctOfStraddle: number | null;
    // FLAG (not a kill): atmDistancePct > ivFormulaEmPct/2 — see the
    // derivation comment beside atmDistanceFlag's computation in
    // runStageThree. True means the straddle succeeded but its ATM
    // strike is far enough from spot that intrinsic value materially
    // contaminates emPct; segment these out of the Fix B distribution
    // rather than treating them as clean reads.
    atmDistanceFlag: boolean;
    // Fix B: E[loss|breach] expressed as a multiple of this candidate's
    // own emPct — see computeLossMultiplierLadder. Stamped by
    // runStagesThreeFour (async DB read); optional so older mocked
    // StageThreeResult fixtures still type-check, calculateThreeLayerGrade
    // falls back to the pool default when absent.
    lossMultiplier?: number;
    lossMultiplierSource?: "ticker" | "sector" | "pool";
    lossMultiplierTickerN?: number;
    lossMultiplierSectorN?: number;
    lossMultiplierPoolN?: number;
    // Per-quarter EM/actual/ratio/grade history for the expanded
    // screener row's crush table. Stamped by runStagesThreeFour
    // after stage 3 completes; older rows may have null EM where
    // the backfill hasn't run.
    crushHistory?: CrushHistoryEvent[];
    // Today's options flow for the candidate's expiry — P/C ratio,
    // unusual strikes, deep-OTM put cluster, flow at the suggested
    // strike. Stamped after stage 4 picks the strike. Null when the
    // full chain fetch failed; UI hides the section.
    optionsFlow?: OptionsFlow | null;
  };
};

export type StageFourResult = {
  score: number;
  maxScore: 20;
  opportunityGrade: "A" | "B" | "C" | "F";
  suggestedStrike: number | null;
  // Fill-priced (mid by default — see computeFillPrice/
  // FILL_BASIS_AGGRESSIVENESS_X), not raw bid. This is what feeds
  // grade/EV/yield/breakeven everywhere downstream.
  premium: number | null;
  delta: number | null;
  // Raw quote alongside the derived spread% — display-only, so a user
  // can see when a quote looks unreliable without the grade acting on
  // it (spread% itself is informational too; see isSpreadTooWide).
  // `last` is informational only — trade price, never a grade/EV input.
  bid: number | null;
  ask: number | null;
  last: number | null;
  bidAskSpreadPct: number | null;
  premiumYieldPct: number | null;
  // Open interest / today's volume at the RECOMMENDED strike specifically
  // (availableStrikes carries these per-strike across the whole chain;
  // these are the same numbers pulled out for the one strike the grade
  // actually cares about, so callers don't need an availableStrikes
  // find() just to read the recommended strike's own depth).
  openInterest: number | null;
  volume: number | null;
  // Graduated liquidity read (lib/liquidity.ts) — depth (OI/volume)
  // weighted above quoted spread, never a hard-kill on its own (that
  // stays noBid). opportunityGrade above is already capped by this;
  // surfaced separately so the UI can show WHY it was capped.
  liquidityGrade: "A" | "B" | "C" | "F";
  liquidityReason: string;
  note: string | null;
  details: {
    premiumYieldScore: number;
    deltaScore: number;
    // Liquidity's 0-100 composite score (lib/liquidity.ts) — no longer
    // a dead 0; see liquidityGrade/liquidityReason above for the graded
    // read this score maps to.
    spreadScore: number;
    contractSymbol: string | null;
    // Math-formula strike (currentPrice × (1 − 2 × emPct)). Surfaced
    // alongside the picked contract's strike so the UI can show a
    // "system targeted $X, picked $Y" hint when the chain didn't have
    // the exact target. Optional — older saved rows lack it.
    mathTargetStrike?: number | null;
    usedTargetedLookup?: boolean;
  };
  // Compact snapshot of the weekly put chain so the UI can run a custom
  // strike analysis client-side (and feed the Options Chain tab)
  // without a new API call. Populated by runStageFour; sorted by
  // strike ascending.
  availableStrikes?: Array<{
    strike: number;
    bid: number;
    ask: number;
    // Mid ((bid+ask)/2, falling back to mark/last only when bid+ask
    // isn't usable) — informational/spread-denominator use ONLY. Never
    // read this as a tradeable premium; see premiumFill.
    mark: number;
    // Informational only (Options Chain tab display) — never a
    // grade/EV input.
    last: number;
    // The CSP entry premium, fill-priced the same way as runStageFour's
    // own top-level `premium` (computeFillPrice — mid by default,
    // falling back to bid + fillInvalid=true on a degenerate quote). 0
    // when bid itself is missing/non-numeric — never backfilled from
    // mark/last, same "no bid = no real market" reasoning as the
    // hard-kill it mirrors. This is what CustomStrikeAnalyzer/
    // EditableStrikeCell/evaluateReferenceStrike must use for premium;
    // `mark` stays mid-for-display, `last` stays informational-only.
    premiumFill: number;
    // True when this strike's mid was untrustworthy (crossed or
    // missing ask) and premiumFill fell back to bid instead — surfaced
    // per-strike (not just at the top-level `note`) so the Options
    // Chain tab and ladder diagnostics can flag it, not just silently
    // use a possibly-stale bid.
    fillInvalid: boolean;
    delta: number;
    // Open interest / today's volume for this strike — same Schwab
    // contract response runStageFour already fetches for bid/ask/mark,
    // just extracted; not a new round-trip. Powers the Analysis Dump
    // export's Options Chain section (no OI/volume column exists in
    // the on-screen chain table, but the data was always present).
    oi: number;
    volume: number;
  }>;
};

// Hard kill: if bid-ask spread as % of mid exceeds this, the contract is
// effectively untradeable — grade force to F and recommendation force to Skip.
// 20% tolerates weekly single-stock option spreads while still killing truly
// untradeable names (NDAQ ~78%, TMO ~85% seen in practice).
export const SPREAD_KILL_PCT = 20;

// Commission per contract, ONE LEG. Total friction subtracted from EV
// is 2x this (entry: sell to open; exit: buy to close or assignment
// fee) — NOT commission + half-spread, since premium is already
// bid-priced (see runStageFour), which already captures entry
// slippage. Rates vary by broker ($0 to ~$0.65/contract is the real
// range), so this is env-configurable rather than a fixed number;
// CSP_COMMISSION_PER_CONTRACT overrides the default when set.
export const DEFAULT_COMMISSION_PER_CONTRACT = 0.65;
export function commissionPerContract(): number {
  const raw = process.env.CSP_COMMISSION_PER_CONTRACT;
  const parsed = raw !== undefined ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_COMMISSION_PER_CONTRACT;
}

export type ScreenerResult = {
  symbol: string;
  price: number;
  earningsDate: string;
  earningsTiming: "BMO" | "AMC";
  daysToExpiry: number;
  expiry: string;
  // "monthly_fallback" when no weekly existed at the earnings-driven
  // Friday and the pipeline fell back to the nearest standard monthly
  // expiry after the earnings date instead. Never silent — see
  // runStagesThreeFour's fallback block.
  expirySource: "weekly" | "monthly_fallback";
  stoppedAt: 1 | 2 | 3 | 4 | null;
  stageOne: StageOneResult;
  stageTwo: StageTwoResult | null;
  stageThree: StageThreeResult | null;
  stageFour: StageFourResult | null;
  recommendation:
    | "Strong - Take the trade"
    | "Marginal - Size smaller"
    | "Marginal - Crush unproven"
    | "Skip"
    | "Cannot evaluate"
    | "Needs analysis";
  errors: string[];
  isWhitelisted: boolean;
  industryStatus: "pass" | "fail" | "unknown";
  spreadTooWide: boolean;
  // True when Screen Today's chain-verification step (Stream C,
  // /api/screener/screen/verify-chains) couldn't confirm this
  // candidate's weekly chain after retries — a genuine Schwab fetch
  // failure, distinct from "verified absent" (no weekly options for
  // this date, which drops the row instead of flagging it). Kept
  // VISIBLE rather than silently dropped — the whole reason this
  // field exists is that a fetch failure and a correct exclusion look
  // identical from the outside unless something marks the difference
  // (see chain_verification_log, and the AMD/DIS audit this fixed).
  chainUnverified?: boolean;
  chainUnverifiedReason?: string;
  // Three-layer grade (industry standard + your trade history + current
  // news/vix regime). Populated by runStagesThreeFour when the analyze
  // route has news + personal context to feed in. Null when not computed
  // yet (e.g. screen-only run, pre-analysis).
  threeLayer: ThreeLayerGrade | null;
};

export type Grade = "A" | "B" | "C" | "F";

// Output of calculateThreeLayerGrade. Consumed by the screener UI
// expanded row and attached to the trade at log time.
export type ThreeLayerGrade = {
  industryGrade: Grade;
  industryScore: number;
  industryFactors: {
    probabilityOfProfit: number;
    ivRank: number | null;
    ivEdge: number;
    termStructure: number;
    crushGrade: Grade;
    opportunityGrade: Grade;
    expectedValue: number;
    breakevenPrice: number;
    // Fix B: which tier of the shrinkage ladder set the E[loss|breach]
    // multiplier baked into expectedValue — "pool" near-universally as
    // of PASS_2A (see the comment on assignmentLoss in
    // calculateThreeLayerGrade). Parallel to expirySource: carried here
    // so a candidate's EV can be segmented by evidence quality without
    // reaching into stageThree.details.
    lossMultiplierSource: "ticker" | "sector" | "pool";
    lossMultiplier: number;
  };
  personalGrade: Grade | "INSUFFICIENT";
  personalScore: number | null;
  personalFactors: {
    // At sector scope these three hold the SECTOR aggregates (scope
    // field says which); the names are kept for saved-row compatibility.
    tickerWinRate: number | null;
    tickerTradeCount: number;
    tickerAvgRoc: number | null;
    tickerCrushAccuracy: number | null;
    dataInsufficient: boolean;
    scope?: "ticker" | "sector" | "none";
    sectorIndustry?: string | null;
    cleanCount?: number;
    rolledCount?: number;
    recoveryCount?: number;
    tickerLevel?: {
      campaigns: number;
      clean: number;
      rolled: number;
      recovery: number;
    };
    sampleWeight?: number;
    sector?: {
      industry: string;
      campaigns: number;
      winRate: number | null;
      avgRoc: number | null;
      dropWinRate: number | null;
      recoveryCount: number;
    } | null;
  };
  regimeGrade: Grade;
  regimeScore: number;
  regimeFactors: {
    newsSentiment: "positive" | "negative" | "neutral";
    hasActiveOverhang: boolean;
    overhangDescription: string | null;
    newsSummary: string;
    gradePenalty: number;
    vix: number | null;
    vixRegime: "calm" | "elevated" | "panic" | null;
  };
  finalGrade: Grade;
  // True when Opportunity graded F blocked what would otherwise have
  // been a B or C — finalGrade stays "F" for type/sort compatibility,
  // but this trade isn't bad-odds, it's just not worth pricing. UI
  // should show "Unrated" instead of the bare letter when true.
  unrated: boolean;
  finalScore: number;
  recommendation: string;
  recommendationReason: string;
  // Passed through from ScreenerResult so the grading layer (and Fix B's
  // loss model) can see it without reaching back into a sibling field —
  // "weekly" is a clean earnings straddle, "monthly_fallback" blends the
  // earnings jump with weeks of ordinary drift. Not used by any scoring
  // yet; purely plumbing so it CAN be segmented on.
  expirySource: "weekly" | "monthly_fallback";
  // PASS_3: "is this name's earnings setup favorable" — same rule
  // cascade as finalGrade (crush/POP/overhang/VIX/personal-history)
  // with the opportunity/premium gate removed entirely. Premium is
  // compensation, not opportunity; this answers a genuinely different
  // question than finalGrade does. finalGrade/unrated/opportunityGrade
  // are UNCHANGED by this addition — Fix 2's gate still governs them
  // exactly as before. POP here is evaluated at the 2xEM reference
  // strike (stable, comparable across candidates) — the ONLY strike
  // this app ever recommends; see referenceStrikeCheck below.
  setupGrade: Grade;
  // Checks whether the 2xEM strike itself has a real, tradeable bid —
  // and reports its premium/POP/%OTM when it does. Previously this
  // walked the chain toward the money looking for a closer rung to
  // recommend instead; that inward walk was removed (see PASS_3.md's
  // follow-up note) because it silently overrode the user's own 2xEM
  // rule for the sake of finding *any* tradeable premium, including
  // strikes with a $0.10 bid / no last trade. The 2xEM strike is the
  // recommendation, full stop — this field is diagnostic only (is it
  // liquid, at what price) and never recommends a different strike.
  referenceStrikeCheck: ReferenceStrikeCheck;
  // Which finalGrade rule cascade branch matched (or "F" via the
  // no-rule-matched fallthrough) plus its human-readable explanation —
  // surfaced verbatim from the same local values the cascade already
  // computes, for the Analysis Dump export's grade-breakdown section.
  // Not a new calculation, just exposing what was already decided.
  matchedRule: "A" | "B" | "C" | "F";
  ruleText: string;
  // Overhang/VIX/personal-history overrides that fired after the rule
  // cascade, in order — empty when none applied.
  overrideNotes: string[];
};

// Client-facing categorization, computed here where the thresholds live —
// the UI must never re-derive this from a raw yield/POP comparison (those
// thresholds have already moved twice in this pass; a client-side copy
// would silently drift out of sync).
export type ReferenceStrikeCheck =
  | {
      status: "tradeable";
      referenceStrike: number;
      // Fill-priced (mid by default — see computeFillPrice), not bid.
      premiumFill: number;
      pctOtm: number;
      pop: number;
      delta: number;
      text: string;
    }
  | {
      status: "no_bid";
      referenceStrike: number;
      text: string;
    };

export type PersonalHistory = {
  tradeCount: number;
  winRate: number | null;
  avgRoc: number | null; // percent, on strike-based capital (collateral)
  dataInsufficient: boolean;
  // Evidence granularity. "ticker" = 5+ terminal trades on this symbol
  // (winRate/avgRoc/tradeCount are ticker-level). "sector" = fallback
  // to the user's history across the symbol's industry, 10+ trades
  // (fields hold SECTOR aggregates). "none" = neither bar met.
  // Optional so legacy cached rows (pre-2026-07-06) stay valid — treat
  // missing as "ticker".
  scope?: "ticker" | "sector" | "none";
  sectorIndustry?: string | null;
  // Chain-aware breakdown (2026-07-06): stats are computed over trade
  // CHAINS, not positions. winRate/avgRoc are boost-side weighted
  // (clean 1.0, rolled 0.5, recovery_play excluded); dropWinRate
  // weights rolled at 1.0 (recovery still excluded). tradeCount is the
  // number of counted chains (clean + rolled).
  dropWinRate?: number | null;
  cleanCount?: number;
  rolledCount?: number;
  recoveryCount?: number;
  // THIS symbol's own campaign counts, present at every scope. At
  // sector scope the top-level fields hold SECTOR aggregates — the UI
  // needs both to attribute numbers correctly (a sector count labelled
  // "ZS trades logged" was exactly the bug this fixes).
  tickerLevel?: {
    campaigns: number;
    clean: number;
    rolled: number;
    recovery: number;
  };
  // Sample-size confidence for the ticker evidence: 1.0 (5+ campaigns),
  // 0.5 (2-4, "small sample"), 0.25 (1, "very limited data"), 0 (none).
  // Small samples are SHOWN, never hidden — the weight only limits how
  // much they can move the grade (see calculateThreeLayerGrade).
  sampleWeight?: number;
  // Sector aggregates, carried alongside ticker stats whenever the
  // symbol's industry has 10+ of the user's campaigns.
  sector?: {
    industry: string;
    campaigns: number;
    winRate: number | null;
    avgRoc: number | null;
    dropWinRate: number | null;
    recoveryCount: number;
  } | null;
};

// ---------- Helpers ----------

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function stddev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function nextFridayOnOrAfter(from: Date): Date {
  const d = new Date(from);
  const day = d.getUTCDay();
  const delta = (5 - day + 7) % 7;
  d.setUTCDate(d.getUTCDate() + delta);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function businessDaysBetween(from: Date, to: Date): number {
  let count = 0;
  const start = new Date(from);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(to);
  end.setUTCHours(0, 0, 0, 0);
  while (start <= end) {
    const day = start.getUTCDay();
    if (day !== 0 && day !== 6) count += 1;
    start.setUTCDate(start.getUTCDate() + 1);
  }
  return Math.max(0, count - 1);
}

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function normalizeSymbol(symbol: string): string {
  return symbol.replace(/\./g, "_").replace(/-/g, "_").toUpperCase();
}

// ---------- Stage 1 ----------

function hasWeeklyFridayExpiry(chain: SchwabOptionsChain, targetFriday: string): boolean {
  const keys = Object.keys(chain.putExpDateMap ?? {});
  return keys.some((k) => k.startsWith(targetFriday));
}

export async function runStageOne(
  candidate: EarningsCandidate,
  chain: SchwabOptionsChain | null,
  industryClass: IndustryClass,
): Promise<StageOneResult> {
  // Stage 1 now records what upstream hard-kills already verified. The
  // $70 floor, weekly-chain presence, blacklist, and ETF checks are
  // enforced in /api/screener/screen before this runs.
  const weeklyFound = chain ? hasWeeklyFridayExpiry(chain, candidate.expiry) : null;
  const details: StageOneResult["details"] = {
    timing: candidate.earningsTiming,
    price: candidate.price,
    industryClass,
    expiry: candidate.expiry,
    weeklyExpiryFound: weeklyFound,
  };
  return { pass: true, reason: "Passed hard filters", details };
}

// ---------- Stage 2 ----------

function scoreMarketCap(mcapBillions: number | null): number {
  if (mcapBillions === null) return 0;
  if (mcapBillions >= 200) return 3;
  if (mcapBillions >= 50) return 2;
  if (mcapBillions >= 10) return 1;
  return 0;
}

function scoreDispersion(dispersionPct: number | null): number {
  if (dispersionPct === null) return 0;
  if (dispersionPct < 5) return 3;
  if (dispersionPct < 10) return 2;
  if (dispersionPct < 20) return 1;
  return 0;
}

function scoreBusinessSimplicity(symbol: string): number {
  const score = BUSINESS_SIMPLICITY[normalizeSymbol(symbol)];
  return typeof score === "number" ? score : 1; // default: unknown complexity
}

async function fetchMarketCapBillions(symbol: string): Promise<number | null> {
  // Cache first — market cap drifts slowly and the tiers we score against are
  // wide (>$200B / $50-200B / $10-50B / <$10B) so a cached value is safe.
  const cached = await getCachedMarketCapBillions(symbol);
  if (cached !== null) {
    return cached;
  }
  const mcap = await getMarketCap(symbol);
  if (typeof mcap !== "number" || !Number.isFinite(mcap) || mcap <= 0) {
    console.warn(`[stage2:${symbol}] getMarketCap returned ${mcap}`);
    return null;
  }
  const billions = Math.round((mcap / 1e9) * 100) / 100;
  console.log(`[stage2:${symbol}] fetched marketCap=${mcap} → ${billions}B, caching`);
  await cacheMarketCapBillions(symbol, billions);
  return billions;
}

export async function runStageTwo(
  candidate: EarningsCandidate,
  industryClass: IndustryClass,
  options: {
    industryPenalty?: number;
    isWhitelisted?: boolean;
    // Minimum market-cap tier (0-3) from the active screener config.
    // <= 0 disables the gate. Defaults to 1 ($10B+), the CSP Earnings
    // preset value, so callers that don't thread a config keep the
    // historical behaviour.
    minMarketCapTier?: number;
    // Bypasses the analyst-recommendation Finnhub cache (see
    // getAnalystEstimates) — still writes the fresh result back.
    forceFresh?: boolean;
  } = {},
): Promise<StageTwoResult> {
  const [mcapB, analyst] = await Promise.all([
    fetchMarketCapBillions(candidate.symbol),
    getAnalystEstimates(candidate.symbol, { forceFresh: options.forceFresh }),
  ]);
  const businessSimplicity = scoreBusinessSimplicity(candidate.symbol);
  const marketCapTier = scoreMarketCap(mcapB);
  const analystDispersion = scoreDispersion(analyst.dispersionPct);
  const preOverhang = businessSimplicity + marketCapTier + analystDispersion;
  const overhangPenalty = ACTIVE_OVERHANG.has(normalizeSymbol(candidate.symbol)) ? -3 : 0;
  const industryPenalty = options.industryPenalty ?? 0;
  const score = preOverhang + overhangPenalty + industryPenalty;
  // v4 gate: require marketCapTier >= config tier floor. Sub-scores
  // for businessSimplicity and analystDispersion are still surfaced
  // for display, but no longer drive pass/fail — the simulation showed
  // they were knocking out legitimate $20-30B mid-cap CSP names on
  // false-negative analyst data and the curated bs map is too thin
  // to be a reliable gate. Whitelisted symbols bypass entirely.
  const minTier = options.minMarketCapTier ?? 1;
  const meetsFloor = minTier <= 0 || marketCapTier >= minTier;
  const pass = options.isWhitelisted ? true : meetsFloor;
  const reason = options.isWhitelisted
    ? `Whitelisted — market cap floor bypassed (mcap=${mcapB ?? "null"}B)`
    : minTier <= 0
      ? `Market cap tier not gated (mcap=${mcapB ?? "null"}B, tier ${marketCapTier}/3)`
      : meetsFloor
        ? `Market cap floor met (mcap=${mcapB ?? "null"}B, tier ${marketCapTier}/3)`
        : `Below tier ${minTier} market cap floor (mcap=${mcapB ?? "null"}B, tier ${marketCapTier}/3)`;
  return {
    score,
    maxScore: 9,
    pass,
    reason,
    details: {
      businessSimplicity,
      marketCapTier,
      analystDispersion,
      activeOverhangPenalty: overhangPenalty,
      industryPenalty,
      marketCapBillions: mcapB,
      industryClass,
    },
  };
}

// ---------- Stage 3 ----------

function crushThresholdForDte(dte: number): number {
  if (dte >= 4) return 12;
  if (dte === 3) return 14;
  if (dte === 2) return 17;
  return 20; // 1 DTE or less
}

// Loosened from the original (A>=20, B>=16, C>=14) — the old C
// threshold meant anything below 56% of max scored F, which over-
// penalised stocks where one or two of the five sub-scores were
// thin. New brackets demand a 72% finish for an A, 56% for a B, and
// 40% for a C; stocks below 10/25 still skip out as F.
//
// maxScore defaults to 25 (all five components computed) but callers
// now pass the ACTUAL available-points max after excluding components
// that had no data — see combineCrushComponents. The 72/56/40% cut
// points are expressed as fractions of maxScore so a candidate missing
// a component is graded against what could be measured, not silently
// scored as if the missing component were a zero.
function gradeFromCrushScore(score: number, maxScore: number = 25): StageThreeResult["crushGrade"] {
  if (maxScore <= 0) return "F";
  const pct = score / maxScore;
  if (pct >= 18 / 25) return "A";
  if (pct >= 14 / 25) return "B";
  if (pct >= 10 / 25) return "C";
  return "F";
}

// ---------- Verified-evidence modifier ----------
//
// Historical note: an earlier "Fix C" cap (computeCrushRatioCap/
// capGrade) applied the schwab-verified ratio as a CEILING only — it
// could lower a grade but never raise one, and its thin-sample branch
// ceilinged at B even at verifiedN===0, which scored "no evidence
// either way" identically to "weak negative evidence." That made
// missing data an active penalty, not neutral, and was removed
// entirely (not just unwired) — see git history for the prior
// implementation and Test/test-crush-ratio-cap.ts (also removed) for
// its old test coverage. computeVerifiedModifier below replaces it: it
// can move the grade UP when verified evidence is good, and returns a
// hard 0 (no modifier at all) when verifiedN===0 — absence of evidence
// is not evidence of a bad setup.
const GRADE_ORDER: Record<"A" | "B" | "C" | "F", number> = { A: 3, B: 2, C: 1, F: 0 };
export type VerifiedModifierResult = {
  ratio: number | null;
  verifiedN: number;
  weight: number;
  // Grade steps on the A(3)/B(2)/C(1)/F(0) ordinal scale — positive
  // raises, negative lowers, 0 is neutral.
  delta: number;
  band: string;
  reason: string;
};

// verifiedRatios: each schwab/schwab_t0-sourced quarter's own
// actual/implied ratio (same population computeCrushRatioCap used —
// see the source-quality filter comment above). A single verified
// quarter can lower a grade (a severe miss is real signal even at
// n=1) but cannot raise one (one good print isn't enough evidence to
// certify a top grade) — that asymmetry is intentional, not a bug.
export function computeVerifiedModifier(verifiedRatios: number[]): VerifiedModifierResult {
  const n = verifiedRatios.length;
  if (n === 0) {
    return {
      ratio: null,
      verifiedN: 0,
      weight: 0,
      delta: 0,
      band: "no verified quarters",
      reason: "0 schwab-verified quarters — neutral, no modifier applied",
    };
  }
  const ratio = verifiedRatios.reduce((sum, r) => sum + r, 0) / n;
  const weight = n >= 5 ? 1.0 : n >= 2 ? 0.5 : 0.25;

  let baseDelta: number;
  let band: string;
  if (ratio <= 0.6) {
    baseDelta = 1;
    band = "excellent (<=0.6x)";
  } else if (ratio <= 1.0) {
    baseDelta = 0;
    band = "in line (0.6x-1.0x)";
  } else if (ratio <= 2.0) {
    baseDelta = -1;
    band = "moderate miss (1.0x-2.0x)";
  } else {
    baseDelta = -2;
    band = "severe miss (>2.0x)";
  }

  let delta: number;
  if (baseDelta === 0) {
    delta = 0;
  } else if (baseDelta === 1) {
    delta = weight >= 0.5 ? 1 : 0; // a single good quarter can't raise alone
  } else if (baseDelta === -1) {
    delta = -1; // any verified evidence of a moderate miss counts, even n=1
  } else {
    delta = weight >= 0.5 ? -2 : -1; // severe: n=1 still meaningful (-1), n>=2 full -2
  }

  return {
    ratio,
    verifiedN: n,
    weight,
    delta,
    band,
    reason: `${n} schwab-verified quarter(s), mean ratio ${ratio.toFixed(3)}x (${band}) -> ${delta >= 0 ? "+" : ""}${delta} grade step(s)`,
  };
}

const GRADE_STEPS: Array<"A" | "B" | "C" | "F"> = ["F", "C", "B", "A"];

// Applies computeVerifiedModifier's delta to a letter grade, clamped to
// the A..F range. delta===0 always returns the input grade unchanged —
// the neutral case is a true no-op, not a re-derivation.
export function applyGradeModifier(grade: "A" | "B" | "C" | "F", delta: number): "A" | "B" | "C" | "F" {
  if (delta === 0) return grade;
  const idx = GRADE_ORDER[grade];
  const next = Math.max(0, Math.min(3, idx + delta));
  return GRADE_STEPS[next];
}

// Bucketing tracks the user-facing crush narrative:
//   ratio < 0.7   stock historically undershoots the implied move (A)
//   ratio < 0.85  comfortable margin                             (B)
//   ratio < 1.0   median ≤ implied                               (C)
//   ratio < 1.2   stock typically prints close to / over implied (D)
//   ratio ≥ 1.2   stock consistently overshoots                  (F)
// Mapped onto the existing 0-8 sub-score scale (no D in the
// composite grade type — D collapses to a small partial-credit point).
// ratio is a per-quarter-ratio MEAN (buildQuarterlyMoveRatio) — never
// medianHistoricalMovePct/today's-current-emPct (that construction
// mixed one quarter's implied move into every OTHER quarter's actual
// move, which is a vol-regime read, not a calibration read — see
// buildQuarterlyMoveRatio's docblock).
function historicalMoveScoreFromRatio(ratio: number | null): number {
  if (ratio === null) return 0;
  if (ratio < 0.7) return 8;
  if (ratio < 0.85) return 5;
  if (ratio < 1.0) return 2;
  if (ratio < 1.2) return 1;
  return 0;
}

// ---------- Shrinkage (PASS_2E) — implemented, DISABLED at k=0 ----------
//
// n-distribution audit: mean historicalMoveScore was 4.64 at n=1 vs
// 3.17 at n=5+ — low-n candidates aren't just noisier, they're
// systematically INFLATED. Mechanism: move_ratio is right-skewed
// (population mean sits above its median), so a single draw lands
// below the mean more often than not and disproportionately catches
// the top scoring band (<0.7 -> 8pts). More quarters regress toward
// the population mean. Standard empirical-Bayes shrinkage toward the
// population mean fixes this without an arbitrary n-based cutoff:
//   adjusted = (n * tickerMean + k * populationMean) / (n + k)
// k is the "worth of evidence" a single population-mean draw carries,
// in units of quarters — k=2 means a ticker needs roughly 2 of its own
// quarters before its own mean starts to dominate the population prior.
// n=0 is NOT shrunk — there is no tickerMean to shrink, the component
// stays excluded via the existing neutral-missing-data path untouched.
//
// PASS_2F: held back at k=0 (a verified exact no-op — see
// applyShrinkage below). At k=2 it reintroduced per-letter
// non-monotonicity (B below A, F below C) that the pre-shrinkage state
// didn't have, and monotonicity was the one outcome signal favoring
// the new grades — not worth trading away for a variance correction
// with no outcome evidence of its own. The mechanism, the population-
// mean function, and the k config all stay in place so this can be
// revisited (e.g. a different prior, a data-driven k) without
// rebuilding it. Runtime cost is also gated off at k=0 — see the
// shrinkageEnabled check in runStagesThreeFour, which skips
// getPopulationMeanMoveRatio's paginated table scan entirely when the
// result can't affect the score.
export const DEFAULT_SHRINKAGE_K = 0;

export function applyShrinkage(
  tickerMean: number | null,
  n: number,
  populationMean: number,
  k: number = DEFAULT_SHRINKAGE_K,
): number | null {
  if (tickerMean === null || n <= 0) return null;
  // k===0 special-cased to return tickerMean directly rather than
  // (n*tickerMean + 0*populationMean)/(n+0) — algebraically identical,
  // but NOT bit-exact: floating-point rounding in the multiply-then-
  // divide can perturb the result (e.g. n=3, tickerMean=1.4 rounds to
  // 1.3999999999999997), which would silently mean "shrinkage
  // disabled" isn't quite a true no-op. This makes it exact.
  if (k === 0) return tickerMean;
  return (n * tickerMean + k * populationMean) / (n + k);
}

// ---------- Per-quarter move-ratio construction ----------
//
// The prior construction divided a multi-quarter MEDIAN actual move by
// TODAY's single live implied move — a wrong-denominator bug (every
// historical quarter got compared against a vol level it never
// actually traded at). This builds one ratio PER QUARTER, each against
// that quarter's OWN implied move, then means them.
export type QuarterRatioDetail = {
  earningsDate: string;
  impliedMovePct: number | null;
  dbActualMovePct: number | null;
  // Diagnostic only (see divergent/divergencePct below) — NEVER used to
  // fill actualUsed. PASS_2B finding: EarningsMove.actualMovePct
  // (lib/yahoo.ts) is UNSIGNED by construction (Math.abs(pct)), while
  // dbActualMovePct is signed. Comparing them directly manufactures a
  // large spurious "divergence" whenever the DB's real move was
  // negative — roughly half of all quarters — independent of whether
  // the underlying magnitudes actually agree. Kept for visibility, not
  // corrected here (see the PASS_2B sign-inversion diagnostic).
  yahooActualMovePct: number | null;
  actualUsed: number | null;
  actualSource: "db" | null;
  ratio: number | null; // null when this quarter is excluded
  excludedReason: string | null;
  // True when a DB actual and a Yahoo actual both exist for this
  // quarter and diverge by more than the threshold — logged only, per
  // the signed-vs-unsigned caveat above; do not read this as "the DB
  // value is wrong."
  divergent: boolean;
  divergencePct: number | null; // relative, |db-yahoo|/|db|
};

export type QuarterlyMoveRatioResult = {
  meanRatio: number | null;
  n: number; // count of quarters that produced a valid ratio
  quarters: QuarterRatioDetail[]; // full diagnostic list, newest first
};

export const DEFAULT_DIVERGENCE_THRESHOLD = 0.2; // 20% relative, configurable per call

// crushHistory: getCrushHistory's per-quarter DB rows (earnings_history),
// ANY implied_move_source — the schwab-only filter belongs to the
// verified modifier below, not here; this mean is meant to use every
// quarter with a real implied/actual pair regardless of source
// trustworthiness tier.
// historicalMoves: Yahoo-derived per-quarter actual moves — used ONLY
// for the divergence DIAGNOSTIC (yahooActualMovePct/divergent fields
// below), never to fill a missing DB actual. PASS_2B removed the old
// Yahoo fallback: EarningsMove.actualMovePct is unsigned (see
// QuarterRatioDetail's docblock), so filling a missing signed DB value
// with an unsigned Yahoo one could silently corrupt the mean with a
// sign-flipped magnitude. The neutral-missing-data composite (see
// combineCrushComponents) makes this costless — an unpaired quarter is
// simply excluded, same as it would be with no Yahoo data at all.
// Yahoo never supplies an implied move regardless, so a quarter absent
// from the DB entirely could never produce a ratio either way.
export function buildQuarterlyMoveRatio(
  crushHistory: CrushHistoryEvent[],
  historicalMoves: EarningsMove[],
  excludeEarningsDate: string,
  divergenceThreshold: number = DEFAULT_DIVERGENCE_THRESHOLD,
): QuarterlyMoveRatioResult {
  const yahooByDate = new Map(historicalMoves.map((m) => [m.date, m.actualMovePct]));
  const seenDates = new Set<string>();
  const quarters: QuarterRatioDetail[] = [];

  for (const h of crushHistory) {
    if (h.earningsDate === excludeEarningsDate) continue; // today's own not-yet-settled event
    seenDates.add(h.earningsDate);
    const implied = h.impliedMovePct;
    const dbActual = h.actualMovePct;
    const yahooActual = yahooByDate.get(h.earningsDate) ?? null;

    // Phantom too-early T1 capture — price_after/actual_move_pct were
    // taken before the real post-earnings settlement, so any ratio
    // built from them is unreliable regardless of implied/actual being
    // present (audit: 2026-08-11).
    if (h.t1Unrecoverable) {
      quarters.push({
        earningsDate: h.earningsDate,
        impliedMovePct: implied,
        dbActualMovePct: dbActual,
        yahooActualMovePct: yahooActual,
        actualUsed: null,
        actualSource: null,
        ratio: null,
        excludedReason: "t1_unrecoverable — phantom too-early capture, actual move unreliable",
        divergent: false,
        divergencePct: null,
      });
      continue;
    }

    let divergent = false;
    let divergencePct: number | null = null;
    if (dbActual !== null && yahooActual !== null) {
      const denom = Math.max(Math.abs(dbActual), 1e-6);
      divergencePct = Math.abs(dbActual - yahooActual) / denom;
      divergent = divergencePct > divergenceThreshold;
    }

    if (implied === null || implied <= 0) {
      quarters.push({
        earningsDate: h.earningsDate,
        impliedMovePct: implied,
        dbActualMovePct: dbActual,
        yahooActualMovePct: yahooActual,
        actualUsed: null,
        actualSource: null,
        ratio: null,
        excludedReason: "no implied move on record for this quarter",
        divergent,
        divergencePct,
      });
      continue;
    }

    // DB-only — no Yahoo fallback (see docblock above).
    const actualUsed = dbActual;
    const actualSource: "db" | null = dbActual !== null ? "db" : null;
    if (actualUsed === null) {
      quarters.push({
        earningsDate: h.earningsDate,
        impliedMovePct: implied,
        dbActualMovePct: dbActual,
        yahooActualMovePct: yahooActual,
        actualUsed: null,
        actualSource: null,
        ratio: null,
        excludedReason: "no actual move on record in earnings_history for this quarter",
        divergent,
        divergencePct,
      });
      continue;
    }

    quarters.push({
      earningsDate: h.earningsDate,
      impliedMovePct: implied,
      dbActualMovePct: dbActual,
      yahooActualMovePct: yahooActual,
      actualUsed,
      actualSource,
      ratio: Math.abs(actualUsed) / implied,
      excludedReason: null,
      divergent,
      divergencePct,
    });
  }

  // Quarters Yahoo knows about but that have no earnings_history row at
  // all — recorded for visibility only; no implied move exists for
  // them from any source, so they can never contribute a ratio.
  for (const m of historicalMoves) {
    if (m.date === excludeEarningsDate || seenDates.has(m.date)) continue;
    quarters.push({
      earningsDate: m.date,
      impliedMovePct: null,
      dbActualMovePct: null,
      yahooActualMovePct: m.actualMovePct,
      actualUsed: null,
      actualSource: null,
      ratio: null,
      excludedReason: "quarter absent from earnings_history — no implied move available",
      divergent: false,
      divergencePct: null,
    });
  }

  quarters.sort((a, b) => (a.earningsDate < b.earningsDate ? 1 : a.earningsDate > b.earningsDate ? -1 : 0));

  const valid = quarters.map((q) => q.ratio).filter((r): r is number => r !== null);
  const meanRatio = valid.length > 0 ? valid.reduce((sum, r) => sum + r, 0) / valid.length : null;

  return { meanRatio, n: valid.length, quarters };
}

function scoreConsistency(movePcts: number[]): number {
  if (movePcts.length < 3) return 0;
  const sd = stddev(movePcts);
  if (sd < 0.02) return 4;
  if (sd < 0.04) return 2;
  return 0;
}

export type TermStructureBands = {
  // Ratio thresholds, highest bucket first — see DEFAULT_TERM_STRUCTURE_BANDS.
  edges: [number, number, number];
  points: [number, number, number];
};

// Re-banded twice (PASS_2A/PASS_2B audits). Original edges (>1.5/>1.3/
// >1.1) saturated 144/152 (94.7%) of the live population at the full
// 5/5 — zero discriminating information. A first re-band (edges
// [3.0,2.2,1.7], fit to only 5 tickers) fixed discrimination but also
// collapsed the LEVEL: full-population mean contribution fell from
// ~4.8/5 to 2.12/5, silently tightening the fixed A/B/C grade bands
// for every candidate (that level shift, not the ranking change, was
// the dominant driver of an 80/116-candidate downgrade). It also
// floored legitimate inversions (CDNS 1.61, GLW 1.52) at a hard zero,
// a false negative — 1.7 truncated the bottom third of the observed
// ~1.5-3.6 range instead of discriminating across it.
//
// These edges were calibrated against the full 152-candidate live
// weekly/monthly IV ratio population (not just the 5 audit tickers):
// mean contribution ~3.37/5, distribution roughly 5/45/44/58 across
// 0/2/3/5 points, and the floor sits at 1.4 specifically so nothing
// above 1.4 — including CDNS/GLW — ever scores zero. Configurable, not
// re-hardcoded, so the next audit can retune without touching call
// sites.
export const DEFAULT_TERM_STRUCTURE_BANDS: TermStructureBands = {
  edges: [2.4, 1.9, 1.4],
  points: [5, 3, 2],
};

function scoreTermStructure(
  weeklyIv: number | null,
  monthlyIv: number | null,
  bands: TermStructureBands = DEFAULT_TERM_STRUCTURE_BANDS,
): number {
  if (!weeklyIv || !monthlyIv || monthlyIv <= 0) return 0;
  const ratio = weeklyIv / monthlyIv;
  const [e0, e1, e2] = bands.edges;
  const [p0, p1, p2] = bands.points;
  if (ratio > e0) return p0;
  if (ratio > e1) return p1;
  if (ratio > e2) return p2;
  return 0;
}

function scoreIvEdge(weeklyIv: number | null, realizedVol: number | null): number {
  if (!weeklyIv || !realizedVol || realizedVol <= 0) return 0;
  const ratio = weeklyIv / realizedVol;
  if (ratio >= 1.3 && ratio <= 1.6) return 4;
  if (ratio > 1.6 && ratio <= 1.9) return 3;
  if (ratio >= 1.2 && ratio < 1.3) return 2;
  if (ratio > 1.9) return 1;
  return 0;
}

// ---------- Pure crush-composite scoring (no I/O) ----------
//
// Factored out of runStageThree so the exact production scoring logic
// is independently callable — the validation/re-grade CLI
// (scripts/validate-crush-grade-fix.ts) calls this directly against
// persisted inputs rather than re-implementing the composite math a
// second time (which would drift from the real pipeline silently).
export type CrushCompositeInputs = {
  historicalMoves: EarningsMove[];
  crushHistory: CrushHistoryEvent[];
  // The candidate's own earnings date — excluded from crushHistory so
  // a same-day/not-yet-settled T0/T1 row never enters the ratio.
  earningsDate: string;
  dte: number;
  weeklyIv: number | null;
  monthlyIv: number | null;
  realizedVol: number | null;
  surpriseScore: number;
  surpriseQuartersExamined: number;
  termStructureBands?: TermStructureBands;
  divergenceThreshold?: number;
  // Population mean of move_ratio across ALL valid paired quarters in
  // earnings_history (see getPopulationMeanMoveRatio in
  // lib/earnings-history-table.ts) — required, not defaulted, so a
  // caller can never silently grade against a stale/hardcoded value.
  populationMeanRatio: number;
  shrinkageK?: number;
};

export type CrushCompositeResult = {
  score: number;
  maxScore: number;
  pass: boolean;
  crushGrade: "A" | "B" | "C" | "F";
  threshold: number;
  historicalMoveScore: number;
  consistencyScore: number;
  termStructureScore: number;
  ivEdgeScore: number;
  surpriseScore: number;
  scoreComponentsComputed: {
    historicalMove: boolean;
    consistency: boolean;
    termStructure: boolean;
    ivEdge: boolean;
    surprise: boolean;
  };
  quarterlyRatio: QuarterlyMoveRatioResult;
  // The shrunk estimate historicalMoveScore is actually computed from
  // — see applyShrinkage. null iff quarterlyRatio.n===0 (component
  // excluded, matches quarterlyRatio.meanRatio being null too).
  shrunkRatio: number | null;
  medianHistoricalMovePct: number | null;
};

export function computeCrushComposite(inputs: CrushCompositeInputs): CrushCompositeResult {
  const movePcts = inputs.historicalMoves.map((m) => m.actualMovePct);
  const medianMove = movePcts.length > 0 ? median(movePcts) : null;
  const quarterlyRatio = buildQuarterlyMoveRatio(
    inputs.crushHistory,
    inputs.historicalMoves,
    inputs.earningsDate,
    inputs.divergenceThreshold,
  );
  const shrunkRatio = applyShrinkage(quarterlyRatio.meanRatio, quarterlyRatio.n, inputs.populationMeanRatio, inputs.shrinkageK);

  const scoreComponentsComputed = {
    historicalMove: quarterlyRatio.n > 0,
    consistency: movePcts.length >= 3,
    termStructure: inputs.weeklyIv !== null && inputs.monthlyIv !== null && inputs.monthlyIv > 0,
    ivEdge: inputs.weeklyIv !== null && inputs.realizedVol !== null && inputs.realizedVol > 0,
    surprise: inputs.surpriseQuartersExamined >= 1,
  };

  const historicalMoveScore = historicalMoveScoreFromRatio(shrunkRatio);
  const consistencyScore = scoreConsistency(movePcts);
  const termStructureScore = scoreTermStructure(inputs.weeklyIv, inputs.monthlyIv, inputs.termStructureBands);
  const ivEdgeScore = scoreIvEdge(inputs.weeklyIv, inputs.realizedVol);
  const surpriseScore = inputs.surpriseScore;

  const componentPointsMax: Array<[boolean, number, number]> = [
    [scoreComponentsComputed.historicalMove, historicalMoveScore, 8],
    [scoreComponentsComputed.consistency, consistencyScore, 4],
    [scoreComponentsComputed.termStructure, termStructureScore, 5],
    [scoreComponentsComputed.ivEdge, ivEdgeScore, 4],
    [scoreComponentsComputed.surprise, surpriseScore, 4],
  ];
  const score = componentPointsMax.reduce((sum, [isComputed, points]) => sum + (isComputed ? points : 0), 0);
  const maxScore = componentPointsMax.reduce((sum, [isComputed, , max]) => sum + (isComputed ? max : 0), 0);
  const threshold = maxScore > 0 ? (crushThresholdForDte(inputs.dte) / 25) * maxScore : 0;

  return {
    score,
    maxScore,
    pass: maxScore > 0 && score >= threshold,
    crushGrade: gradeFromCrushScore(score, maxScore),
    threshold,
    historicalMoveScore,
    consistencyScore,
    termStructureScore,
    ivEdgeScore,
    surpriseScore,
    scoreComponentsComputed,
    quarterlyRatio,
    shrunkRatio,
    medianHistoricalMovePct: medianMove,
  };
}

function pickAtmContract(chain: SchwabOptionsChain, expiryPrefix: string, spot: number): SchwabOptionContract | null {
  const expKey = Object.keys(chain.putExpDateMap ?? {}).find((k) => k.startsWith(expiryPrefix));
  if (!expKey) return null;
  const strikes = chain.putExpDateMap[expKey];
  const contracts = Object.values(strikes).flat();
  if (contracts.length === 0) return null;
  let best = contracts[0];
  let bestDiff = Math.abs(best.strikePrice - spot);
  for (const c of contracts) {
    const diff = Math.abs(c.strikePrice - spot);
    if (diff < bestDiff) {
      best = c;
      bestDiff = diff;
    }
  }
  return best;
}

function ivPercent(raw: number | undefined | null): number | null {
  if (raw === undefined || raw === null || !Number.isFinite(raw)) return null;
  // Schwab reports IV in percent (e.g. 45 for 45%). Normalize to fraction.
  return raw > 1 ? raw / 100 : raw;
}

function annualizedRealizedVol(closes: number[]): number | null {
  if (closes.length < 15) return null;
  const returns: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] > 0) returns.push(Math.log(closes[i] / closes[i - 1]));
  }
  const sd = stddev(returns);
  return sd * Math.sqrt(252);
}

function expectedMoveFromIv(iv: number | null, dte: number): number | null {
  if (iv === null || dte <= 0) return null;
  return iv * Math.sqrt(dte / 365);
}

// Straddle-derived implied move (Fix A). Prior method: single ATM
// put's IV × √t — a formula proxy that ran systematically cooler than
// the market's actual priced-in move, since it never looked at what
// the straddle itself costs. This reads the price directly: expected
// move ≈ ATM straddle price / spot, the standard textbook definition.
//
// ATM strike selection: NEAREST strike to spot, not interpolation
// between the two bracketing strikes. Matches the existing
// pickAtmContract convention elsewhere in this file, and interpolation
// buys marginal precision for real complexity on a screener signal —
// this isn't pricing a live straddle trade, it's estimating one
// number. Judgment call, not derived from options math.
//
// Put and call legs are pinned to the SAME strike (a true straddle) —
// if the call side has no contract at the put's chosen strike (a
// mismatched strike grid), this returns null and the caller degrades
// to the old method rather than pricing two different strikes as if
// they were one straddle.
//
// Pricing: leg mid = (bid+ask)/2, falling back to mark/last only when
// bid+ask isn't usable. This is deliberately NOT the same side as pass
// 1's premium decision (bid, because a CSP SELLER only realizes the
// bid). There's no seller/buyer role here — this is a market-implied
// measurement, not a transaction — and mid is the standard convention
// for expected-move calculations specifically because it's unbiased:
// using ask would systematically overstate the move, bid would
// systematically understate it, the same failure mode Fix A exists to
// correct in the first place. Returns null (triggering the degraded
// fallback) if EITHER leg has no usable bid/ask/mark/last at all.
//
// No adjustment/scaling factor is applied to the raw straddle-over-
// spot ratio. I looked for a principled, non-empirical justification
// for one and found none — some practitioners apply a correction
// factor, but any specific value I picked without a real derivation
// would be exactly the "back-solve a constant to get a nicer number"
// the task explicitly forbids.
// A leg needs BOTH a real bid AND a real ask to count as a usable
// two-sided quote — the same "no bid = no real market" reasoning as
// pass 1's hard kill, extended here since a zero bid with a nonzero
// ask still produces a positive (bid+ask)/2 that looks like a normal
// mid price while actually reflecting no buyer at any price. Found
// live on KHC's put leg (bid=0, ask=1.13) during Checkpoint A
// verification — without this guard the straddle would have silently
// priced in a one-sided quote. No mark/last fallback here either. for
// the same reason pass 1 didn't fall back for the no-bid premium case.
//
// No-arbitrage floor: an American option's bid can never be below its
// own intrinsic value (put intrinsic = max(strike-spot,0), call
// intrinsic = max(spot-strike,0)) — a market maker will always bid at
// least intrinsic, since exercising immediately locks in that much.
// A sub-intrinsic bid is a stale/unquotable print, not a real price;
// this is a correctness invariant, not a tunable threshold. Found live
// on FBP (put bid=1.10, intrinsic=2.36) during Checkpoint A follow-up —
// averaging that bid in produced a straddle that was 73% intrinsic.
function legMidPrice(c: SchwabOptionContract, spot: number, side: "PUT" | "CALL"): number | null {
  const bid = Number.isFinite(c.bid) ? c.bid : 0;
  const ask = Number.isFinite(c.ask) ? c.ask : 0;
  if (bid <= 0 || ask <= 0) return null;
  const intrinsic = side === "PUT" ? Math.max(c.strikePrice - spot, 0) : Math.max(spot - c.strikePrice, 0);
  if (bid < intrinsic) return null;
  return (bid + ask) / 2;
}

export type StraddleImpliedMove = {
  emPct: number;
  strike: number;
  putMid: number;
  callMid: number;
  // |spot - strike| / spot for the nearest-strike ATM pick. Always
  // populated on success so callers can flag wide-grid contamination
  // (see runStageThree's atmDistanceFlag) without recomputing it.
  atmDistancePct: number;
  // Static intrinsic value of the ITM leg as a fraction of the total
  // straddle mid. Diagnostic only — the flag decision lives in
  // runStageThree, where an independent EM reference (ivFormulaEmPct)
  // is available to size the threshold.
  intrinsicPctOfStraddle: number;
};

// Deliberately no sanity bound here checking straddle/spot against the
// ~0.7979 Brenner-Subrahmanyam constant (straddle ≈ 0.8 x IV x sqrt(T)).
// That relationship assumes continuous lognormal diffusion; measured
// against real earnings straddles it holds at dte=3 (~0.78-0.79) but
// rises to ~0.95-1.07 at dte=2 (checkpoint A, PM/CME/PHM/T/EQT/NLY) —
// the straddle is correctly pricing the discrete earnings jump that the
// continuous formula can't see. That divergence from 0.8x is exactly
// the signal this method exists to capture; a guard around the constant
// would flag every real event as broken.
function computeStraddleImpliedMove(
  chain: SchwabOptionsChain,
  expiryPrefix: string,
  spot: number,
): { move: StraddleImpliedMove | null; failureReason: string | null } {
  if (spot <= 0) return { move: null, failureReason: "no spot price" };
  const putExpKey = Object.keys(chain.putExpDateMap ?? {}).find((k) => k.startsWith(expiryPrefix));
  const callExpKey = Object.keys(chain.callExpDateMap ?? {}).find((k) => k.startsWith(expiryPrefix));
  if (!putExpKey || !callExpKey) return { move: null, failureReason: "no matching expiry key on put or call side" };

  const puts = Object.values(chain.putExpDateMap[putExpKey] ?? {})
    .flat()
    .filter((c) => !c.putCall || c.putCall === "PUT");
  const calls = Object.values(chain.callExpDateMap[callExpKey] ?? {})
    .flat()
    .filter((c) => !c.putCall || c.putCall === "CALL");
  if (puts.length === 0 || calls.length === 0) return { move: null, failureReason: "empty put or call leg" };

  let put = puts[0];
  let bestDiff = Math.abs(put.strikePrice - spot);
  for (const c of puts) {
    const diff = Math.abs(c.strikePrice - spot);
    if (diff < bestDiff) {
      put = c;
      bestDiff = diff;
    }
  }
  const call = calls.find((c) => c.strikePrice === put.strikePrice);
  if (!call) return { move: null, failureReason: "no call at the put's ATM strike (strike grid mismatch)" };

  const putMid = legMidPrice(put, spot, "PUT");
  const callMid = legMidPrice(call, spot, "CALL");
  if (putMid === null || callMid === null) {
    const putBid = Number.isFinite(put.bid) ? put.bid : 0;
    const callBid = Number.isFinite(call.bid) ? call.bid : 0;
    const putIntrinsic = Math.max(put.strikePrice - spot, 0);
    const callIntrinsic = Math.max(spot - call.strikePrice, 0);
    const arbViolation =
      (putMid === null && put.bid > 0 && put.ask > 0 && putBid < putIntrinsic) ||
      (callMid === null && call.bid > 0 && call.ask > 0 && callBid < callIntrinsic);
    return {
      move: null,
      failureReason: arbViolation
        ? "leg bid below its own intrinsic value (no-arbitrage violation — stale/unquotable print)"
        : "missing bid/ask on a leg",
    };
  }

  const straddleMid = putMid + callMid;
  const intrinsic = Math.max(put.strikePrice - spot, 0) + Math.max(spot - call.strikePrice, 0);
  return {
    move: {
      emPct: straddleMid / spot,
      strike: put.strikePrice,
      putMid,
      callMid,
      atmDistancePct: bestDiff / spot,
      intrinsicPctOfStraddle: straddleMid > 0 ? intrinsic / straddleMid : 0,
    },
    failureReason: null,
  };
}

// Pick the soonest listed expiry in a range chain — used by the
// monthly-fallback path, where the range already starts at the
// unavailable weekly Friday, so the earliest key present is the
// nearest standard monthly expiry after the earnings date. Schwab keys
// look like "2026-05-16:32" (date:dte); only the date half is used —
// dte gets recomputed from today, not trusted from the key.
function pickEarliestExpiry(chain: SchwabOptionsChain): { key: string; date: string } | null {
  const keys = Object.keys(chain.putExpDateMap ?? {});
  let best: { key: string; date: string } | null = null;
  for (const k of keys) {
    const date = k.split(":")[0];
    if (!date) continue;
    if (!best || date < best.date) best = { key: k, date };
  }
  return best;
}

// Pick the expiration key whose DTE is closest to the target DTE, within the
// allowed [minDte, maxDte] window. Schwab keys look like "2026-05-16:32".
function pickExpirationNear(
  chain: SchwabOptionsChain,
  targetDte: number,
  minDte: number,
  maxDte: number,
): { key: string; dte: number } | null {
  const keys = Object.keys(chain.putExpDateMap ?? {});
  let best: { key: string; dte: number } | null = null;
  for (const k of keys) {
    const parts = k.split(":");
    const dte = Number(parts[1]);
    if (!Number.isFinite(dte) || dte < minDte || dte > maxDte) continue;
    if (!best || Math.abs(dte - targetDte) < Math.abs(best.dte - targetDte)) {
      best = { key: k, dte };
    }
  }
  return best;
}

export async function runStageThree(
  candidate: EarningsCandidate,
  chain: SchwabOptionsChain,
  monthlyChain: SchwabOptionsChain | null,
  historicalMoves: EarningsMove[],
  // Per-quarter DB history (getCrushHistory) — now fetched by the
  // caller BEFORE this function runs (moved up from its old post-hoc
  // spot in runStagesThreeFour) so the per-quarter ratio construction
  // has real implied-move-at-the-time data instead of the old
  // medianMove/today's-emPct approximation.
  crushHistory: CrushHistoryEvent[],
  // Shrinkage prior for historicalMoveRatio (PASS_2E) — see
  // getPopulationMeanMoveRatio in lib/earnings-history-table.ts.
  // Fetched once per batch by the caller (cached ~30min), not re-queried
  // per candidate.
  populationMeanRatio: number,
  opts: { forceFresh?: boolean } = {},
): Promise<StageThreeResult> {
  const sym = candidate.symbol;
  const weeklyAtm = pickAtmContract(chain, candidate.expiry, candidate.price);
  const weeklyIv = ivPercent(weeklyAtm?.volatility);
  console.log(
    `[stage3:${sym}] weekly ATM strike=${weeklyAtm?.strikePrice ?? "?"} raw.volatility=${weeklyAtm?.volatility ?? "?"} ` +
      `weeklyIv=${weeklyIv} spot=${candidate.price} expiry=${candidate.expiry}`,
  );

  let monthlyIv: number | null = null;
  let monthlyExpiryKey: string | null = null;
  if (monthlyChain) {
    const monthlyExpKeys = Object.keys(monthlyChain.putExpDateMap ?? {});
    console.log(
      `[stage3:${sym}] monthly chain has ${monthlyExpKeys.length} expirations: ${monthlyExpKeys.slice(0, 8).join(", ")}`,
    );
    const picked = pickExpirationNear(monthlyChain, 30, 22, 55);
    if (picked) {
      monthlyExpiryKey = picked.key;
      const prefix = picked.key.split(":")[0];
      const monthlyAtm = pickAtmContract(monthlyChain, prefix, candidate.price);
      monthlyIv = ivPercent(monthlyAtm?.volatility);
      console.log(
        `[stage3:${sym}] monthly ATM expKey=${picked.key} dte=${picked.dte} strike=${monthlyAtm?.strikePrice ?? "?"} ` +
          `raw.volatility=${monthlyAtm?.volatility ?? "?"} monthlyIv=${monthlyIv}`,
      );
    } else {
      console.warn(`[stage3:${sym}] monthly chain had no expiration in DTE window 22-55`);
    }
  } else {
    console.warn(`[stage3:${sym}] monthlyChain is null — monthly IV unavailable`);
  }

  // Fix A: prefer the straddle-derived implied move; the old IV×√t
  // formula is computed regardless (diagnostic field + degraded
  // fallback) so a before/after comparison never needs a second run.
  const ivFormulaEmPct = expectedMoveFromIv(weeklyIv, candidate.daysToExpiry);
  const { move: straddle, failureReason: straddleFailureReason } = computeStraddleImpliedMove(
    chain,
    candidate.expiry,
    candidate.price,
  );
  let emPct: number | null;
  let impliedMoveMethod: "straddle" | "iv_formula_degraded" | null;
  let impliedMoveDegradedReason: string | null;
  if (straddle !== null) {
    emPct = straddle.emPct;
    impliedMoveMethod = "straddle";
    impliedMoveDegradedReason = null;
  } else {
    emPct = ivFormulaEmPct;
    impliedMoveMethod = ivFormulaEmPct !== null ? "iv_formula_degraded" : null;
    impliedMoveDegradedReason = straddleFailureReason ?? "no usable ATM straddle quote";
  }
  // FLAG, not a kill: the nearest available strike can sit far enough
  // from spot that static intrinsic value swamps the time-value signal
  // the straddle is supposed to measure (FBP: strike 8.5% from spot,
  // straddle 73% intrinsic). Threshold is derived, not fit to FBP —
  // see the comment on atmDistanceFlag below — and only ever narrows
  // confidence in an already-computed straddle reading; it never
  // substitutes the degraded IV×√t method, which has no ATM-distance
  // concept of its own to fall back on.
  const atmDistancePct = straddle?.atmDistancePct ?? null;
  const intrinsicPctOfStraddle = straddle?.intrinsicPctOfStraddle ?? null;
  // Derivation: straddleMid decomposes as intrinsic + 2×(ITM leg's time
  // value), and put-call parity puts that time-value term at roughly
  // ivFormulaEmPct × spot for a true ATM strike (ivFormulaEmPct is an
  // independent reference — single-put IV × √t, computed above,
  // unrelated to the straddle or its strike grid). Flagging at
  // atmDistancePct > ivFormulaEmPct/2 means: by the time the strike-grid
  // error reaches half the size of the move itself, algebra gives
  // intrinsic ≈ 1/3 of the reported straddle price — a third of the
  // number is static ITM value, not a market read. Scales with each
  // name's own vol level (adaptive), not a flat percentage that would
  // be too loose for a high-IV name and too tight for a low-IV one.
  const atmDistanceFlag =
    straddle !== null &&
    atmDistancePct !== null &&
    ivFormulaEmPct !== null &&
    ivFormulaEmPct > 0 &&
    atmDistancePct > ivFormulaEmPct / 2;
  console.log(
    `[stage3:${sym}] implied move: method=${impliedMoveMethod ?? "none"} emPct=${emPct ?? "null"} ` +
      `${straddle ? `straddle(strike=${straddle.strike} putMid=${straddle.putMid.toFixed(2)} callMid=${straddle.callMid.toFixed(2)} atmDistancePct=${(straddle.atmDistancePct * 100).toFixed(2)}% intrinsicPct=${(straddle.intrinsicPctOfStraddle * 100).toFixed(1)}% atmDistanceFlag=${atmDistanceFlag})` : `degraded(${impliedMoveDegradedReason})`} ` +
      `ivFormulaEmPct=${ivFormulaEmPct ?? "null"} (weeklyIv * sqrt(${candidate.daysToExpiry}/365))`,
  );
  const movePcts = historicalMoves.map((m) => m.actualMovePct);
  console.log(
    `[stage3:${sym}] historicalMoves count=${historicalMoves.length} emPct=${emPct ?? "null"}`,
  );

  // 30-day realized vol proxy. Daily bars settle once at EOD, so this
  // is backed by the shared daily_bars_cache (lib/daily-bars-cache.ts)
  // — same cache the swing screener's ATR uses, whichever runs first
  // each day warms it for the other. That cache stores a wider window
  // than this calculation originally used, so slice back down to the
  // same 45-calendar-day lookback rather than passing the whole thing:
  // annualizedRealizedVol has no internal windowing, it uses whatever
  // array it's given, so passing a wider window would silently change
  // the computed vol for every candidate.
  const REALIZED_VOL_WINDOW_DAYS = 45;
  const cutoffIso = new Date(Date.now() - REALIZED_VOL_WINDOW_DAYS * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const allBars = await getOrFetchDailyBars(candidate.symbol, { forceFresh: opts.forceFresh });
  const prices = allBars.filter((b) => b.date >= cutoffIso);
  const closes = prices.map((p) => p.close).filter((c) => c > 0);
  const realizedVol = annualizedRealizedVol(closes);
  console.log(
    `[stage3:${sym}] realizedVol30d bars=${prices.length} usableCloses=${closes.length} rv=${realizedVol ?? "null"} ` +
      `ivEdgeRatio=${weeklyIv && realizedVol ? (weeklyIv / realizedVol).toFixed(2) : "n/a"}`,
  );

  const surprise = await getEarningsSurpriseHistory(candidate.symbol, { forceFresh: opts.forceFresh });

  const composite = computeCrushComposite({
    historicalMoves,
    crushHistory,
    earningsDate: candidate.earningsDate,
    dte: candidate.daysToExpiry,
    weeklyIv,
    monthlyIv,
    realizedVol,
    surpriseScore: surprise.surpriseScore,
    surpriseQuartersExamined: surprise.quartersExamined,
    populationMeanRatio,
  });
  const {
    score,
    maxScore,
    threshold,
    crushGrade,
    historicalMoveScore,
    consistencyScore,
    termStructureScore,
    ivEdgeScore,
    surpriseScore,
    scoreComponentsComputed: computed,
    quarterlyRatio,
    shrunkRatio,
    medianHistoricalMovePct: medianMove,
  } = composite;

  console.log(
    `[stage3:${sym}] SCORES hist=${historicalMoveScore}/${computed.historicalMove ? 8 : "excl"} ` +
      `cons=${consistencyScore}/${computed.consistency ? 4 : "excl"} ` +
      `term=${termStructureScore}/${computed.termStructure ? 5 : "excl"} ` +
      `ivEdge=${ivEdgeScore}/${computed.ivEdge ? 4 : "excl"} ` +
      `surprise=${surpriseScore}/${computed.surprise ? 4 : "excl"} ` +
      `total=${score}/${maxScore} threshold=${threshold.toFixed(2)} pass=${composite.pass} ` +
      `grade=${crushGrade} historicalMoveRatio=${quarterlyRatio.meanRatio?.toFixed(3) ?? "null"} (n=${quarterlyRatio.n})`,
  );
  void monthlyExpiryKey;

  // ---- DEBUG: SPOT-only validation dump (CRUSH inputs/intermediates). ----
  if (sym === "SPOT") {
    console.log(
      "[DEBUG:SPOT crush] " +
        JSON.stringify(
          {
            historicalEventCount: historicalMoves.length,
            historicalMoves: movePcts,
            medianHistoricalMove: medianMove,
            currentImpliedMove: emPct,
            quarterlyRatio,
            weeklyIv,
            monthlyIv,
            realizedVol30d: realizedVol,
            dte: candidate.daysToExpiry,
            scoreComponentsComputed: computed,
            scores: {
              historicalMoveScore,
              consistencyScore,
              termStructureScore,
              ivEdgeScore,
              surpriseScore,
              total: score,
              maxScore,
              threshold,
              pass: composite.pass,
              grade: crushGrade,
            },
            gradeThresholds: "A>=72%, B>=56%, C>=40% of maxScore, else F",
            historicalMoveScoreRule:
              "ratio = mean of each quarter's own actual/implied: <0.7 => 8pts, <0.85 => 5pts, <1.0 => 2pts, <1.2 => 1pt, else 0",
            note: "medianHistoricalMove/currentImpliedMove are diagnostic only — historicalMoveScore now comes from quarterlyRatio.meanRatio (per-quarter ratios), not this pair.",
          },
          null,
          2,
        ),
    );
  }

  // Verified (schwab-only) modifier is applied post-hoc in
  // runStagesThreeFour once crushHistory's implied_move_source is
  // filtered there — these detail fields are placeholders, overwritten
  // post-hoc.
  return {
    score,
    maxScore,
    pass: composite.pass,
    crushGrade,
    threshold,
    insufficientData: historicalMoves.length < 3,
    details: {
      historicalMoveScore,
      consistencyScore,
      termStructureScore,
      ivEdgeScore,
      surpriseScore,
      scoreComponentsComputed: computed,
      medianHistoricalMovePct: medianMove,
      historicalMoveRatio: quarterlyRatio.meanRatio,
      historicalMoveRatioN: quarterlyRatio.n,
      historicalMoveRatioShrunk: shrunkRatio,
      populationMeanRatio,
      shrinkageK: DEFAULT_SHRINKAGE_K,
      historicalMoveRatioQuarters: quarterlyRatio.quarters,
      expectedMovePct: emPct,
      crushRatio: null,
      crushRatioSeverity: null,
      crushRatioCapSampleWeight: 0,
      crushRatioVerifiedN: 0,
      crushVerifiedModifierDelta: 0,
      crushRatioCapApplied: false,
      impliedMoveMethod,
      impliedMoveDegradedReason,
      impliedMovePctIvFormula: ivFormulaEmPct,
      weeklyIv,
      monthlyIv,
      realizedVol30d: realizedVol,
      // Structural, not numeric — compares the expiry DATE the monthly-
      // IV window picked against candidate.expiry, not the IV values
      // themselves. weeklyIv and monthlyIv come from two independent
      // pickAtmContract calls against two separately-fetched chains
      // (different HTTP round-trips), so an exact float match isn't
      // guaranteed even when they're the same contract; the expiry
      // key is the real invariant "did both reads land on the same
      // expiration."
      termStructureExcluded:
        monthlyExpiryKey !== null && monthlyExpiryKey.startsWith(`${candidate.expiry}:`),
      atmDistancePct,
      intrinsicPctOfStraddle,
      atmDistanceFlag,
    },
  };
}

// ---------- Stage 4 ----------

// Opportunity scoring tracks premium + delta for transparency in
// details.{premiumYieldScore,deltaScore}, but the grade itself is now
// keyed directly on yield% bands calibrated for weekly earnings CSPs
// (1-5 DTE). Yield = (premium / strike) × 100 — strike is the capital
// at risk on a CSP, the same denominator the new Yield% column uses.
//
// Old bands (yield ÷ spot, plus weighted score) consistently
// over-graded large-cap names whose absolute premium looks fat but
// whose yield-on-capital is thin. The recalibrated bands match
// realistic weekly-CSP economics:
//   A: > 0.75%   strong premium for the held capital
//   B: 0.40–0.75%
//   C: 0.20–0.40%
//   F: < 0.20%   not worth tying up margin for the week
function scorePremiumYield(yieldPct: number): number {
  if (yieldPct > 0.75) return 12;
  if (yieldPct >= 0.4) return 8;
  if (yieldPct >= 0.2) return 3;
  return 0;
}

function scoreDelta(delta: number): number {
  const abs = Math.abs(delta);
  if (abs >= 0.08 && abs <= 0.12) return 8;
  if (abs > 0.12 && abs <= 0.18) return 5;
  if (abs > 0.18 && abs <= 0.25) return 2;
  return 0;
}

// Named so the ladder's yield bar (below) can reuse the exact same
// number instead of a second hardcoded 0.2 that could drift out of sync.
const YIELD_GRADE_C_THRESHOLD_PCT = 0.2;

function gradeFromYield(
  yieldPct: number,
): StageFourResult["opportunityGrade"] {
  if (yieldPct > 0.75) return "A";
  if (yieldPct >= 0.4) return "B";
  if (yieldPct >= YIELD_GRADE_C_THRESHOLD_PCT) return "C";
  return "F";
}

function pickStrikeNearest(chain: SchwabOptionsChain, expiryPrefix: string, targetStrike: number): SchwabOptionContract | null {
  return pickStrikeNearestWithDiff(chain, expiryPrefix, targetStrike)?.contract ?? null;
}

function pickStrikeNearestWithDiff(
  chain: SchwabOptionsChain,
  expiryPrefix: string,
  targetStrike: number,
): { contract: SchwabOptionContract; diff: number } | null {
  const expKey = Object.keys(chain.putExpDateMap ?? {}).find((k) => k.startsWith(expiryPrefix));
  if (!expKey) return null;
  // Defensive: Schwab puts the put chain in putExpDateMap, but if a
  // CALL ever leaks into the map filter it out — a CALL delta picked
  // here would silently torch POP (e.g. SPOT $410 call delta ≈ +0.97
  // → "POP = 1 - 0.97 = 3%" or, after Math.abs in the EV path,
  // appear as 0.97 → 3%). The PUT side gives -0.03 → 97%.
  const contracts = Object.values(chain.putExpDateMap[expKey])
    .flat()
    .filter((c) => !c.putCall || c.putCall === "PUT");
  if (contracts.length === 0) return null;
  let best = contracts[0];
  let bestDiff = Math.abs(best.strikePrice - targetStrike);
  for (const c of contracts) {
    const diff = Math.abs(c.strikePrice - targetStrike);
    if (diff < bestDiff) {
      best = c;
      bestDiff = diff;
    }
  }
  return { contract: best, diff: bestDiff };
}

// When the default ATM-centred chain (strikeCount=30) doesn't reach
// the math target — most common on high-IV names where 2× EM lands
// far OTM — refetch with strikeCount=200 narrowed to the candidate's
// expiry. Verified live via test/probe-spot-grid: a SPOT 4-DTE call
// with strikeCount=200 returns 132 strikes covering $300–$692.50,
// which comfortably includes any 2× EM target. We deliberately do
// NOT use the `strike=<exact>` parameter — Schwab silently returns
// an empty chain for non-grid values (e.g. strike=403.02 → 0 rows
// while $402.50 actually exists), so rounding-by-guess is fragile.
//
// Returns BOTH the picked contract AND the wide chain so the caller
// can reuse it to populate the availableStrikes snapshot — otherwise
// the client-side custom-strike picker is still bounded by the
// original 30-strike window and reproduces the same far-OTM bug.
async function fetchTargetedStrike(
  symbol: string,
  expiry: string,
  targetStrike: number,
): Promise<{ contract: SchwabOptionContract; chain: SchwabOptionsChain } | null> {
  try {
    const chain = await schwabGet<SchwabOptionsChain>("/marketdata/v1/chains", {
      symbol,
      contractType: "PUT",
      strikeCount: 200,
      fromDate: expiry,
      toDate: expiry,
      includeUnderlyingQuote: true,
      strategy: "SINGLE",
    });
    const contract = pickStrikeNearest(chain, expiry, targetStrike);
    if (!contract) return null;
    return { contract, chain };
  } catch (e) {
    console.warn(
      `[screener] ${symbol}: targeted lookup failed: ${e instanceof Error ? e.message : e}`,
    );
    return null;
  }
}

// Fill basis for grade/EV pricing. Raw bid understates realistic fills
// on wide-spread deep-OTM strikes (GLW $109 put: bid .14, ask .48, last
// .31 — grading on bid alone reads a trade as far worse than it is and
// mis-gates opportunity). Mid is the default, deliberately conservative
// basis (real fills land closer to ask ~90% of the time per the actual
// trading pattern this was calibrated against — mid is a floor, not a
// target). X is an optional aggressiveness offset toward ask:
// fill = mid + X * (ask - mid). X=0 is pure mid (the default); X=1
// would be ask itself. Dynamic, not hardcoded into the formula below —
// change this one constant to retune every consumer at once.
const FILL_BASIS_AGGRESSIVENESS_X = 0;

// Degenerate-quote guard: a mid is only trustworthy when both bid and
// ask are real, positive, two-sided quotes with ask >= bid. A missing/
// zero ask, or a crossed quote (ask < bid — stale/unquotable), would
// silently produce a garbage mid that inflates EV rather than reflect
// a real market. Falls back to bid (0 when bid itself is missing —
// same "no bid = no real market" reasoning as the existing hard-kill,
// which still fires downstream on that 0 regardless of this guard).
// midInvalid=true flags the fallback so it's visible, not silent.
export function computeFillPrice(
  bid: number,
  ask: number,
): { fill: number; midInvalid: boolean } {
  const bidOk = Number.isFinite(bid) && bid > 0;
  const askOk = Number.isFinite(ask) && ask > 0;
  if (!bidOk) return { fill: 0, midInvalid: false };
  if (!askOk || ask < bid) return { fill: bid, midInvalid: true };
  const mid = (bid + ask) / 2;
  return { fill: mid + FILL_BASIS_AGGRESSIVENESS_X * (ask - mid), midInvalid: false };
}

export async function runStageFour(
  candidate: EarningsCandidate,
  chain: SchwabOptionsChain,
  medianHistoricalMovePct: number | null,
  emPct: number | null,
): Promise<StageFourResult> {
  // Entry breadcrumb so we can confirm runStageFour is reached for a
  // given symbol — earlier we suspected SPOT was bypassing this path.
  console.log(`[DEBUG] runStageFour called for: ${candidate.symbol}`);
  // Strike picker: prefer the IV-implied weekly move (emPct, = weeklyIv ×
  // √(dte/365)) over historical median moves. Historical tells you what
  // the stock HAS done on recent quarters; emPct tells you what the
  // market IS pricing for THIS event. For a 2x-EM CSP strategy we want
  // the forward-looking number — otherwise thin-mover names like AXP get
  // strikes too close to spot and POP collapses.
  const referenceMove = emPct ?? medianHistoricalMovePct;
  const referenceSource: "iv" | "historical" | "none" =
    emPct !== null ? "iv" : medianHistoricalMovePct !== null ? "historical" : "none";
  const suggestedStrike =
    referenceMove !== null ? candidate.price * (1 - 2.0 * referenceMove) : null;
  console.log(
    `[stage4:${candidate.symbol}] strike calc: price=${candidate.price} ` +
      `emPct=${emPct !== null ? emPct.toFixed(4) : "null"} ` +
      `historicalMedian=${medianHistoricalMovePct !== null ? medianHistoricalMovePct.toFixed(4) : "null"} ` +
      `source=${referenceSource} ` +
      `suggestedStrike=${suggestedStrike !== null ? suggestedStrike.toFixed(2) : "null"} ` +
      `dte=${candidate.daysToExpiry}`,
  );
  if (referenceMove === null || suggestedStrike === null) {
    return {
      score: 0,
      maxScore: 20,
      opportunityGrade: "F",
      suggestedStrike: null,
      premium: null,
      delta: null,
      bid: null,
      ask: null,
      last: null,
      bidAskSpreadPct: null,
      premiumYieldPct: null,
      openInterest: null,
      volume: null,
      liquidityGrade: "F",
      liquidityReason: "no chain data",
      note: null,
      details: { premiumYieldScore: 0, deltaScore: 0, spreadScore: 0, contractSymbol: null },
    };
  }
  const initialPick = pickStrikeNearestWithDiff(chain, candidate.expiry, suggestedStrike);
  let contract: SchwabOptionContract | null = initialPick?.contract ?? null;
  let usedTargetedLookup = false;
  // When the targeted retry fires we also use its wide chain to
  // populate availableStrikes. Otherwise the client custom-strike
  // analyzer is stuck with the same ±15 strikes around ATM and
  // typing 420 on SPOT keeps snapping to $475.
  let strikesSourceChain: SchwabOptionsChain = chain;

  if (candidate.symbol === "SPOT") {
    const oneXStrike =
      referenceMove !== null ? candidate.price * (1 - referenceMove) : null;
    const twoXStrike =
      referenceMove !== null ? candidate.price * (1 - 2 * referenceMove) : null;
    console.log(
      "[DEBUG:SPOT strike calc] " +
        JSON.stringify(
          {
            price: candidate.price,
            emPct,
            referenceMove,
            oneXStrike,
            twoXStrike,
            suggestedStrike,
            initialPickStrike: initialPick?.contract.strikePrice ?? null,
            bestDiff: initialPick?.diff ?? null,
            willTriggerTargetedLookup: !!initialPick && initialPick.diff > 10,
          },
          null,
          2,
        ),
    );
  }

  // If the default chain (strikeCount=30 around ATM) doesn't reach
  // the math target — common on high-IV names where 2× EM lands far
  // OTM (SPOT 4-DTE put example: target $409, default chain stops at
  // $475) — refetch the chain filtered to the specific strike. Tested
  // via the test/probe-spot-delta script: the targeted call returns a
  // single contract for the requested strike with correct delta.
  if (initialPick && initialPick.diff > 10) {
    console.log(
      `[screener] ${candidate.symbol}: default chain missed target $${suggestedStrike.toFixed(
        2,
      )} by $${initialPick.diff.toFixed(2)} — retrying with targeted lookup`,
    );
    const targeted = await fetchTargetedStrike(
      candidate.symbol,
      candidate.expiry,
      suggestedStrike,
    );
    if (targeted) {
      contract = targeted.contract;
      strikesSourceChain = targeted.chain;
      usedTargetedLookup = true;
      console.log(
        `[screener] ${candidate.symbol}: targeted lookup hit strike=${targeted.contract.strikePrice} delta=${targeted.contract.delta} mark=${targeted.contract.mark}`,
      );
    } else {
      console.warn(
        `[screener] ${candidate.symbol}: targeted lookup returned null; falling back to nearest at $${initialPick.contract.strikePrice} (diff $${initialPick.diff.toFixed(2)})`,
      );
    }
  }

  // ---- DEBUG: SPOT-only options chain dump ----
  // Catches any of the failure modes we're hunting: wrong expiry,
  // strike rounding to the wrong contract, or Schwab returning a CALL
  // inside the put map for a strike. Logs every expiry on the chain,
  // the picked strike's full contract record, and the 5 surrounding
  // strikes' deltas so a -0.26 vs -0.03 mismatch is visible at a
  // glance.
  if (candidate.symbol === "SPOT") {
    const expKeys = Object.keys(chain.putExpDateMap ?? {});
    const matchedKey = expKeys.find((k) => k.startsWith(candidate.expiry)) ?? null;
    const allContracts = matchedKey
      ? Object.values(chain.putExpDateMap[matchedKey] ?? {}).flat()
      : [];
    const sortedByStrike = [...allContracts].sort(
      (a, b) =>
        Math.abs(a.strikePrice - suggestedStrike) -
        Math.abs(b.strikePrice - suggestedStrike),
    );
    const nearestFive = sortedByStrike.slice(0, 5).map((c) => ({
      strike: c.strikePrice,
      putCall: c.putCall,
      symbol: c.symbol,
      delta: c.delta,
      bid: c.bid,
      ask: c.ask,
      mark: c.mark,
    }));
    console.log(
      "[DEBUG:SPOT options] " +
        JSON.stringify(
          {
            candidateExpiry: candidate.expiry,
            availableExpiryKeys: expKeys,
            matchedExpiryKey: matchedKey,
            suggestedStrike,
            pickedContract: contract
              ? {
                  symbol: contract.symbol,
                  putCall: contract.putCall,
                  strikePrice: contract.strikePrice,
                  expirationDate: contract.expirationDate,
                  delta: contract.delta,
                  bid: contract.bid,
                  ask: contract.ask,
                  mark: contract.mark,
                  daysToExpiration: contract.daysToExpiration,
                }
              : null,
            nearestFiveByStrike: nearestFive,
          },
          null,
          2,
        ),
    );
    if (contract && contract.putCall && contract.putCall !== "PUT") {
      console.warn(
        `[DEBUG:SPOT options] picked contract has putCall=${contract.putCall} — expected PUT. This is the bug.`,
      );
    }
    if (contract && contract.delta > 0) {
      console.warn(
        `[DEBUG:SPOT options] put contract has positive delta=${contract.delta}. Expected negative for OTM put.`,
      );
    }
  }

  if (!contract) {
    return {
      score: 0,
      maxScore: 20,
      opportunityGrade: "F",
      suggestedStrike,
      premium: null,
      delta: null,
      bid: null,
      ask: null,
      last: null,
      bidAskSpreadPct: null,
      premiumYieldPct: null,
      openInterest: null,
      volume: null,
      liquidityGrade: "F",
      liquidityReason: "no contract picked",
      note: null,
      details: { premiumYieldScore: 0, deltaScore: 0, spreadScore: 0, contractSymbol: null },
    };
  }

  // Spread% still uses the mid as its denominator (standard convention
  // for expressing spread tightness) — feeds the graduated liquidity
  // read below (lib/liquidity.ts), alongside OI/volume.
  const mid = (contract.bid + contract.ask) / 2 || contract.mark || contract.last || 0;
  const bid = Number.isFinite(contract.bid) ? contract.bid : 0;
  const ask = Number.isFinite(contract.ask) ? contract.ask : 0;
  const last = Number.isFinite(contract.last) ? contract.last : 0;
  // A zero/missing bid means there is no price at which this contract
  // can actually be sold — distinct from "spread is wide but tradeable".
  // Hard-kill, not a spread-percentage judgment call. Unchanged by the
  // bid->mid fill-basis switch below: computeFillPrice returns fill=0
  // when bid<=0 either way, so this still fires on that 0.
  const noBid = !Number.isFinite(contract.bid) || contract.bid <= 0;
  // Premium priced at the FILL BASIS (mid by default, see
  // computeFillPrice/FILL_BASIS_AGGRESSIVENESS_X above) — not the raw
  // bid. Bid alone understates realistic fills on wide-spread deep-OTM
  // strikes and mis-gates opportunity; mid is what actually clears most
  // of the time. Falls back to bid (flagged via `note`) when the quote
  // itself is degenerate (crossed or missing ask) — a garbage mid must
  // never silently inflate EV. `last` is informational only (see the
  // returned `last` field) and never feeds this.
  const { fill: premium, midInvalid } = computeFillPrice(bid, ask);
  // Yield denominator is STRIKE (capital at risk on a cash-secured
  // put), not spot — matches the Yield% screener column and what a
  // trader computes when sizing capital. A $5 premium on a $500
  // strike reads 1.00% from either direction.
  const strike = contract.strikePrice;
  const yieldPct = strike > 0 ? (premium / strike) * 100 : 0;
  const spreadPctOfMid = mid > 0 ? ((contract.ask - contract.bid) / mid) * 100 : 100;
  const delta = contract.delta;

  console.log(
    `[stage4:${candidate.symbol}] pricing: bid=${bid} ask=${ask} mid=${mid.toFixed(2)} last=${last.toFixed(2)} ` +
      `premium(fill-priced)=${premium.toFixed(2)} spread%ofMid=${spreadPctOfMid.toFixed(1)} noBid=${noBid} midInvalid=${midInvalid}`,
  );

  const premiumYieldScore = scorePremiumYield(yieldPct);
  const deltaScore = scoreDelta(delta);
  const rawScore = premiumYieldScore + deltaScore;

  const openInterest = Number.isFinite(contract.openInterest) ? (contract.openInterest as number) : 0;
  const volume = Number.isFinite(contract.totalVolume) ? (contract.totalVolume as number) : 0;
  const liquidity = computeLiquidityRead(openInterest, volume, spreadPctOfMid);

  // Grade is yield-direct: > 0.75% / 0.40-0.75% / 0.20-0.40% / < 0.20%
  // → A / B / C / F (gradeFromYield/its thresholds are unchanged by
  // this). Delta doesn't influence the letter grade — a thin-premium A
  // would still be a bad trade — but deltaScore stays in details for
  // transparency. Liquidity then CAPS this down (never up — a thin
  // strike at great yield still can't grade A) via capGradeByLiquidity;
  // noBid remains the only hard kill, applied after the cap so a real
  // bid's liquidity read can't override "no bid at all."
  const yieldGrade = gradeFromYield(yieldPct);
  const opportunityGrade = noBid ? "F" : capGradeByLiquidity(yieldGrade, liquidity.grade);
  const liquidityCapped = !noBid && opportunityGrade !== yieldGrade;
  const note: string | null = noBid
    ? "No bid — cannot be sold at any price"
    : midInvalid
      ? "Bid/ask quote invalid (missing or crossed ask) — priced at bid, not mid"
      : liquidityCapped
        ? `Liquidity-capped from ${yieldGrade} — ${liquidity.reason}`
        : null;

  // Compact snapshot of the weekly put chain — the UI uses it to let
  // users try a custom strike without another API round-trip. When
  // the targeted retry fired we use ITS wide chain (200 strikes)
  // instead of the default 30, so a user typing a far-OTM strike
  // (e.g. $420 on SPOT when default chain stops at $475) actually
  // hits a real contract instead of snapping to the nearest ATM strike.
  const expKey = Object.keys(strikesSourceChain.putExpDateMap ?? {}).find((k) =>
    k.startsWith(candidate.expiry),
  );
  const availableStrikes: StageFourResult["availableStrikes"] = [];
  if (expKey) {
    for (const arr of Object.values(strikesSourceChain.putExpDateMap[expKey])) {
      for (const c of arr) {
        if (c.putCall && c.putCall !== "PUT") continue;
        // Mid — informational only, feeds EditableStrikeCell's spread%
        // denominator. Unchanged from before this fix.
        const strikeMid = (c.bid + c.ask) / 2 || c.mark || c.last || 0;
        // Premium — fill-priced via the same computeFillPrice used for
        // the suggested strike's own premium above: mid by default,
        // falling back to bid (flagged) on a degenerate quote, 0 when
        // bid itself is missing/non-numeric. Explicit NaN/non-numeric
        // check inside computeFillPrice, not a `||` chain: `(NaN +
        // ask)/2` is falsy in JS, which is exactly how a bad quote
        // silently fell through to raw Schwab mark before the original
        // bid-only fix (TMUS: bid/ask unusable on that snapshot, mark
        // ask-skewed, card showed 0.43 against a 0.25/0.45 market).
        const strikeBidRaw = Number.isFinite(c.bid) ? c.bid : 0;
        const strikeAskRaw = Number.isFinite(c.ask) ? c.ask : 0;
        const { fill: strikeFill, midInvalid: strikeFillInvalid } = computeFillPrice(
          strikeBidRaw,
          strikeAskRaw,
        );
        availableStrikes!.push({
          strike: c.strikePrice,
          bid: c.bid,
          ask: c.ask,
          mark: Math.round(strikeMid * 100) / 100,
          last: Number.isFinite(c.last) ? Math.round(c.last * 100) / 100 : 0,
          premiumFill: Math.round(strikeFill * 100) / 100,
          fillInvalid: strikeFillInvalid,
          delta: Math.round(c.delta * 1000) / 1000,
          oi: Number.isFinite(c.openInterest) ? (c.openInterest as number) : 0,
          volume: Number.isFinite(c.totalVolume) ? (c.totalVolume as number) : 0,
        });
      }
    }
    availableStrikes!.sort((a, b) => a.strike - b.strike);
  }

  return {
    score: rawScore,
    maxScore: 20,
    opportunityGrade,
    // suggestedStrike is the PICKED contract's strike, not the math
    // target — otherwise the UI displays a strike whose delta /
    // premium / mark are from a different contract. Math target is
    // surfaced separately in details.mathTargetStrike for reference.
    suggestedStrike: Math.round(contract.strikePrice * 100) / 100,
    premium: Math.round(premium * 100) / 100,
    delta: Math.round(delta * 1000) / 1000,
    bid: Math.round(bid * 100) / 100,
    ask: Math.round(ask * 100) / 100,
    last: Math.round(last * 100) / 100,
    bidAskSpreadPct: Math.round(spreadPctOfMid * 10) / 10,
    premiumYieldPct: Math.round(yieldPct * 1000) / 1000,
    openInterest,
    volume,
    liquidityGrade: liquidity.grade,
    liquidityReason: liquidity.reason,
    note,
    availableStrikes,
    details: {
      premiumYieldScore,
      deltaScore,
      // Liquidity's 0-100 composite score (lib/liquidity.ts) — depth
      // (OI/volume) weighted above spread. No longer a dead 0.
      spreadScore: liquidity.score,
      contractSymbol: contract.symbol,
      mathTargetStrike: Math.round(suggestedStrike * 100) / 100,
      usedTargetedLookup,
    },
  };
}

// Deliberately still always false, even after the liquidity-gate fix
// below wired real OI/volume/spread into opportunityGrade. Reactivating
// this as a binary hard-kill would directly violate the liquidity-gate
// requirement that a wide QUOTED spread must degrade, not fail, when
// real depth exists (the thin_chain_workable_limit case — a limit near
// mid often fills on a thin chain despite the spread looking bad).
// That graduated behavior now lives in stageFour.opportunityGrade via
// lib/liquidity.ts's capGradeByLiquidity; this recommendation-level
// binary kill would bypass it. Kept (not deleted) only so
// ScreenerResult.spreadTooWide/tradeable below keep resolving.
function isSpreadTooWide(): boolean {
  return false;
}

// ---------- Final recommendation ----------

function recommend(crush: StageThreeResult["crushGrade"], opp: StageFourResult["opportunityGrade"]): ScreenerResult["recommendation"] {
  const key = `${crush}/${opp}`;
  if (key === "A/A" || key === "A/B" || key === "B/A") return "Strong - Take the trade";
  if (key === "A/C" || key === "B/B") return "Marginal - Size smaller";
  return "Skip";
}

// ---------- Orchestration ----------

export type RawEarningsCandidate = { symbol: string; date: string; timing: "BMO" | "AMC" };

export function buildCandidateFromEarnings(
  row: { symbol: string; date: string; timing: "BMO" | "AMC" },
  price: number,
): EarningsCandidate {
  const earningsDate = new Date(row.date + "T00:00:00Z");
  // Guardrail: never select an expiry that's already in the past. A
  // previously screened candidate cached for SPOT (earnings Apr 28)
  // could have stamped expiry=Apr 24 if the row's `date` was a stale
  // Finnhub value, then position-snapshots downstream would fall back
  // through "[snapshots] expiry drift" warnings. Clamp the seed for
  // nextFridayOnOrAfter to max(earningsDate, today+1 trading day) so
  // the computed Friday is always strictly in the future.
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const seed = earningsDate < today ? today : earningsDate;
  const friday = nextFridayOnOrAfter(seed);
  // daysToExpiry is the option's real time-to-expiration and must be
  // measured from TODAY (the screening date), never from `seed`/
  // earningsDate. A BMO name reporting tomorrow still has a contract
  // whose time value runs from today->expiry, not tomorrow->expiry —
  // anchoring on earningsDate understates t and (via expectedMoveFromIv)
  // silently deflates the IV-formula fallback's expected move.
  const dte = businessDaysBetween(today, friday);
  return {
    symbol: row.symbol,
    price,
    earningsDate: row.date,
    earningsTiming: row.timing,
    daysToExpiry: Math.max(1, dte),
    expiry: toIsoDate(friday),
  };
}

export async function safeGetChain(
  symbol: string,
  fromDate: string,
  toDate: string,
  opts: { contractType?: "PUT" | "CALL" | "ALL"; strikeCount?: number } = {},
): Promise<SchwabOptionsChain | null> {
  try {
    const chain = await getOptionsChain(
      symbol,
      fromDate,
      opts.contractType ?? "PUT",
      opts.strikeCount ?? 30,
    );
    void toDate;
    return chain;
  } catch (e) {
    console.log(
      `[screener] safeGetChain ${symbol} ${fromDate}: ${e instanceof Error ? e.message : e}`,
    );
    return null;
  }
}

export async function safeGetChainRange(
  symbol: string,
  fromDate: string,
  toDate: string,
  opts: { contractType?: "PUT" | "CALL" | "ALL"; strikeCount?: number } = {},
): Promise<SchwabOptionsChain | null> {
  try {
    return await getOptionsChainRange(
      symbol,
      fromDate,
      toDate,
      opts.contractType ?? "PUT",
      opts.strikeCount ?? 30,
    );
  } catch (e) {
    console.warn(
      `[screener] safeGetChainRange(${symbol}, ${fromDate}→${toDate}) failed:`,
      e instanceof Error ? e.message : e,
    );
    return null;
  }
}

export function chainHasWeeklyExpiry(chain: SchwabOptionsChain, expiryIso: string): boolean {
  return hasWeeklyFridayExpiry(chain, expiryIso);
}

// Known ETF / fund tickers that can occasionally appear in calendar feeds.
const KNOWN_ETFS: ReadonlySet<string> = new Set<string>([
  "SPY", "IVV", "VOO", "VTI", "VXUS", "QQQ", "QQQM", "IWM", "DIA",
  "EEM", "EFA", "VEA", "VWO", "AGG", "BND", "LQD", "HYG", "TLT", "IEF",
  "GLD", "SLV", "USO", "UNG", "DBC",
  "XLF", "XLK", "XLE", "XLV", "XLP", "XLU", "XLI", "XLRE", "XLB", "XLY", "XLC",
  "TQQQ", "SQQQ", "UVXY", "SOXL", "SOXS", "SPXL", "SPXS", "TMF", "TMV", "ARKK", "SVXY",
  "SCHD", "SCHB", "VIG", "JEPI", "JEPQ", "BIL", "SHV", "SGOV",
]);

export function isLikelyCommonEquity(symbol: string): boolean {
  if (!symbol) return false;
  const s = symbol.trim().toUpperCase();
  if (s.length === 0 || s.length > 10) return false;
  if (!/^[A-Z]{1,5}([.\-][A-Z]{1,2})?$/.test(s)) return false;
  if (KNOWN_ETFS.has(s)) return false;
  return true;
}

// ---- New pipeline helpers ----

export type ScreenContext = {
  connected: boolean;
  chain: SchwabOptionsChain | null;
  industryClass: IndustryClass;
  industryStatus: "pass" | "fail" | "unknown";
  isWhitelisted: boolean;
  // Bypasses the Finnhub analyst-estimates cache for Stage 2 — still
  // writes the fresh result back.
  forceFresh?: boolean;
};

// Runs Stage 1 + Stage 2 and returns a ScreenerResult with stages 3/4 null and
// recommendation set to "Needs analysis". Stage 3/4 are populated later via
// runStagesThreeFour when the user clicks "Run Analysis".
export async function evaluateStagesOneTwo(
  candidate: EarningsCandidate,
  context: ScreenContext,
): Promise<ScreenerResult> {
  const industryPenalty =
    context.isWhitelisted || context.industryStatus === "pass" || context.industryStatus === "unknown"
      ? 0
      : -2;

  const stageOne = await runStageOne(candidate, context.chain, context.industryClass);
  const stageTwo = await runStageTwo(candidate, context.industryClass, {
    industryPenalty,
    isWhitelisted: context.isWhitelisted,
    forceFresh: context.forceFresh,
  });

  const baseResult: Omit<ScreenerResult, "recommendation" | "stoppedAt" | "stageThree" | "stageFour" | "threeLayer"> = {
    symbol: candidate.symbol,
    price: candidate.price,
    earningsDate: candidate.earningsDate,
    earningsTiming: candidate.earningsTiming,
    daysToExpiry: candidate.daysToExpiry,
    expiry: candidate.expiry,
    // Stage 1/2 hasn't attempted a chain fetch yet; runStagesThreeFour
    // overwrites this if it falls back to a monthly expiry.
    expirySource: "weekly",
    stageOne,
    stageTwo,
    errors: [],
    isWhitelisted: context.isWhitelisted,
    industryStatus: context.industryStatus,
    spreadTooWide: false,
  };

  return {
    ...baseResult,
    stoppedAt: null,
    stageThree: null,
    stageFour: null,
    recommendation: "Needs analysis",
    threeLayer: null,
  };
}

// Takes an existing stage-1/2 ScreenerResult and fills in stages 3 + 4 using
// fresh Schwab + Yahoo data. Returns a new ScreenerResult (does not mutate).
// opts.skipPersist: sandbox/test callers set this so the pipeline's
// market-data side writes (live implied move + flow snapshot into
// earnings_history) are skipped — a sandbox candidate carries a fake
// earnings date and would mint a bogus event row.
export async function runStagesThreeFour(
  base: ScreenerResult,
  opts?: { skipPersist?: boolean; forceFresh?: boolean },
): Promise<ScreenerResult> {
  let candidate: EarningsCandidate = {
    symbol: base.symbol,
    price: base.price,
    earningsDate: base.earningsDate,
    earningsTiming: base.earningsTiming,
    daysToExpiry: base.daysToExpiry,
    expiry: base.expiry,
  };
  let expirySource: ScreenerResult["expirySource"] = "weekly";

  // Fetch ALL sides (not just PUT) at strikeCount=200 up front — a
  // strict superset of both the old PUT/30 default (so Stage 3/4's
  // strike-picking is unaffected; pickAtmContract/pickStrikeNearestWithDiff
  // only ever read chain.putExpDateMap, which Schwab populates
  // identically regardless of contractType) and of what
  // computeOptionsFlow's own chain fetch below used to ask for
  // separately. This is the fix for the "verify-chains and pass2 both
  // fetch the same chain" audit finding as applied within pass2 itself
  // — it collapses what could be up to 4 chain fetches per candidate
  // (this one, a conditional targeted-strike retry, and options-flow's
  // own fetch) down to at most 2 (this one + the genuinely-different
  // monthly-expiry fetch below). The conditional targeted retry stays
  // as a safety net for the rare case even a 200-strike window misses
  // the 2x-EM target, but should almost never fire now.
  let chain = await safeGetChain(candidate.symbol, candidate.expiry, candidate.expiry, {
    contractType: "ALL",
    strikeCount: 200,
  });

  // ---- DEBUG: SPOT-only chain dump (full Schwab response shape).
  // Captures the actual response right after the Schwab fetch so we
  // can compare against the broker UI without having to also reach
  // runStageFour. Most useful when the picked contract's delta
  // disagrees with the broker — the surrounding strikes will show
  // whether it's a pick error or a Schwab data error.
  if (candidate.symbol === "SPOT") {
    const expKeys = Object.keys(chain?.putExpDateMap ?? {});
    const matchedKey = chain
      ? expKeys.find((k) => k.startsWith(candidate.expiry)) ?? null
      : null;
    const target = candidate.price > 0 ? candidate.price : 0;
    const allPuts =
      chain && matchedKey
        ? Object.values(chain.putExpDateMap[matchedKey] ?? {})
            .flat()
            .filter((c) => !c.putCall || c.putCall === "PUT")
        : [];
    const sorted = [...allPuts].sort(
      (a, b) =>
        Math.abs(a.strikePrice - target) - Math.abs(b.strikePrice - target),
    );
    console.log(
      "[DEBUG:SPOT chain] " +
        JSON.stringify(
          {
            requestedExpiry: candidate.expiry,
            availableExpiryKeys: expKeys,
            matchedExpiryKey: matchedKey,
            spotPrice: candidate.price,
            putsNearSpot: sorted.slice(0, 10).map((c) => ({
              strike: c.strikePrice,
              putCall: c.putCall,
              symbol: c.symbol,
              delta: c.delta,
              bid: c.bid,
              ask: c.ask,
              mark: c.mark,
              expirationDate: c.expirationDate,
            })),
            chainPutCount: allPuts.length,
            chainHasWeekly: chain ? chainHasWeeklyExpiry(chain, candidate.expiry) : false,
          },
          null,
          2,
        ),
    );
  }

  if (!chain || !chainHasWeeklyExpiry(chain, candidate.expiry)) {
    const requestedWeekly = candidate.expiry;
    if (!chain) {
      console.log(
        `[screener] ${candidate.symbol} soft-fail: chain unavailable (null) for expiry ${requestedWeekly}`,
      );
    } else {
      const availableKeys = Object.keys(chain.putExpDateMap ?? {});
      console.log(
        `[screener] ${candidate.symbol} soft-fail: weekly ${requestedWeekly} not in chain. ` +
          `Available expiry keys: ${availableKeys.join(", ") || "(none)"}`,
      );
    }

    // No weekly at the earnings-driven Friday — many mid/small-caps and
    // financials only list standard monthlies. Before giving up, search
    // out to +60 days for the nearest expiry on/after the requested
    // weekly and use that instead, explicitly flagged via expirySource
    // so it's never a silent substitution.
    const fallbackTo = new Date(
      new Date(`${requestedWeekly}T00:00:00Z`).getTime() + 60 * 24 * 60 * 60 * 1000,
    );
    const fallbackChain = await safeGetChainRange(
      candidate.symbol,
      requestedWeekly,
      toIsoDate(fallbackTo),
      { contractType: "ALL", strikeCount: 200 },
    );
    const picked = fallbackChain ? pickEarliestExpiry(fallbackChain) : null;

    if (fallbackChain && picked) {
      const today = new Date();
      today.setUTCHours(0, 0, 0, 0);
      const pickedExpiryDate = new Date(`${picked.date}T00:00:00Z`);
      candidate = {
        ...candidate,
        expiry: picked.date,
        daysToExpiry: Math.max(1, businessDaysBetween(today, pickedExpiryDate)),
      };
      chain = fallbackChain;
      expirySource = "monthly_fallback";
      console.log(
        `[screener] ${candidate.symbol} monthly fallback: weekly ${requestedWeekly} unavailable, ` +
          `using ${picked.date} (dte=${candidate.daysToExpiry}) instead`,
      );
    } else {
      return {
        ...base,
        stoppedAt: 3,
        stageThree: null,
        stageFour: null,
        recommendation: "Cannot evaluate",
        errors: [...(base.errors ?? []), "Schwab chain unavailable for weekly expiry"],
        threeLayer: null,
      };
    }
  }

  // crushHistory moved up from its old post-hoc fetch (below, alongside
  // optionsFlow) so runStageThree can build the per-quarter move ratio
  // directly instead of the old medianMove/today's-emPct approximation
  // — see buildQuarterlyMoveRatio.
  //
  // populationMeanRatio (PASS_2E shrinkage prior) is SKIPPED at k=0
  // (PASS_2F: shrinkage disabled) — applyShrinkage(mean, n, pop, 0)
  // always returns mean unchanged, so the value literally cannot affect
  // the score. getPopulationMeanMoveRatio does a paginated full-table
  // scan (cached ~30min, but still real DB round-trips on a cache
  // miss); no reason to pay that cost in the hot path when shrinkage is
  // off. This check assumes no caller overrides shrinkageK away from
  // DEFAULT_SHRINKAGE_K — if that ever changes, this needs to track it.
  const shrinkageEnabled = DEFAULT_SHRINKAGE_K !== 0;
  const [historicalMoves, crushHistory, population] = await Promise.all([
    getHistoricalEarningsMovements(candidate.symbol),
    getCrushHistory(candidate.symbol, 8),
    shrinkageEnabled ? getPopulationMeanMoveRatio() : Promise.resolve({ mean: 1, n: 0 }),
  ]);

  // Monthly IV needs a date RANGE, not a single day — 3rd-Friday monthly
  // expiries only rarely coincide with any given today+N.
  const monthlyFrom = new Date(Date.now() + 22 * 24 * 60 * 60 * 1000);
  const monthlyTo = new Date(Date.now() + 55 * 24 * 60 * 60 * 1000);
  const monthlyChain = await safeGetChainRange(
    candidate.symbol,
    toIsoDate(monthlyFrom),
    toIsoDate(monthlyTo),
  );
  console.log(
    `[stage3:${candidate.symbol}] monthly chain fetch ${toIsoDate(monthlyFrom)}→${toIsoDate(monthlyTo)} ` +
      `result=${monthlyChain ? "ok" : "null"}`,
  );

  const stageThree = await runStageThree(candidate, chain, monthlyChain, historicalMoves, crushHistory, population.mean, {
    forceFresh: opts?.forceFresh,
  });

  // Encyclopedia crush fallback: when live history is too thin to grade
  // the crush (insufficientData), substitute the batch-computed
  // avg_move_ratio (actual/implied across all captured earnings pairs)
  // through the same grade bands. Converts "Crush unproven" to a real
  // letter for symbols with 3+ historical pairs. Score/pass semantics
  // are untouched — only the letter that feeds the grade cascade.
  //
  // Deliberately NOT re-run through Fix C's crushRatioCap: that cap is
  // keyed on historicalMoves.length (the LIVE fetch, thin here by
  // definition since insufficientData is true), but this fallback
  // substitutes a ratio from a DIFFERENT, more complete source
  // (total_earnings_records) that already gates on >=3 records via the
  // check below. Applying the live-n thin-sample ceiling on top would
  // punish a well-evidenced encyclopedia grade for a thinness that
  // belongs to a different dataset.
  if (stageThree.insufficientData) {
    try {
      const sb = createServerClient();
      const encRes = await sb
        .from("stock_encyclopedia")
        .select("avg_move_ratio,total_earnings_records")
        .eq("symbol", candidate.symbol.toUpperCase())
        .limit(1);
      const enc = ((encRes.data ?? []) as Array<{
        avg_move_ratio: number | string | null;
        total_earnings_records: number | null;
      }>)[0];
      if (enc && enc.avg_move_ratio !== null && Number(enc.total_earnings_records ?? 0) >= 3) {
        const g = gradeFromRatio(Number(enc.avg_move_ratio));
        if (g) {
          // gradeFromRatio's D band maps to F in the 4-letter scale.
          stageThree.crushGrade = (g === "D" ? "F" : g) as "A" | "B" | "C" | "F";
          (stageThree.details as Record<string, unknown>).crushGradeSource = "encyclopedia";
          console.log(
            `[screener] ${candidate.symbol}: crush ${stageThree.crushGrade} from encyclopedia avg_move_ratio (live history thin)`,
          );
        }
      }
    } catch (e) {
      console.warn(
        `[screener] encyclopedia crush fallback failed for ${candidate.symbol}: ${e instanceof Error ? e.message : e}`,
      );
    }
  }

  const stageFour = await runStageFour(
    candidate,
    chain,
    stageThree.details.medianHistoricalMovePct,
    stageThree.details.expectedMovePct,
  );

  // Persist today's live IV-implied move to earnings_history so the
  // per-quarter crush table downstream has a real EM column for this
  // event. Source 'schwab' marks the row as live-captured (vs the
  // 'perplexity' backfill source). Non-blocking on failure.
  if (stageThree.details.expectedMovePct !== null && !opts?.skipPersist) {
    await persistLiveImpliedMove(
      candidate.symbol,
      candidate.earningsDate,
      stageThree.details.expectedMovePct,
      "schwab",
    );
  }

  // Options flow (Schwab full chain) + Fix B's loss-multiplier ladder
  // run concurrently. crushHistory was already fetched above (needed
  // earlier now, for runStageThree's per-quarter ratio). Both stamped
  // on stageThree.details so the API response surfaces them without
  // changing the top-level result shape.
  const [optionsFlow, lossMultiplierResult] = await Promise.all([
    stageThree.details.expectedMovePct !== null
      ? computeOptionsFlow({
          symbol: candidate.symbol,
          expiry: candidate.expiry,
          spotPrice: candidate.price,
          emPct: stageThree.details.expectedMovePct,
          suggestedStrike: stageFour.suggestedStrike,
          prefetchedChain: chain,
        }).catch((e: unknown) => {
          console.warn(
            `[options-flow] ${candidate.symbol} failed: ${e instanceof Error ? e.message : e}`,
          );
          return null;
        })
      : Promise.resolve<OptionsFlow | null>(null),
    computeLossMultiplierLadder(candidate.symbol).catch((e: unknown) => {
      console.warn(
        `[loss-multiplier] ${candidate.symbol} failed: ${e instanceof Error ? e.message : e}`,
      );
      return null as LossMultiplierResult | null;
    }),
  ]);
  stageThree.details.crushHistory = crushHistory;
  stageThree.details.optionsFlow = optionsFlow;

  // Verified modifier: apply bidirectional, evidence-scaled adjustment
  // now that crushHistory (with each quarter's implied_move_source) is
  // available. Schwab-only filter per the PASS_2A source-quality audit
  // — see computeVerifiedModifier's docblock. Applied AFTER whichever
  // grade is currently on stageThree (composite score or the
  // encyclopedia-fallback substitution above), so it's a backstop
  // regardless of which mechanism produced the letter. Excludes
  // h.earningsDate === candidate.earningsDate: the T0/T1 crush capture
  // cron writes a schwab_t0 row for the CURRENT cycle's own earnings
  // before it's happened yet (seeding the pre-earnings implied move) —
  // found live on NOW's own 2026-07-22 row, actual_move_pct 0.0003
  // sampled hours apart same-day, nowhere near a real post-earnings
  // reaction. That's the live candidate itself, not history.
  const schwabRatios = crushHistory
    .filter(
      (h) =>
        (h.impliedMoveSource === "schwab" || h.impliedMoveSource === "schwab_t0") &&
        h.ratio !== null &&
        h.earningsDate !== candidate.earningsDate,
    )
    .map((h) => h.ratio as number);
  const modifier = computeVerifiedModifier(schwabRatios);
  const preModifierGrade = stageThree.crushGrade;
  stageThree.crushGrade = applyGradeModifier(preModifierGrade, modifier.delta);
  stageThree.details.crushRatio = modifier.ratio;
  stageThree.details.crushRatioSeverity = modifier.verifiedN > 0 ? modifier.band : null;
  stageThree.details.crushRatioCapSampleWeight = modifier.weight;
  stageThree.details.crushRatioVerifiedN = modifier.verifiedN;
  stageThree.details.crushVerifiedModifierDelta = modifier.delta;
  stageThree.details.crushRatioCapApplied = stageThree.crushGrade !== preModifierGrade;
  console.log(
    `[crush-verified-modifier] ${candidate.symbol} ${modifier.reason} ` +
      `preModifierGrade=${preModifierGrade} postModifierGrade=${stageThree.crushGrade}`,
  );

  if (lossMultiplierResult) {
    stageThree.details.lossMultiplier = lossMultiplierResult.multiplier;
    stageThree.details.lossMultiplierSource = lossMultiplierResult.source;
    stageThree.details.lossMultiplierTickerN = lossMultiplierResult.tickerBreachN;
    stageThree.details.lossMultiplierSectorN = lossMultiplierResult.sectorBreachN;
    stageThree.details.lossMultiplierPoolN = lossMultiplierResult.poolBreachN;
    console.log(
      `[loss-multiplier] ${candidate.symbol} multiplier=${lossMultiplierResult.multiplier.toFixed(3)} ` +
        `source=${lossMultiplierResult.source} tickerN=${lossMultiplierResult.tickerBreachN} ` +
        `sectorN=${lossMultiplierResult.sectorBreachN} poolN=${lossMultiplierResult.poolBreachN}`,
    );
  }

  // Persist the flow snapshot to the earnings_history row for this
  // upcoming event so future quarters can compare pre-print positioning
  // against the actual outcome. Same row that holds implied_move_pct;
  // upsert keys on (symbol, earnings_date). Non-blocking.
  if (optionsFlow && !opts?.skipPersist) {
    await persistFlowSnapshot(
      candidate.symbol,
      candidate.earningsDate,
      optionsFlow,
    );
  }

  const spreadTooWide = isSpreadTooWide();
  // Spread-too-wide is a hard kill regardless of any other signal.
  // Otherwise: if Stage 3 passes, use the normal crush×opportunity matrix.
  // If Stage 3 fails only because history is thin (insufficientData) AND the
  // opportunity is strong (A/B), surface it as "Marginal - Crush unproven"
  // so the user can decide rather than being blanket-skipped.
  const oppA = stageFour.opportunityGrade === "A";
  const oppB = stageFour.opportunityGrade === "B";
  let recommendation: ScreenerResult["recommendation"];
  if (spreadTooWide) {
    recommendation = "Skip";
  } else if (stageThree.pass) {
    recommendation = recommend(stageThree.crushGrade, stageFour.opportunityGrade);
  } else if (stageThree.insufficientData && (oppA || oppB)) {
    recommendation = "Marginal - Crush unproven";
  } else {
    recommendation = "Skip";
  }
  const tradeable = !spreadTooWide && recommendation !== "Skip";

  return {
    ...base,
    expiry: candidate.expiry,
    daysToExpiry: candidate.daysToExpiry,
    expirySource,
    stoppedAt: tradeable ? null : 3,
    stageThree,
    stageFour,
    recommendation,
    spreadTooWide,
    threeLayer: base.threeLayer ?? null,
  };
}

// ---------- Three-layer grade ----------

function dropGrade(g: Grade): Grade {
  if (g === "A") return "B";
  if (g === "B") return "C";
  return "F";
}

function boostGrade(g: Grade): Grade {
  if (g === "F") return "C";
  if (g === "C") return "B";
  return "A";
}

// Grade → illustrative score (for display + sort stability only — the
// rule cascade is the source of truth).
function gradeToFinalScore(g: Grade): number {
  if (g === "A") return 90;
  if (g === "B") return 72;
  if (g === "C") return 55;
  return 30;
}
function gradeToL1Score(g: Grade): number {
  if (g === "A") return 54;
  if (g === "B") return 43;
  if (g === "C") return 33;
  return 18;
}
function gradeToL2Score(g: Grade): number {
  if (g === "A") return 22;
  if (g === "B") return 18;
  if (g === "C") return 13;
  return 8;
}
function gradeToL3Score(g: Grade): number {
  if (g === "A") return 14;
  if (g === "B") return 11;
  if (g === "C") return 8;
  return 4;
}

// Returns closed-position stats for a ticker: count, win rate, avg ROC.
// Used by Layer 2 of the three-layer grade — "personal" literally, so
// it's scoped to the user running the analysis. dataInsufficient=true
// when we have fewer than 5 closed trades on the ticker — in that case
// the grader treats Layer 2 as neutral rather than penalizing on noise.
// Terminal statuses: expired_worthless and assigned ARE outcomes (the
// most common winning outcome is expiry) — the old closed-only filter
// hid a third of the user's history from Layer 2.
const TERMINAL_STATUSES = ["closed", "expired_worthless", "assigned"];

type PersonalRow = {
  id: string;
  strike: number | null;
  realized_pnl: number | null;
  total_contracts: number | null;
  position_type: string | null;
  trade_chain_id: string | null;
  campaign_id: string | null;
  trade_type: string | null;
  peak_capital: number | null;
};

// Most-severe-wins when a campaign groups chains that disagree on type
// — recovery_play contamination is exactly why the exclusion below
// exists, so it dominates a milder rolled/clean chain sharing the same
// campaign. Mirrors lib/campaigns.ts's mostSevereType.
const TRADE_TYPE_SEVERITY: Record<string, number> = { clean: 0, rolled: 1, recovery_play: 2 };

type PersonalStats = {
  tradeCount: number;
  winRate: number | null;
  avgRoc: number | null;
  dropWinRate: number | null;
  cleanCount: number;
  rolledCount: number;
  recoveryCount: number;
};

// Campaign-aware stats. Positions are grouped into campaigns
// (lib/campaigns.ts — one earnings decision, spanning every chain and
// strike opened against the same print), falling back to trade chains
// or a solo position when no campaign was resolved. Each group is ONE
// outcome/sample: personalStats counts one earnings event once, not
// once per chain the app happened to split it into (CRWV's three
// 2026-05-07 chains were one decision and are one sample here). P&L is
// computed at read time as sum(realized_pnl) across all members
// (including assignment stock legs) over peak_capital. chain_pnl is a
// write-time-only cache populated at import; it is never revisited when
// a position later closes via auto-expiry/confirm-expire, so it goes
// stale — deliberately not read here.
// Weights per trade type:
//   clean          — 1.0 toward boost, 1.0 toward drop
//   rolled         — 0.5 toward boost, 1.0 toward drop (patience, not edge)
//   recovery_play  — excluded entirely (deep ITM = synthetic long, not a CSP)
// Unclassified rows fall back to per-position clean semantics with
// strike-based capital ROC.
function personalStats(rows: PersonalRow[]): PersonalStats {
  type ChainAgg = {
    type: string;
    pnl: number;
    // peak_capital is a chain-level cache: every member row of the same
    // trade_chain_id carries an IDENTICAL value. Summing per row would
    // multiply it by member count once a campaign groups multiple
    // chains together, so capital is tracked per underlying chain here
    // and summed once per distinct chain at finalization — an upper
    // bound when a campaign's chains overlap in time (two strikes sold
    // the same morning), not an exact concurrent peak.
    capitalByChain: Map<string, number>;
    fallbackCapital: number;
  };
  const chains = new Map<string, ChainAgg>();
  for (const r of rows) {
    const isStock =
      r.position_type === "stock_long" || r.position_type === "stock_short";
    // Stock rows only participate through their group's pnl sum; an
    // unchained, uncampaigned stock row is not a CSP outcome.
    if (isStock && !r.campaign_id && !r.trade_chain_id) continue;
    const key = r.campaign_id ?? r.trade_chain_id ?? `solo:${r.id}`;
    const agg = chains.get(key) ?? {
      type: r.trade_type ?? "clean",
      pnl: 0,
      capitalByChain: new Map<string, number>(),
      fallbackCapital: 0,
    };
    // Most-severe-wins across members of the group, not last-row-wins
    // — a campaign can hold more than one chain (e.g. one clean, one
    // recovery_play), and the contamination has to survive the merge.
    if (r.trade_type) {
      const cur = TRADE_TYPE_SEVERITY[agg.type] ?? 0;
      const next = TRADE_TYPE_SEVERITY[r.trade_type] ?? 0;
      if (next >= cur) agg.type = r.trade_type;
    }
    if (r.peak_capital !== null) {
      const chainKey = r.trade_chain_id ?? `solo:${r.id}`;
      agg.capitalByChain.set(chainKey, Number(r.peak_capital));
    }
    agg.pnl += Number(r.realized_pnl ?? 0);
    if (!isStock) {
      agg.fallbackCapital += Number(r.strike ?? 0) * Number(r.total_contracts ?? 0) * 100;
    }
    chains.set(key, agg);
  }

  let cleanCount = 0;
  let rolledCount = 0;
  let recoveryCount = 0;
  let wBoost = 0;
  let winBoost = 0;
  let wDrop = 0;
  let winDrop = 0;
  const rocW: Array<{ roc: number; w: number }> = [];
  for (const agg of Array.from(chains.values())) {
    const pnl = agg.pnl;
    const chainCapitalSum = Array.from(agg.capitalByChain.values()).reduce((s, c) => s + c, 0);
    const capital = chainCapitalSum > 0 ? chainCapitalSum : agg.fallbackCapital;
    const win = pnl > 0 ? 1 : 0;
    const roc = capital > 0 ? (pnl / capital) * 100 : null;
    if (agg.type === "recovery_play") {
      recoveryCount += 1;
      continue; // excluded from CSP grading entirely
    }
    const boostW = agg.type === "rolled" ? 0.5 : 1.0;
    if (agg.type === "rolled") rolledCount += 1;
    else cleanCount += 1;
    wBoost += boostW;
    winBoost += boostW * win;
    wDrop += 1.0;
    winDrop += win;
    if (roc !== null) rocW.push({ roc, w: boostW });
  }

  const tradeCount = cleanCount + rolledCount;
  if (tradeCount === 0) {
    return {
      tradeCount: 0,
      winRate: null,
      avgRoc: null,
      dropWinRate: null,
      cleanCount,
      rolledCount,
      recoveryCount,
    };
  }
  const winRate = wBoost > 0 ? (winBoost / wBoost) * 100 : null;
  const dropWinRate = wDrop > 0 ? (winDrop / wDrop) * 100 : null;
  const wSum = rocW.reduce((s, x) => s + x.w, 0);
  const avgRoc =
    wSum > 0 ? rocW.reduce((s, x) => s + x.roc * x.w, 0) / wSum : null;
  return { tradeCount, winRate, avgRoc, dropWinRate, cleanCount, rolledCount, recoveryCount };
}

const NO_HISTORY: PersonalHistory = {
  tradeCount: 0,
  winRate: null,
  avgRoc: null,
  dataInsufficient: true,
  scope: "none",
  sectorIndustry: null,
  dropWinRate: null,
  cleanCount: 0,
  rolledCount: 0,
  recoveryCount: 0,
};

const PERSONAL_COLS =
  "id, strike, realized_pnl, total_contracts, position_type, trade_chain_id, campaign_id, trade_type, peak_capital";

export async function getPersonalHistory(
  userId: string,
  symbol: string,
): Promise<PersonalHistory> {
  try {
    const supabase = createServerClient();
    const upper = symbol.toUpperCase();
    const { data, error } = await supabase
      .from("positions")
      .select(PERSONAL_COLS)
      .eq("user_id", userId)
      .eq("symbol", upper)
      .in("status", TERMINAL_STATUSES);
    if (error || !data) return { ...NO_HISTORY };
    const ticker = personalStats(data as PersonalRow[]);
    const tickerLevel = {
      campaigns: ticker.tradeCount,
      clean: ticker.cleanCount,
      rolled: ticker.rolledCount,
      recovery: ticker.recoveryCount,
    };
    const sampleWeight =
      ticker.tradeCount >= 5 ? 1.0 : ticker.tradeCount >= 2 ? 0.5 : ticker.tradeCount === 1 ? 0.25 : 0;

    // Sector aggregates are fetched regardless of ticker sample size —
    // they corroborate small-sample ticker evidence and are the sole
    // evidence when the ticker has no campaigns.
    let sector: PersonalHistory["sector"] = null;
    let sectorStatsFull: PersonalStats | null = null;
    const profRes = await supabase
      .from("stock_profiles")
      .select("industry")
      .eq("symbol", upper)
      .limit(1);
    const industry =
      ((profRes.data ?? []) as Array<{ industry: string | null }>)[0]?.industry ?? null;
    if (industry) {
      const symsRes = await supabase
        .from("stock_profiles")
        .select("symbol")
        .eq("industry", industry)
        .limit(300);
      const syms = ((symsRes.data ?? []) as Array<{ symbol: string }>).map((r) =>
        r.symbol.toUpperCase(),
      );
      if (syms.length > 0) {
        const secRes = await supabase
          .from("positions")
          .select(PERSONAL_COLS)
          .eq("user_id", userId)
          .in("symbol", syms)
          .in("status", TERMINAL_STATUSES);
        if (!secRes.error) {
          const sec = personalStats((secRes.data ?? []) as PersonalRow[]);
          if (sec.tradeCount >= 10) {
            sector = {
              industry,
              campaigns: sec.tradeCount,
              winRate: sec.winRate,
              avgRoc: sec.avgRoc,
              dropWinRate: sec.dropWinRate,
              recoveryCount: sec.recoveryCount,
            };
            sectorStatsFull = sec;
          }
        }
      }
    }

    // Ticker evidence is NEVER hidden: with 1+ campaigns the top-level
    // stats are ticker-level (caveated by sampleWeight downstream).
    // Zero campaigns → sector aggregates carry the top level (scope
    // "sector"), or scope "none" when neither exists.
    if (ticker.tradeCount >= 1) {
      return {
        ...ticker,
        dataInsufficient: false,
        scope: "ticker",
        sectorIndustry: industry,
        tickerLevel,
        sampleWeight,
        sector,
      };
    }
    if (sector && sectorStatsFull) {
      return {
        tradeCount: sector.campaigns,
        winRate: sector.winRate,
        avgRoc: sector.avgRoc,
        dropWinRate: sector.dropWinRate,
        cleanCount: sectorStatsFull.cleanCount,
        rolledCount: sectorStatsFull.rolledCount,
        recoveryCount: sector.recoveryCount,
        dataInsufficient: false,
        scope: "sector",
        sectorIndustry: industry,
        tickerLevel,
        sampleWeight: 0,
        sector,
      };
    }
    return {
      ...ticker,
      dataInsufficient: true,
      scope: "none",
      sectorIndustry: industry,
      tickerLevel,
      sampleWeight: 0,
      sector: null,
    };
  } catch {
    return { ...NO_HISTORY };
  }
}

// Fix A/B/C's EV formula, factored out from calculateThreeLayerGrade's
// original inline version. Used for the base 2xEM-strike EV only — this
// app never computes EV for any other strike.
function computeCspExpectedValue(params: {
  pop: number;
  premium: number;
  emPct: number;
  lossMultiplier: number;
  currentPrice: number;
  commission: number;
}): number {
  const assignmentLoss =
    params.currentPrice > 0 && params.emPct > 0
      ? params.emPct * params.lossMultiplier * params.currentPrice * 100
      : 0;
  const gross =
    params.pop * params.premium * 100 - (1 - params.pop) * assignmentLoss;
  return gross - params.commission * 2;
}

// PASS_3: "is this name's earnings setup favorable" — the EXACT same
// cascade calculateThreeLayerGrade uses for finalGrade, minus every
// opportunity/premium clause. Premium is compensation, not opportunity;
// this answers a different question. POP passed in must be the 2xEM-
// reference POP (stable, comparable across candidates) — the only
// strike this app ever recommends.
function computeSetupGrade(
  crushGrade: Grade,
  probabilityOfProfit: number,
  hasOverhang: boolean,
  vix: number | null,
  penalty: number,
  history: PersonalHistory,
  historyScope: "ticker" | "sector" | "none",
): Grade {
  const crushOk = crushGrade === "A" || crushGrade === "B";
  let setupGrade: Grade;
  if (crushOk && probabilityOfProfit >= 0.9 && !hasOverhang && (vix === null || vix < 25)) {
    setupGrade = "A";
  } else if (probabilityOfProfit >= 0.83 && (crushOk || probabilityOfProfit >= 0.95) && !hasOverhang) {
    setupGrade = "B";
  } else if (probabilityOfProfit >= 0.75 && penalty > -15) {
    setupGrade = "C";
  } else {
    setupGrade = "F";
  }
  if (hasOverhang) {
    setupGrade = "F";
  } else if (vix !== null && vix > 30) {
    setupGrade = dropGrade(setupGrade);
  }
  const sampleW = history.sampleWeight ?? (historyScope === "ticker" ? 1.0 : 0);
  if (!history.dataInsufficient && history.winRate !== null && !hasOverhang) {
    const wr = history.winRate;
    const dropWr = history.dropWinRate ?? wr;
    const roc = history.avgRoc ?? 0;
    const sec = history.sector ?? null;
    let modifier: "boost" | "drop" | null = null;
    if (historyScope === "ticker") {
      if (sampleW >= 1.0) {
        if (wr > 80 && roc > 0.3) modifier = "boost";
        else if (dropWr < 50) modifier = "drop";
      } else if (sampleW >= 0.5) {
        if (wr > 80 && roc > 0.3 && sec !== null && (sec.winRate ?? 0) >= 60 && sec.campaigns >= 10) {
          modifier = "boost";
        } else if (dropWr < 50) {
          modifier = "drop";
        }
      } else if (sampleW >= 0.25) {
        if (dropWr < 50 && sec !== null && (sec.dropWinRate ?? 100) < 50) {
          modifier = "drop";
        }
      }
    } else if (historyScope === "sector" && dropWr < 45) {
      modifier = "drop";
    }
    if (modifier === "boost") setupGrade = boostGrade(setupGrade);
    else if (modifier === "drop") setupGrade = dropGrade(setupGrade);
  }
  return setupGrade;
}

// PASS_3: reports whether the 2xEM reference strike itself has a real,
// tradeable bid — and its premium/POP/%OTM when it does. This used to
// walk availableStrikes toward the money looking for a closer rung to
// recommend instead of the 2xEM strike; that inward walk is removed.
// It was overriding the user's own 2xEM rule to find *any* tradeable
// premium — on one real case it walked 9 strikes toward the money to
// land on a $0.10 bid / $1.55 ask contract with no last trade, which
// is not a better trade, it's a worse one wearing a passing badge.
// 2xEM is the recommendation, full stop; this function never proposes
// an alternative — it only says whether THAT strike is liquid.
function evaluateReferenceStrike(
  availableStrikes: NonNullable<StageFourResult["availableStrikes"]> | undefined,
  spot: number,
  referenceStrike: number,
): ReferenceStrikeCheck {
  const strikes = availableStrikes ?? [];
  const rung = strikes.find((s) => s.strike === referenceStrike) ?? null;
  // premiumFill is fill-priced (mid by default) but is exactly 0 only
  // when the raw bid itself is 0 — computeFillPrice never invents a
  // positive fill from nothing, so this test means "no real bid," not
  // "mid rounded to zero." Same noBid rule runStageFour already applies
  // to the suggested strike (bid<=0 -> premium forced to 0, hard-killed
  // to opportunityGrade F).
  if (!rung || rung.premiumFill <= 0) {
    return {
      status: "no_bid",
      referenceStrike,
      text: `No bid at 2xEM ($${referenceStrike.toFixed(2)}).`,
    };
  }
  const pop = 1 - Math.abs(rung.delta);
  const pctOtm = spot > 0 ? ((spot - referenceStrike) / spot) * 100 : 0;
  return {
    status: "tradeable",
    referenceStrike,
    premiumFill: rung.premiumFill,
    pctOtm,
    pop,
    delta: rung.delta,
    text: `2xEM strike ($${referenceStrike.toFixed(2)}) is tradeable: $${rung.premiumFill.toFixed(2)} mid, ${(pop * 100).toFixed(0)}% POP, ${pctOtm.toFixed(1)}% OTM.`,
  };
}

// Rule-based grade cascade. No weighted points — the grade is assigned
// by a small ladder of explicit conditions, with overrides for
// hasActiveOverhang / high VIX and a boost/drop modifier from personal
// history. Scores returned on the result are illustrative buckets
// derived from the assigned grade; the rule is the source of truth.
export function calculateThreeLayerGrade(
  stageThreeResult: StageThreeResult,
  stageFourResult: StageFourResult,
  newsContext: PerplexityNewsResult,
  personalHistory: PersonalHistory | null,
  vix: number | null,
  currentPrice: number = 0,
  // Optional per-call override (e.g. a future per-user setting or a
  // verification script comparing rates) — defaults to the
  // env-configured commissionPerContract() when omitted.
  commissionOverride?: number,
  // Defaults "weekly" for callers that predate this param (none of the
  // scoring below branches on it yet — see ThreeLayerGrade.expirySource).
  expirySource: "weekly" | "monthly_fallback" = "weekly",
): ThreeLayerGrade {
  const crushGrade = stageThreeResult.crushGrade;
  const opportunityGrade = stageFourResult.opportunityGrade;

  const delta = stageFourResult.delta ?? 0;
  const probabilityOfProfit = 1 - Math.abs(delta);
  const premium = stageFourResult.premium ?? 0;
  const strike = stageFourResult.suggestedStrike ?? 0;
  const breakevenPrice = strike - premium;
  // PASS_2A Fix B: assignmentLoss no longer references strike or a
  // strike-mimicking "currentPrice × (1 − 2×emPct)" reconstruction at
  // all — that formula was IDENTICAL to Stage 4's strike-selection
  // formula, so assignmentLoss collapsed to ~0 by construction on every
  // candidate (the audit's "EV is 93-100% of premium" finding).
  //
  // E[loss|breach] now comes from computeLossMultiplierLadder: a
  // multiplier learned from pooled historical (implied,actual) move
  // ratios — "when a 2xEM strike breaches, how far past does it
  // typically land, in EM-units" — via a ticker/sector/global shrinkage
  // ladder (ticker and sector default DARK, weight-zero, until each
  // clears its own BREACH-count bar; see LOSS_LADDER_MIN_BREACH_N in
  // earnings-history-table.ts). The multiplier is real, measured data,
  // never a transform of THIS candidate's own emPct — applying it
  // through emPct here is a units conversion (EM-multiples -> today's
  // dollars), not a re-derivation of the multiplier itself.
  //
  //   assignmentLoss = emPct × lossMultiplier × currentPrice × 100
  //   EV             = POP × premium × 100 − (1 − POP) × assignmentLoss
  //
  // As of PASS_2A checkpoint, the ladder resolves to the global pool
  // (multiplier ≈0.331, n=6 breaches) for effectively every candidate —
  // no ticker or sector yet clears the breach-count bar. That's a real
  // fix over the old identity (loss is no longer mathematically pinned
  // to zero, and the empirical tail is fatter than a lognormal's ~2%
  // mass past 2σ — measured here at 4.2%) but it means loss-DEPTH
  // differentiation across candidates is currently dormant; EV varies
  // via probabilityOfProfit (delta) and premium, not yet via a
  // ticker/sector-specific loss read. Self-promotes with zero code
  // change once a bucket clears the bar.
  const emPct = stageThreeResult.details.expectedMovePct ?? 0;
  // Fallback mirrors FALLBACK_LOSS_MULTIPLIER_NO_POOL_DATA in
  // earnings-history-table.ts — only reachable for callers/mocks that
  // predate this field (e.g. Test/test-three-layer.ts fixtures) or if
  // the async ladder fetch failed upstream.
  const lossMultiplier = stageThreeResult.details.lossMultiplier ?? 0.331;
  // Friction — commission only, not half-spread (premium is already
  // bid-priced, which already captures entry slippage). Two legs:
  // entry (sell to open) + exit (buy to close or assignment). A final
  // subtraction only — does not touch how loss itself is computed.
  const commission = commissionOverride ?? commissionPerContract();
  // Factored into computeCspExpectedValue (above calculateThreeLayerGrade)
  // so PASS_3's ladder-recommended-strike EV reuses this exact formula
  // instead of a second hand-copy of it. Same math, same numbers as
  // before this refactor.
  const expectedValue = computeCspExpectedValue({
    pop: probabilityOfProfit,
    premium,
    emPct,
    lossMultiplier,
    currentPrice,
    commission,
  });

  const weeklyIv = stageThreeResult.details.weeklyIv ?? null;
  const realizedVol = stageThreeResult.details.realizedVol30d ?? null;
  const ivEdge =
    weeklyIv !== null && realizedVol !== null && realizedVol > 0
      ? weeklyIv / realizedVol
      : 0;
  const termStructureRaw = stageThreeResult.details.termStructureScore;

  let vixRegime: "calm" | "elevated" | "panic" | null = null;
  if (vix !== null) {
    if (vix > 25) vixRegime = "panic";
    else if (vix >= 20) vixRegime = "elevated";
    else vixRegime = "calm";
  }

  const crushOk = crushGrade === "A" || crushGrade === "B";
  const hasOverhang = newsContext.hasActiveOverhang;
  const penalty = newsContext.gradePenalty ?? 0;

  // ---- Layer grades (display only — shown on each LayerCard) ----
  let industryGrade: Grade;
  if (crushOk && probabilityOfProfit >= 0.9 && opportunityGrade !== "F") {
    industryGrade = "A";
  } else if (probabilityOfProfit >= 0.83 && (crushOk || probabilityOfProfit >= 0.95)) {
    industryGrade = "B";
  } else if (probabilityOfProfit >= 0.75) {
    industryGrade = "C";
  } else {
    industryGrade = "F";
  }

  let regimeGrade: Grade;
  if (hasOverhang) regimeGrade = "F";
  else if (vix !== null && vix > 30) regimeGrade = "F";
  else if (newsContext.sentiment === "negative" || (vix !== null && vix > 25)) regimeGrade = "C";
  else if (vix !== null && vix >= 20) regimeGrade = "B";
  else regimeGrade = "A";

  const history: PersonalHistory = personalHistory ?? {
    tradeCount: 0,
    winRate: null,
    avgRoc: null,
    dataInsufficient: true,
    scope: "none",
    sectorIndustry: null,
  };
  // Legacy PersonalHistory objects (pre-sector-fallback) carry no
  // scope — they were always ticker-level.
  const historyScope = history.scope ?? (history.dataInsufficient ? "none" : "ticker");
  // Display grade for the Layer 2 card, at whatever evidence scope we
  // have. ROC threshold is on strike-based capital (0.3%/trade is a
  // real bar; the old 0.4 was on premium-capture and passed trivially).
  let personalGrade: Grade | "INSUFFICIENT" = "INSUFFICIENT";
  if (!history.dataInsufficient && history.winRate !== null) {
    const wr = history.winRate;
    const roc = history.avgRoc ?? 0;
    if (wr > 80 && roc > 0.3) personalGrade = "A";
    else if (wr >= 60) personalGrade = "B";
    else if (wr >= 50) personalGrade = "C";
    else personalGrade = "F";
  }

  // ---- Final grade: rule cascade ----
  // Opportunity F (thin premium/reward) already blocks the A rule via
  // its own `opportunityGrade !== "F"` clause. It did not block B or
  // C — a trade with genuinely good odds (POP) but essentially no
  // reward could reach "Grade B — size normally," which reads as an
  // endorsement despite the worst possible reward grade. `unrated`
  // marks that case explicitly: the trade isn't bad-odds (that's what
  // F/"Skip" means elsewhere) — it's simply not worth pricing.
  // finalGrade stays "F" internally so every other consumer (sorting,
  // badges, persistence, the client-side CustomStrikeAnalyzer replica)
  // keeps working unmodified; `unrated` lets the UI show "Unrated"
  // instead of the bare letter.
  let finalGrade: Grade;
  let matchedRule: "A" | "B" | "C" | "F";
  let unrated = false;
  if (
    crushOk &&
    probabilityOfProfit >= 0.9 &&
    opportunityGrade !== "F" &&
    !hasOverhang &&
    (vix === null || vix < 25)
  ) {
    finalGrade = "A";
    matchedRule = "A";
  } else if (
    probabilityOfProfit >= 0.83 &&
    (crushOk || probabilityOfProfit >= 0.95) &&
    !hasOverhang
  ) {
    if (opportunityGrade === "F") {
      finalGrade = "F";
      matchedRule = "F";
      unrated = true;
    } else {
      finalGrade = "B";
      matchedRule = "B";
    }
  } else if (probabilityOfProfit >= 0.75 && penalty > -15) {
    if (opportunityGrade === "F") {
      finalGrade = "F";
      matchedRule = "F";
      unrated = true;
    } else {
      finalGrade = "C";
      matchedRule = "C";
    }
  } else {
    finalGrade = "F";
    matchedRule = "F";
  }

  // Overrides: overhang always pins to F; VIX > 30 drops one level.
  let vixDropped = false;
  if (hasOverhang) {
    finalGrade = "F";
  } else if (vix !== null && vix > 30) {
    const dropped = dropGrade(finalGrade);
    if (dropped !== finalGrade) vixDropped = true;
    finalGrade = dropped;
  }

  // Personal history modifier — asymmetric by evidence scope:
  //   ticker (5+ trades on THIS symbol): boost or drop.
  //   sector (10+ trades across the industry): drop-only, stricter bar
  //     (<45%). Sector evidence is diluted — a false boost costs real
  //     capital, a false drop only costs a missed trade.
  // Graduated evidence ladder — small samples are shown but their power
  // to move the grade shrinks with sample size (sampleWeight 1.0 / 0.5
  // / 0.25). Sector evidence corroborates or, with zero ticker
  // campaigns, stands alone (drop-only).
  //   w=1.0 (5+):  boost (wr>80 & roc>0.3) or drop (dropWr<50)
  //   w=0.5 (2-4): drop at <50; boost only if the ticker bar is met AND
  //                the sector corroborates (win ≥60 over 10+ campaigns)
  //   w=0.25 (1):  no boost; drop only if the campaign lost AND the
  //                sector corroborates (sector dropWin <50)
  //   w=0 (none):  sector-only drop at <45
  let personalModifier: "boost" | "drop" | null = null;
  const sampleW = history.sampleWeight ?? (historyScope === "ticker" ? 1.0 : 0);
  if (!history.dataInsufficient && history.winRate !== null && !hasOverhang) {
    const wr = history.winRate; // boost-side weighted (rolled at 0.5)
    const dropWr = history.dropWinRate ?? wr; // rolled at full weight
    const roc = history.avgRoc ?? 0;
    const sec = history.sector ?? null;
    if (historyScope === "ticker") {
      if (sampleW >= 1.0) {
        // unrated trades never boost — a good win rate on past trades
        // can't manufacture reward that isn't there at THIS strike.
        if (!unrated && wr > 80 && roc > 0.3) personalModifier = "boost";
        else if (dropWr < 50) personalModifier = "drop";
      } else if (sampleW >= 0.5) {
        if (
          !unrated &&
          wr > 80 &&
          roc > 0.3 &&
          sec !== null &&
          (sec.winRate ?? 0) >= 60 &&
          sec.campaigns >= 10
        ) {
          personalModifier = "boost";
        } else if (dropWr < 50) {
          personalModifier = "drop";
        }
      } else if (sampleW >= 0.25) {
        if (dropWr < 50 && sec !== null && (sec.dropWinRate ?? 100) < 50) {
          personalModifier = "drop";
        }
      }
    } else if (historyScope === "sector" && dropWr < 45) {
      personalModifier = "drop";
    }
    if (personalModifier === "boost") finalGrade = boostGrade(finalGrade);
    else if (personalModifier === "drop") finalGrade = dropGrade(finalGrade);
  }

  // Derived illustrative scores (for sort order + display compatibility).
  const industryScore = gradeToL1Score(industryGrade);
  const regimeScore = gradeToL3Score(regimeGrade);
  const personalScore =
    personalGrade === "INSUFFICIENT" ? null : gradeToL2Score(personalGrade);
  const finalScore = gradeToFinalScore(finalGrade);

  let recommendation = "Skip";
  if (unrated) recommendation = "Unrated - below premium floor";
  else if (finalGrade === "A") recommendation = "Strong - Take the trade";
  else if (finalGrade === "B") recommendation = "Marginal - Size smaller";
  else if (finalGrade === "C") recommendation = "Marginal - Size small";

  // Build the explanation sections. STRENGTH/CAUTION/NEWS/HISTORY still
  // describe the raw factors (that's what the user wants to see). BOTTOM
  // LINE names the rule that matched and any overrides/modifiers that
  // fired.
  const popPct = (probabilityOfProfit * 100).toFixed(0);
  const ivEdgeBand =
    ivEdge >= 1.3 && ivEdge < 1.6
      ? "ideal range — fat premium, normal event risk"
      : ivEdge >= 1.6 && ivEdge < 1.9
        ? "elevated premium, slightly higher event risk"
        : ivEdge >= 1.2 && ivEdge < 1.3
          ? "modest premium"
          : ivEdge >= 1.9
            ? "very elevated premium, verify strike safety"
            : ivEdge > 0
              ? "thin premium, limited crush opportunity"
              : "n/a";

  const strengths: string[] = [];
  strengths.push(
    `${popPct}% probability of profit at $${strike.toFixed(2)} strike (2x EM).`,
  );
  if (crushOk) {
    strengths.push(
      `Crush ${crushGrade} — historical moves stay well inside the implied move; strong IV crush expected.`,
    );
  }
  if (ivEdge >= 1.3 && ivEdge < 1.9) {
    strengths.push(`IV edge ${ivEdge.toFixed(2)} — ${ivEdgeBand}.`);
  }

  const cautions: string[] = [];
  if (opportunityGrade === "C" || opportunityGrade === "F") {
    cautions.push(
      `Opportunity ${opportunityGrade} — premium at $${premium.toFixed(2)} is thin for the capital required.`,
    );
  }
  if (ivEdge >= 1.9) {
    cautions.push(
      `IV edge ${ivEdge.toFixed(2)} — very elevated premium, but verify strike safety against the larger implied move.`,
    );
  }
  if (probabilityOfProfit < 0.85) {
    cautions.push(
      `POP ${popPct}% is below the 85% comfort threshold — limited cushion if the stock gaps toward strike.`,
    );
  }
  if (crushGrade === "F" && !stageThreeResult.insufficientData) {
    // Branches on which sub-score actually drove the grade below
    // threshold, and states the numeric ratio, instead of asserting a
    // fixed "moves exceeded expectations" narrative regardless of
    // mechanism — historicalMoveScore rewards LOW ratios, so an F can
    // just as easily come from weak consistency/term-structure/ivEdge/
    // surprise scores while the move ratio itself looks fine.
    const d = stageThreeResult.details;
    const componentFractions: Array<{ name: string; frac: number }> = [
      d.scoreComponentsComputed.historicalMove
        ? [{ name: "historical move ratio", frac: d.historicalMoveScore / 8 }]
        : [],
      d.scoreComponentsComputed.consistency
        ? [{ name: "move consistency", frac: d.consistencyScore / 4 }]
        : [],
      d.scoreComponentsComputed.termStructure
        ? [{ name: "IV term structure", frac: d.termStructureScore / 5 }]
        : [],
      d.scoreComponentsComputed.ivEdge ? [{ name: "IV edge", frac: d.ivEdgeScore / 4 }] : [],
      d.scoreComponentsComputed.surprise
        ? [{ name: "earnings-surprise history", frac: d.surpriseScore / 4 }]
        : [],
    ].flat();
    const weakest =
      componentFractions.length > 0
        ? componentFractions.reduce((a, b) => (b.frac < a.frac ? b : a))
        : null;
    const ratioText =
      d.historicalMoveRatio !== null
        ? `${d.historicalMoveRatio.toFixed(2)}x realized/implied over ${d.historicalMoveRatioN} verified quarter(s)`
        : "no per-quarter realized/implied ratio available";
    cautions.push(
      `Crush F — composite score ${stageThreeResult.score}/${stageThreeResult.maxScore} below threshold` +
        (weakest ? `, driven mainly by ${weakest.name} (${(weakest.frac * 100).toFixed(0)}% of its max)` : "") +
        `. Historical move ratio: ${ratioText}.`,
    );
  }
  if (cautions.length === 0) {
    cautions.push("None flagged at this strike.");
  }

  const newsLines: string[] = [];
  const sentimentWord =
    newsContext.sentiment === "positive"
      ? "Positive"
      : newsContext.sentiment === "negative"
        ? "Negative"
        : "Neutral";
  newsLines.push(`${sentimentWord} — ${newsContext.summary}`);
  if (hasOverhang) {
    newsLines.push(
      `⚠ Active overhang: ${newsContext.overhangDescription ?? "see news"}. Hard override → grade F.`,
    );
  } else if (newsContext.sentiment === "negative") {
    newsLines.push(`Negative tone (penalty ${penalty}).`);
  } else {
    newsLines.push("No active risks detected.");
  }
  if (vixRegime !== null && vixRegime !== "calm") {
    newsLines.push(`VIX ${vix?.toFixed(1)} (${vixRegime}).`);
  }

  const historyLines: string[] = [];
  if (!history.dataInsufficient && history.winRate !== null) {
    const wr = history.winRate;
    const roc = history.avgRoc ?? 0;
    if (historyScope === "sector") {
      const mod =
        personalModifier === "drop"
          ? " → drops grade one level (sector win rate <45%)"
          : " → no modifier (sector evidence can only drop, at <45% win)";
      const t = history.tickerLevel;
      const tickerBit = t
        ? `${t.clean} clean campaign${t.clean === 1 ? "" : "s"} on this ticker (need 5+)${t.recovery > 0 ? `, ${t.recovery} recovery play${t.recovery === 1 ? "" : "s"} excluded from CSP grading` : ""}. `
        : "";
      historyLines.push(
        `${tickerBit}Sector evidence — ${history.sectorIndustry ?? "industry"}: ${history.tradeCount} campaigns, ${wr.toFixed(0)}% win rate, ${roc.toFixed(2)}% avg ROC${mod}.`,
      );
    } else {
      const mod =
        personalModifier === "boost"
          ? " → boosts grade one level"
          : personalModifier === "drop"
            ? " → drops grade one level"
            : " → no modifier";
      const caveat =
        sampleW >= 1.0
          ? ""
          : sampleW >= 0.5
            ? " (small sample — half weight; boost needs sector corroboration)"
            : " (very limited data — quarter weight; can only corroborate a drop)";
      const breakdown =
        (history.rolledCount ?? 0) > 0 || (history.recoveryCount ?? 0) > 0
          ? ` [${history.cleanCount ?? history.tradeCount} clean${(history.rolledCount ?? 0) > 0 ? ` · ${history.rolledCount} rolled (half-weight)` : ""}${(history.recoveryCount ?? 0) > 0 ? ` · ${history.recoveryCount} recovery play${(history.recoveryCount ?? 0) === 1 ? "" : "s"} excluded` : ""}]`
          : "";
      historyLines.push(
        `${history.tradeCount} campaign${history.tradeCount === 1 ? "" : "s"} on this ticker: ${wr.toFixed(0)}% win rate, ${roc.toFixed(2)}% avg ROC${breakdown}${caveat}${mod}.`,
      );
      if (history.sector) {
        historyLines.push(
          `Sector (${history.sector.industry}): ${history.sector.campaigns} campaigns, ${history.sector.winRate !== null ? history.sector.winRate.toFixed(0) : "—"}% win — drop-only evidence.`,
        );
      }
    }
  } else {
    const excluded =
      (history.recoveryCount ?? 0) > 0
        ? ` ${history.recoveryCount} recovery play${(history.recoveryCount ?? 0) === 1 ? "" : "s"} on this ticker excluded from CSP grading.`
        : "";
    historyLines.push(
      `Insufficient history — ${history.tradeCount} countable campaign${history.tradeCount === 1 ? "" : "s"} on this ticker (need 5+; sector fallback needs 10+ industry campaigns).${excluded} No modifier applied.`,
    );
  }

  // Explain which rule matched, then note any override/modifier that
  // changed the grade after the cascade.
  const ruleExplain: Record<"A" | "B" | "C" | "F", string> = {
    A: `Rule A matched: crush ${crushGrade}, POP ${popPct}% ≥ 90%, opportunity ${opportunityGrade} (not F), no overhang, VIX ${vix !== null ? vix.toFixed(1) : "n/a"} < 25.`,
    B: `Rule B matched: POP ${popPct}% ≥ 83%${crushOk ? ` and crush ${crushGrade}` : " and POP ≥ 95% (crush F allowed)"}, no overhang.`,
    C: `Rule C matched: POP ${popPct}% ≥ 75%, penalty ${penalty} > −15.`,
    F: `No rule matched${probabilityOfProfit < 0.75 ? ` (POP ${popPct}% < 75%)` : penalty <= -15 ? ` (penalty ${penalty} ≤ −15)` : ""}.`,
  };
  const overrideBits: string[] = [];
  if (hasOverhang && matchedRule !== "F") {
    overrideBits.push(`Active overhang override → final F (was ${matchedRule}).`);
  }
  if (vixDropped) {
    overrideBits.push(`VIX ${vix?.toFixed(1)} > 30 override → dropped one level.`);
  }
  if (personalModifier === "boost") {
    overrideBits.push("Personal history boost (ticker win rate >80%, avg ROC >0.3%) → +1 level.");
  } else if (personalModifier === "drop") {
    overrideBits.push(
      historyScope === "sector"
        ? `Sector history drop (${history.sectorIndustry ?? "industry"} win rate <45%) → −1 level.`
        : "Personal history drop (ticker win rate <50%) → −1 level.",
    );
  }

  let bottomLine: string;
  if (finalGrade === "A") {
    bottomLine = `Grade A. Take the trade.`;
  } else if (finalGrade === "B") {
    bottomLine = `Grade B. Size normally${cautions[0] && cautions[0] !== "None flagged at this strike." ? ", with the caution above in mind" : ""}.`;
  } else if (finalGrade === "C") {
    bottomLine = `Grade C. Size smaller or pass if there's a better setup tonight.`;
  } else {
    bottomLine = `Grade F. Skip${hasOverhang ? " — active overhang." : probabilityOfProfit < 0.75 ? " — POP too low." : penalty <= -15 ? " — news penalty too severe." : "."}`;
  }
  const bottomLineFull = [ruleExplain[matchedRule], ...overrideBits, bottomLine].join(" ");

  const recommendationReason = [
    `STRENGTH: ${strengths.join(" ")}`,
    `CAUTION: ${cautions.join(" ")}`,
    `NEWS: ${newsLines.join(" ")}`,
    `HISTORY: ${historyLines.join(" ")}`,
    `BOTTOM LINE: ${bottomLineFull}`,
  ].join("\n\n");

  // PASS_3: setupGrade answers "is this name's earnings setup favorable"
  // — same cascade as finalGrade, minus the opportunity/premium gate.
  // POP here is the 2xEM-reference POP (probabilityOfProfit, unchanged
  // above) — stable and comparable across candidates. The 2xEM strike
  // is the only strike this app ever recommends; see referenceStrikeCheck.
  const setupGrade = computeSetupGrade(
    crushGrade,
    probabilityOfProfit,
    hasOverhang,
    vix,
    penalty,
    history,
    historyScope,
  );

  // Diagnostic only — is the 2xEM strike (== `strike` above) itself
  // liquid, and at what price. finalGrade/unrated/opportunityGrade/
  // expectedValue above are entirely unaffected by this; it never
  // recommends a different strike (see evaluateReferenceStrike's
  // comment for why the inward walk this used to do was removed).
  const referenceStrikeCheck = evaluateReferenceStrike(
    stageFourResult.availableStrikes,
    currentPrice,
    strike,
  );

  return {
    industryGrade,
    industryScore,
    industryFactors: {
      probabilityOfProfit,
      ivRank: null,
      ivEdge,
      termStructure: termStructureRaw,
      crushGrade,
      opportunityGrade,
      expectedValue,
      breakevenPrice,
      lossMultiplierSource: stageThreeResult.details.lossMultiplierSource ?? "pool",
      lossMultiplier,
    },
    personalGrade,
    personalScore,
    personalFactors: {
      tickerWinRate: history.winRate,
      tickerTradeCount: history.tradeCount,
      tickerAvgRoc: history.avgRoc,
      tickerCrushAccuracy: null,
      dataInsufficient: history.dataInsufficient,
      scope: historyScope,
      sectorIndustry: history.sectorIndustry ?? null,
      cleanCount: history.cleanCount,
      rolledCount: history.rolledCount,
      recoveryCount: history.recoveryCount,
      tickerLevel: history.tickerLevel,
      sampleWeight: history.sampleWeight,
      sector: history.sector ?? null,
    },
    regimeGrade,
    regimeScore,
    regimeFactors: {
      newsSentiment: newsContext.sentiment,
      hasActiveOverhang: hasOverhang,
      overhangDescription: newsContext.overhangDescription,
      newsSummary: newsContext.summary,
      gradePenalty: penalty,
      vix,
      vixRegime,
    },
    finalGrade,
    unrated,
    finalScore,
    recommendation,
    recommendationReason,
    expirySource,
    setupGrade,
    referenceStrikeCheck,
    matchedRule,
    ruleText: ruleExplain[matchedRule],
    overrideNotes: overrideBits,
  };
}

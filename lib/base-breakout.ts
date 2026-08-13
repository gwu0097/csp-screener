// Base Breakout — sixth setup tab, independent of RS Pullback (see
// SetupTab in lib/swing-screener.ts). RS Pullback screens for a pause
// after a run; this screens for a breakout out of a tight consolidation.
// The two premises are opposite risk models on purpose: RS Pullback's
// stop is 1.5xATR14 below entry with no relation to any drawn level;
// this tab's stop sits below a base the market actually drew (support
// that just flipped from resistance), which only exists once a base has
// been detected. Same design conventions as RS Pullback throughout
// (compute-all-gates-then-classify, near-miss watch tier, three-list
// partition, cache-only pregate before any live fetch) — see that file's
// section comments for the shared rationale; only the divergences are
// re-explained here.
//
// Simplification vs. RS Pullback, stated explicitly: RS Pullback has a
// third pipeline stage (applyRsPullbackPrefilter) that narrows the
// pregate set using only already-cached bars/sector before paying for
// any live fetch. This tab skips that stage — pregate survivors go
// straight to full enrichment (computeBaseBreakoutCandidates). Same
// live-fetch cost as RS Pullback's OWN enrichment stage (bars + sector +
// earnings, no Finnhub insider/Schwab options either way); the skipped
// stage was a pure cost optimization on top of that, not a correctness
// requirement, and cutting it materially shrinks this file for an
// initial, explicitly-provisional gate set.
import {
  type Pass1Quote,
  type SwingCandidate,
  type BaseBreakoutList,
  type BaseBreakoutGateKey,
  getOrFetchSector,
  daysFromTodayUtc,
  mapWithConcurrency,
} from "./swing-screener";
import { getOrFetchDailyBars, type DailyBar } from "./daily-bars-cache";
import { getFinnhubNextEarningsDateOrThrow } from "./earnings";
import { computeATR, computeADRPercent, computeAvgVolume, rollingATRSeries } from "./indicators";

// ---------- Thresholds (all provisional, all editable) ----------

export type BaseBreakoutThresholds = {
  baseMinSessions: number; // gate 1b — discovered base length must be >= this
  baseRangeMaxPct: number; // gate 1a — (baseHigh-baseLow)/midpoint <= this, as a percent (25 = 25%)
  atrContractionPercentile: number; // gate 1c — ATR10 now must be <= this percentile of its trailing series (50 = median)
  atrTrailingSessions: number; // window for the ATR10 rolling series
  rvolMin: number; // gate 3b
  rvolLookbackSessions: number; // trailing-average-volume window for RVOL's denominator
  freshnessMaxSessions: number; // gate 4a
  freshnessMaxAtrMultiple: number; // gate 4b — price <= baseHigh + this * ATR10
  minAdrPct: number; // carried-over-unchanged, same default RS Pullback uses
};

export const DEFAULT_BASE_BREAKOUT_THRESHOLDS: BaseBreakoutThresholds = {
  baseMinSessions: 20,
  baseRangeMaxPct: 25,
  atrContractionPercentile: 50,
  atrTrailingSessions: 60,
  rvolMin: 1.5,
  rvolLookbackSessions: 20,
  freshnessMaxSessions: 5,
  freshnessMaxAtrMultiple: 1.5,
  minAdrPct: 3.0,
};

// Same liquidity floor RS Pullback applies — independent literals, not
// shared code, matching that tab's own precedent (RS_PULLBACK_MIN_PRICE/
// RS_PULLBACK_MIN_MARKET_CAP in lib/swing-screener.ts).
const BASE_BREAKOUT_MIN_PRICE = 10;
const BASE_BREAKOUT_MIN_MARKET_CAP = 500_000_000;
const BASE_BREAKOUT_DISQUALIFIED_SECTORS = new Set(["Real Estate", "Utilities"]);

// Base search bounds. Floor of 10 sessions: a compression shorter than
// that is a pause, not a base (see baseMinSessions=20 gate — this floor
// just bounds how far below 20 the search looks, so "no compression
// found at all" and "compression found but too short" are distinguishable
// outcomes rather than the search simply never trying anything under 20).
// Ceiling of 80 sessions: daily_bars_cache holds ~100-103 trading days
// (DAILY_BARS_WINDOW_DAYS=150 calendar days) — 80 leaves margin for the
// 60-session trailing ATR series (needs its own ~11 bars of history
// behind it) to still fit inside the same fetch.
const BASE_SEARCH_FLOOR_SESSIONS = 10;
const BASE_SEARCH_CEILING_SESSIONS = 80;

// How far back to search for the most recent valid first-cross trigger
// when today itself isn't one — generous margin (3x the freshness
// ceiling) so a real breakout a few sessions ago still correctly lands
// in "ready" (fresh) or "leading_extended" (stale) rather than being
// missed entirely. A trigger older than this is treated as not found —
// the symbol is then judged purely on whether it's still sitting inside
// a valid base right now (in_zone_lagging) or not (excluded/near-miss).
const TRIGGER_SEARCH_LOOKBACK_SESSIONS = 15;

// Minimum bars needed to evaluate anything: the 60-session trailing ATR
// series needs ~71 bars for its oldest point, plus the trigger-search
// lookback needs bars.length to safely index back that far too. Distinct
// from RS Pullback's BACKFILL_MIN_BARS (70) — not shared, since the two
// tabs' minimums come from unrelated math and RS Pullback's constant is
// that tab's own pre-flight budget, not a general floor.
const MIN_BARS_NEEDED = 75;

// ---------- Base detection ----------

export type BaseDetection = {
  // Longest window (ending at `endIndex`, exclusive) whose range% is <=
  // baseRangeMaxPct, or — if none qualifies — the window at
  // baseMinSessions itself, so callers always have real numbers to report
  // a gap against. `valid` distinguishes the two cases.
  sessions: number;
  high: number;
  low: number;
  rangePct: number;
  valid: boolean; // sessions >= baseMinSessions AND rangePct <= baseRangeMaxPct
  atrNow: number | null;
  atrMedian: number | null;
  atrContractionValid: boolean; // atrNow <= atrMedian (only meaningful when both non-null)
};

function rangePctOf(bars: DailyBar[]): { high: number; low: number; rangePct: number } {
  const high = Math.max(...bars.map((b) => b.high));
  const low = Math.min(...bars.map((b) => b.low));
  const midpoint = (high + low) / 2;
  const rangePct = midpoint > 0 ? ((high - low) / midpoint) * 100 : Infinity;
  return { high, low, rangePct };
}

// bars: full history, oldest-first. endIndex: exclusive — the base
// window is bars[endIndex-L, endIndex), i.e. "as of the close of the day
// before endIndex." Returns null only when there aren't enough bars
// before endIndex to even try the search floor.
function detectBase(
  bars: DailyBar[],
  thresholds: BaseBreakoutThresholds,
  endIndex: number,
): BaseDetection | null {
  const maxL = Math.min(BASE_SEARCH_CEILING_SESSIONS, endIndex);
  if (maxL < BASE_SEARCH_FLOOR_SESSIONS) return null;

  // Longest L (searching from the ceiling down) whose range% qualifies.
  let best: { sessions: number; high: number; low: number; rangePct: number } | null = null;
  for (let L = maxL; L >= BASE_SEARCH_FLOOR_SESSIONS; L -= 1) {
    const window = bars.slice(endIndex - L, endIndex);
    const { high, low, rangePct } = rangePctOf(window);
    if (rangePct <= thresholds.baseRangeMaxPct) {
      best = { sessions: L, high, low, rangePct };
      break;
    }
  }
  // Fallback reference window when nothing in [floor, ceiling] compresses
  // enough at all — use the floor window itself so base_range's gap
  // (rangePct - threshold) is a real, reportable number.
  const reference =
    best ?? (() => {
      const L = Math.min(BASE_SEARCH_FLOOR_SESSIONS, maxL);
      const window = bars.slice(endIndex - L, endIndex);
      const { high, low, rangePct } = rangePctOf(window);
      return { sessions: L, high, low, rangePct };
    })();

  const atrSeriesBars = bars.slice(0, endIndex);
  const atrNow = computeATR(atrSeriesBars, 10);
  const series = rollingATRSeries(atrSeriesBars, 10, thresholds.atrTrailingSessions);
  const atrMedian =
    series && series.length > 0
      ? [...series].sort((a, b) => a - b)[
          Math.min(
            series.length - 1,
            Math.floor((thresholds.atrContractionPercentile / 100) * series.length),
          )
        ]
      : null;

  return {
    sessions: reference.sessions,
    high: reference.high,
    low: reference.low,
    rangePct: reference.rangePct,
    valid: reference.sessions >= thresholds.baseMinSessions && reference.rangePct <= thresholds.baseRangeMaxPct,
    atrNow,
    atrMedian,
    atrContractionValid: atrNow !== null && atrMedian !== null ? atrNow <= atrMedian : false,
  };
}

// ---------- First-cross trigger ----------

export type TriggerResult = {
  index: number; // index into bars[] of the trigger day
  sessionsAgo: number; // 0 = today
  rvol: number;
  base: BaseDetection;
};

// Scans backward from `bars.length - 1` (today) for the most recent day
// t satisfying: close(t) > base.high (base detected ending at t),
// close(t-1) <= base.high (first cross, not a continuation — see the
// module comment for why this matters for freshness), and RVOL(t) >=
// rvolMin. Returns the most recent (smallest sessionsAgo) match, or null.
function findFirstCrossTrigger(
  bars: DailyBar[],
  thresholds: BaseBreakoutThresholds,
): TriggerResult | null {
  const lastIndex = bars.length - 1;
  const earliest = Math.max(MIN_BARS_NEEDED, lastIndex - TRIGGER_SEARCH_LOOKBACK_SESSIONS);
  for (let t = lastIndex; t >= earliest; t -= 1) {
    const base = detectBase(bars, thresholds, t);
    if (!base || !base.valid) continue;
    const closeT = bars[t].close;
    const closePrev = t > 0 ? bars[t - 1].close : null;
    if (closePrev === null || !(closeT > base.high) || !(closePrev <= base.high)) continue;
    const avgVol = computeAvgVolume(bars.slice(0, t), thresholds.rvolLookbackSessions);
    if (avgVol === null || avgVol <= 0) continue;
    const rvol = bars[t].volume / avgVol;
    if (rvol < thresholds.rvolMin) continue;
    return { index: t, sessionsAgo: lastIndex - t, rvol, base };
  }
  return null;
}

// ---------- Gate evaluation (compute-all-then-classify) ----------

export type BaseBreakoutGateStatus = {
  gate: BaseBreakoutGateKey;
  pass: boolean;
  value: number;
  threshold: number;
  gap: number;
};

export type BaseBreakoutEvaluation = {
  base: BaseDetection;
  adr20Pct: number;
  rvol: number | null; // null when there wasn't a candidate trigger day to measure it against
  trigger: TriggerResult | null;
  // Always exactly 5 entries (base_range, base_length, atr_contraction,
  // rvol, adr_floor) — computed unconditionally against "today as the
  // candidate trigger day," regardless of whether a real trigger (fresh
  // or stale) was actually found. This is what near-miss/attrition
  // reporting reads — same convention as RsPullbackEvaluation.gates.
  gates: BaseBreakoutGateStatus[];
};

// bars: oldest-first daily OHLCV, already covering >= MIN_BARS_NEEDED.
// currentPrice: today's live price (may differ slightly from bars' last
// close if bars are a stale cache read — same convention RS Pullback's
// evaluateRsPullback uses, currentPrice is authoritative for entry).
export function evaluateBaseBreakout(
  bars: DailyBar[],
  thresholds: BaseBreakoutThresholds,
): BaseBreakoutEvaluation | null {
  if (bars.length < MIN_BARS_NEEDED) return null;
  const lastIndex = bars.length - 1;

  // Reference base "as of today" (window ending at today, i.e. today is
  // the candidate trigger day) — used for the 5 always-computed gates,
  // independent of whether a real (possibly stale) trigger is found below.
  const todayBase = detectBase(bars, thresholds, lastIndex);
  if (!todayBase) return null;

  const adr20Pct = computeADRPercent(bars, 20);
  if (adr20Pct === null) return null;

  const avgVolBeforeToday = computeAvgVolume(bars.slice(0, lastIndex), thresholds.rvolLookbackSessions);
  const rvol =
    avgVolBeforeToday !== null && avgVolBeforeToday > 0
      ? bars[lastIndex].volume / avgVolBeforeToday
      : null;

  const gates: BaseBreakoutGateStatus[] = [
    {
      gate: "base_range",
      pass: todayBase.rangePct <= thresholds.baseRangeMaxPct,
      value: todayBase.rangePct,
      threshold: thresholds.baseRangeMaxPct,
      gap: Math.max(0, todayBase.rangePct - thresholds.baseRangeMaxPct),
    },
    {
      gate: "base_length",
      pass: todayBase.sessions >= thresholds.baseMinSessions,
      value: todayBase.sessions,
      threshold: thresholds.baseMinSessions,
      gap: Math.max(0, thresholds.baseMinSessions - todayBase.sessions),
    },
    {
      gate: "atr_contraction",
      pass: todayBase.atrContractionValid,
      value: todayBase.atrNow ?? 0,
      threshold: todayBase.atrMedian ?? 0,
      gap: todayBase.atrNow !== null && todayBase.atrMedian !== null ? Math.max(0, todayBase.atrNow - todayBase.atrMedian) : 0,
    },
    {
      gate: "rvol",
      pass: rvol !== null && rvol >= thresholds.rvolMin,
      value: rvol ?? 0,
      threshold: thresholds.rvolMin,
      gap: rvol !== null ? Math.max(0, thresholds.rvolMin - rvol) : thresholds.rvolMin,
    },
    {
      gate: "adr_floor",
      pass: adr20Pct >= thresholds.minAdrPct,
      value: adr20Pct,
      threshold: thresholds.minAdrPct,
      gap: Math.max(0, thresholds.minAdrPct - adr20Pct),
    },
  ];

  const trigger = findFirstCrossTrigger(bars, thresholds);

  return { base: todayBase, adr20Pct, rvol, trigger, gates };
}

// ---------- Trade levels ----------

export type BaseBreakoutLevels = {
  entryPrice: number;
  targetPrice: number;
  stopPrice: number;
  reward: number;
  risk: number;
  rr: number;
  stopSource: "base_high" | "base_low" | "base_low_clamped";
};

// Target reuses RS Pullback's exact derivation (nearer of analyst
// consensus / 52w-high / 3xATR14 projection) unchanged — the spec only
// redefines the stop, not the target. Stop: base-high first (the level
// that just flipped from resistance to support); if that stop's raw risk
// sits inside the 3% floor (i.e. the clamp would have to fabricate a
// level not tied to anything real), fall back to base-low instead — a
// real, wider structural level. Same 3%-15% risk clamp bounds as RS
// Pullback's computeStructuralLevels, independent constants.
function computeBaseBreakoutLevels(
  q: Pass1Quote,
  atr14: number | null,
  base: BaseDetection,
): BaseBreakoutLevels | null {
  const entryPrice = q.currentPrice;
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) return null;

  let stopCandidate = base.high;
  let stopSource: "base_high" | "base_low" | "base_low_clamped" = "base_high";
  const rawRiskPct = (entryPrice - stopCandidate) / entryPrice;
  if (rawRiskPct < 0.03) {
    stopCandidate = base.low;
    stopSource = "base_low";
  }
  let stopPrice = Math.min(stopCandidate, entryPrice * 0.97); // floor: at least 3% risk
  stopPrice = Math.max(stopPrice, entryPrice * 0.85); // ceiling: at most 15% risk
  if (stopSource === "base_low" && stopPrice !== stopCandidate) {
    stopSource = "base_low_clamped";
  }

  const atrProjection = atr14 !== null && atr14 > 0 ? entryPrice + 3 * atr14 : null;
  const structuralResistance = q.week52High > entryPrice ? q.week52High : atrProjection;
  const targetCandidates = [q.analystTarget, structuralResistance].filter(
    (v): v is number => v !== null && Number.isFinite(v) && v > entryPrice,
  );
  const targetPrice =
    targetCandidates.length > 0 ? Math.min(...targetCandidates) : (atrProjection ?? entryPrice * 1.1);

  const reward = targetPrice - entryPrice;
  const risk = entryPrice - stopPrice;
  if (!Number.isFinite(reward) || !Number.isFinite(risk) || risk <= 0) return null;
  return { entryPrice, targetPrice, stopPrice, reward, risk, rr: reward / risk, stopSource };
}

// ---------- Pregate ----------

// Cheap pre-gate using only the already-fetched Pass1Quote — narrows the
// universe before any per-symbol bars/sector/earnings fetch. Mirrors
// RS Pullback's pregateRsPullbackSymbols exactly (same liquidity floor
// values, same above-200d hard exclusion tracked as a diagnostic, not a
// near-miss-eligible gate — a symbol failing it is dropped here, before
// bars are ever fetched, for the same fetch-volume reason documented on
// pregateRsPullbackSymbols).
export function pregateBaseBreakoutSymbols(quotes: Map<string, Pass1Quote>): {
  symbols: string[];
  excludedByAbove200d: number;
} {
  const out: string[] = [];
  let excludedByAbove200d = 0;
  for (const q of Array.from(quotes.values())) {
    if (q.currentPrice < BASE_BREAKOUT_MIN_PRICE) continue;
    if (q.marketCap < BASE_BREAKOUT_MIN_MARKET_CAP) continue;
    if (!(q.ma200 > 0)) continue;
    if (q.currentPrice <= q.ma200) {
      excludedByAbove200d += 1;
      continue;
    }
    out.push(q.symbol);
  }
  return { symbols: out, excludedByAbove200d };
}

// ---------- Full enrichment ----------

export type BaseBreakoutComputeResult = {
  candidates: SwingCandidate[];
  // Attrition counters, one per clause, in evaluation order — see the
  // module's validation report for how these are used.
  excludedBySector: number;
  excludedByInsufficientBars: number;
  excludedByEvalFailure: number; // evaluateBaseBreakout returned null for another reason (bad ADR data etc.)
  excludedByEarningsWindow: number;
  excludedByBaseRange: number;
  excludedByBaseLength: number;
  excludedByAtrContraction: number;
  excludedByNoValidTrigger: number; // valid base, but no first-cross found (in_zone_lagging territory, or too many other gate failures)
  degradedCount: number;
  deadlineSkipped: string[];
};

function buildBaseBreakoutCandidate(params: {
  q: Pass1Quote;
  atr14: number | null;
  ev: BaseBreakoutEvaluation;
  list: BaseBreakoutList;
  nearMiss: BaseBreakoutGateStatus | null;
  levels: BaseBreakoutLevels;
  sector: string | null;
  nextEarningsDate: string | null;
  daysToEarnings: number | null;
  dataQualityDegraded: boolean;
  dataQualityIssues: string[];
}): SwingCandidate {
  const { q, atr14, ev, list, nearMiss, levels, sector, nextEarningsDate, daysToEarnings, dataQualityDegraded, dataQualityIssues } = params;
  const pctFromHigh = (q.currentPrice - q.week52High) / q.week52High;
  const pctFrom52wLow = (q.currentPrice - q.week52Low) / q.week52Low;
  const vsMA200 = (q.currentPrice - q.ma200) / q.ma200;
  const volumeRatio = q.avgVolume10d > 0 ? q.todayVolume / q.avgVolume10d : 0;
  const extensionAtrMultiple =
    ev.base.atrNow !== null && ev.base.atrNow > 0 ? (q.currentPrice - ev.base.high) / ev.base.atrNow : null;

  return {
    symbol: q.symbol,
    companyName: q.companyName,
    currentPrice: q.currentPrice,
    priceChange1d: q.priceChange1d,
    ma50: q.ma50,
    ma200: q.ma200,
    week52Low: q.week52Low,
    week52High: q.week52High,
    analystTarget: q.analystTarget,
    numAnalysts: q.numAnalysts,
    avgVolume10d: q.avgVolume10d,
    todayVolume: q.todayVolume,
    marketCap: q.marketCap,
    shortPercentFloat: q.shortPercentFloat,
    revenueGrowth: q.revenueGrowth,
    pctFromHigh,
    pctFrom52wLow,
    vsMA50: (q.currentPrice - q.ma50) / q.ma50,
    vsMA200,
    volumeRatio,
    rr: levels.rr,
    entryPrice: levels.entryPrice,
    targetPrice: levels.targetPrice,
    stopPrice: levels.stopPrice,
    nextEarningsDate,
    daysToEarnings,
    insiderTransactions: [],
    insiderSignal: "neutral",
    executiveBuys: [],
    insiderBuyDollars: 0,
    insiderBuyerCount: 0,
    insiderLastBuyDaysAgo: null,
    unusualOptionsActivity: false,
    callVolumeOiRatio: null,
    optionsSignal: "neutral",
    topOptionsStrike: null,
    topOptionsExpiry: null,
    catalystFound: false,
    catalystType: "none",
    catalystDate: null,
    catalystDescription: null,
    catalystConfidence: "none",
    catalystInsiderAngle: null,
    catalystRawResponse: null,
    tier1Signals: [],
    tier2Signals: [],
    redFlags: [],
    signalCount: 0,
    setupScore: 0,
    setupTabs: ["base_breakout"],
    tabScores: {},
    tabScoreComponents: {},
    tabNarrative: {},
    tabStats: null,
    capitulationStats: null,
    pullbackStats: null,
    atr14,
    adr20Pct: ev.adr20Pct,
    sector,
    baseHigh: ev.base.high,
    baseLow: ev.base.low,
    baseSessions: ev.base.sessions,
    baseRangePct: ev.base.rangePct,
    atr10: ev.base.atrNow,
    atr10Median60: ev.base.atrMedian,
    rvol: ev.trigger?.rvol ?? ev.rvol,
    sessionsSinceTrigger: ev.trigger?.sessionsAgo ?? null,
    extensionAtrMultiple,
    stopSource: levels.stopSource,
    baseBreakoutList: list,
    bbNearMissGate: nearMiss?.gate ?? null,
    bbNearMissValue: nearMiss?.value ?? null,
    bbNearMissThreshold: nearMiss?.threshold ?? null,
    bbNearMissGap: nearMiss?.gap ?? null,
    dataQualityDegraded,
    dataQualityIssues,
  };
}

export type BaseBreakoutClassification = {
  list: BaseBreakoutList | null;
  nearMiss: BaseBreakoutGateStatus | null;
  baseRangeGate: BaseBreakoutGateStatus;
  baseLengthGate: BaseBreakoutGateStatus;
  atrGate: BaseBreakoutGateStatus;
  // True when the base itself is valid (range+length+ATR all pass) but no
  // first-cross trigger was found in the lookback — distinct from "base
  // invalid," used for its own attrition bucket.
  noValidTrigger: boolean;
};

// Pure classification over an already-computed evaluation — no fetches,
// no quote fields beyond currentPrice. Shared by the live enrichment path
// (computeBaseBreakoutCandidates) and the backtest (scripts/backtest-
// base-breakout.ts), so both can never quietly classify a candidate
// differently. See the module comment for the gate/list semantics.
export function classifyBaseBreakout(
  ev: BaseBreakoutEvaluation,
  currentPrice: number,
  thresholds: BaseBreakoutThresholds,
): BaseBreakoutClassification {
  const baseRangeGate = ev.gates.find((g) => g.gate === "base_range")!;
  const baseLengthGate = ev.gates.find((g) => g.gate === "base_length")!;
  const atrGate = ev.gates.find((g) => g.gate === "atr_contraction")!;

  // A valid base (range+length+ATR contraction, all three) is the
  // precondition for every list except "excluded" itself.
  const validBase = baseRangeGate.pass && baseLengthGate.pass && atrGate.pass;
  let list: BaseBreakoutList | null = null;
  let noValidTrigger = false;

  if (validBase && ev.trigger !== null) {
    const t = ev.trigger;
    const freshBySessions = t.sessionsAgo <= thresholds.freshnessMaxSessions;
    const extensionAtr =
      t.base.atrNow !== null && t.base.atrNow > 0 ? (currentPrice - t.base.high) / t.base.atrNow : Infinity;
    const freshByExtension = extensionAtr <= thresholds.freshnessMaxAtrMultiple;
    list = freshBySessions && freshByExtension ? "ready" : "leading_extended";
  } else if (validBase) {
    // Base valid, but no first-cross found in the lookback — still
    // consolidating (or the only "trigger" seen was a continuation, not a
    // fresh cross). Only a real watch-list entry if price hasn't already
    // run away from the base without a qualifying cross.
    noValidTrigger = true;
    if (currentPrice <= ev.base.high) list = "in_zone_lagging";
  }

  // Near-miss watch tier — carved from the discard pile only (list is
  // still null here), and only when EXACTLY one of the five evaluable
  // gates failed. Two-plus failures is fully excluded, same as RS
  // Pullback's precedent.
  let nearMiss: BaseBreakoutGateStatus | null = null;
  if (list === null) {
    const failed = ev.gates.filter((g) => !g.pass);
    if (failed.length === 1) nearMiss = failed[0];
  }

  return { list, nearMiss, baseRangeGate, baseLengthGate, atrGate, noValidTrigger };
}

export async function computeBaseBreakoutCandidates(
  symbols: string[],
  pass1Data: Map<string, Pass1Quote>,
  thresholds: BaseBreakoutThresholds = DEFAULT_BASE_BREAKOUT_THRESHOLDS,
  opts: { forceFresh?: boolean } = {},
): Promise<BaseBreakoutComputeResult> {
  const forceFresh = opts.forceFresh ?? false;
  const result: BaseBreakoutComputeResult = {
    candidates: [],
    excludedBySector: 0,
    excludedByInsufficientBars: 0,
    excludedByEvalFailure: 0,
    excludedByEarningsWindow: 0,
    excludedByBaseRange: 0,
    excludedByBaseLength: 0,
    excludedByAtrContraction: 0,
    excludedByNoValidTrigger: 0,
    degradedCount: 0,
    deadlineSkipped: [],
  };
  if (symbols.length === 0) return result;

  const started = Date.now();
  const DEADLINE_MS = 45_000;

  await mapWithConcurrency(symbols, 5, async (symbol) => {
    if (Date.now() - started > DEADLINE_MS) {
      result.deadlineSkipped.push(symbol);
      return null;
    }
    const q = pass1Data.get(symbol);
    if (!q) return null;

    let earningsFailed = false;
    const [bars, sectorResult, nextEarn] = await Promise.all([
      getOrFetchDailyBars(symbol, { forceFresh }).catch(() => [] as DailyBar[]),
      getOrFetchSector(symbol),
      getFinnhubNextEarningsDateOrThrow(symbol, { forceFresh }).catch(() => {
        earningsFailed = true;
        return null;
      }),
    ]);
    const sector = sectorResult.sector;
    const sectorFailed = sectorResult.failed;

    if (bars.length < MIN_BARS_NEEDED) {
      result.excludedByInsufficientBars += 1;
      return null;
    }

    const daysToEarn = nextEarn?.date ? daysFromTodayUtc(nextEarn.date) : null;
    if (daysToEarn !== null && daysToEarn < 7) {
      result.excludedByEarningsWindow += 1;
      return null;
    }

    if (sector !== null && BASE_BREAKOUT_DISQUALIFIED_SECTORS.has(sector)) {
      result.excludedBySector += 1;
      return null;
    }

    const ev = evaluateBaseBreakout(bars, thresholds);
    if (ev === null) {
      result.excludedByEvalFailure += 1;
      return null;
    }
    const classified = classifyBaseBreakout(ev, q.currentPrice, thresholds);
    if (!classified.baseRangeGate.pass) result.excludedByBaseRange += 1;
    if (!classified.baseLengthGate.pass) result.excludedByBaseLength += 1;
    if (!classified.atrGate.pass) result.excludedByAtrContraction += 1;
    if (classified.noValidTrigger) result.excludedByNoValidTrigger += 1;
    if (classified.list === null && classified.nearMiss === null) return null;

    const atr14 = computeATR(bars, 14);
    const list = classified.list;
    const nearMiss = classified.nearMiss;
    const levelsBase = list === "ready" || list === "leading_extended" ? ev.trigger!.base : ev.base;
    const levels = computeBaseBreakoutLevels(q, atr14, levelsBase);
    if (!levels) return null;

    const candidate = buildBaseBreakoutCandidate({
      q,
      atr14,
      ev,
      list: list ?? "near_miss",
      nearMiss,
      levels,
      sector,
      nextEarningsDate: nextEarn?.date ?? null,
      daysToEarnings: daysToEarn,
      dataQualityDegraded: sectorFailed || earningsFailed,
      dataQualityIssues: [
        ...(sectorFailed ? ["sector_check_failed"] : []),
        ...(earningsFailed ? ["earnings_check_failed"] : []),
      ],
    });
    result.candidates.push(candidate);
    if (sectorFailed || earningsFailed) result.degradedCount += 1;
    return null;
  });

  return result;
}

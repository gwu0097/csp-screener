import {
  getOptionsChain,
  getOptionsChainRange,
  SchwabOptionContract,
  SchwabOptionsChain,
} from "@/lib/schwab";
import {
  getHistoricalEarningsMovements,
  getHistoricalPrices,
  getMarketCap,
  EarningsMove,
} from "@/lib/yahoo";
import type { PerplexityNewsResult } from "@/lib/perplexity";
import { createServerClient } from "@/lib/supabase";
import {
  getAnalystEstimates,
  getEarningsSurpriseHistory,
} from "@/lib/earnings";
import {
  ACTIVE_OVERHANG,
  BUSINESS_SIMPLICITY,
  IndustryClass,
  cacheMarketCapBillions,
  getCachedMarketCapBillions,
} from "@/lib/classification";

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
  maxScore: 25;
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
    medianHistoricalMovePct: number | null;
    expectedMovePct: number | null;
    weeklyIv: number | null;
    monthlyIv: number | null;
    realizedVol30d: number | null;
  };
};

export type StageFourResult = {
  score: number;
  maxScore: 20;
  opportunityGrade: "A" | "B" | "C" | "F";
  suggestedStrike: number | null;
  premium: number | null;
  delta: number | null;
  bidAskSpreadPct: number | null;
  premiumYieldPct: number | null;
  note: string | null;
  details: {
    premiumYieldScore: number;
    deltaScore: number;
    spreadScore: number;
    contractSymbol: string | null;
  };
};

// Hard kill: if bid-ask spread as % of mid exceeds this, the contract is
// effectively untradeable — grade force to F and recommendation force to Skip.
// 20% tolerates weekly single-stock option spreads while still killing truly
// untradeable names (NDAQ ~78%, TMO ~85% seen in practice).
export const SPREAD_KILL_PCT = 20;

export type ScreenerResult = {
  symbol: string;
  price: number;
  earningsDate: string;
  earningsTiming: "BMO" | "AMC";
  daysToExpiry: number;
  expiry: string;
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
  };
  personalGrade: Grade | "INSUFFICIENT";
  personalScore: number | null;
  personalFactors: {
    tickerWinRate: number | null;
    tickerTradeCount: number;
    tickerAvgRoc: number | null;
    tickerCrushAccuracy: number | null;
    dataInsufficient: boolean;
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
  finalScore: number;
  recommendation: string;
  recommendationReason: string;
};

export type PersonalHistory = {
  tradeCount: number;
  winRate: number | null;
  avgRoc: number | null;
  dataInsufficient: boolean;
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
  options: { industryPenalty?: number } = {},
): Promise<StageTwoResult> {
  const [mcapB, analyst] = await Promise.all([
    fetchMarketCapBillions(candidate.symbol),
    getAnalystEstimates(candidate.symbol),
  ]);
  const businessSimplicity = scoreBusinessSimplicity(candidate.symbol);
  const marketCapTier = scoreMarketCap(mcapB);
  const analystDispersion = scoreDispersion(analyst.dispersionPct);
  const preOverhang = businessSimplicity + marketCapTier + analystDispersion;
  const overhangPenalty = ACTIVE_OVERHANG.has(normalizeSymbol(candidate.symbol)) ? -3 : 0;
  const industryPenalty = options.industryPenalty ?? 0;
  const score = preOverhang + overhangPenalty + industryPenalty;
  const pass = preOverhang >= 6;
  return {
    score,
    maxScore: 9,
    pass,
    reason: pass ? "Quality floor met" : `Quality ${preOverhang}/9 below 6 floor`,
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

function gradeFromCrushScore(score: number): StageThreeResult["crushGrade"] {
  if (score >= 20) return "A";
  if (score >= 16) return "B";
  if (score >= 14) return "C";
  return "F";
}

function scoreHistoricalMove(medianMovePct: number | null, emPct: number | null): number {
  if (medianMovePct === null || emPct === null || emPct <= 0) return 0;
  const ratio = medianMovePct / emPct;
  if (ratio < 0.5) return 8;
  if (ratio < 0.7) return 5;
  if (ratio < 0.9) return 2;
  return 0;
}

function scoreConsistency(movePcts: number[]): number {
  if (movePcts.length < 3) return 0;
  const sd = stddev(movePcts);
  if (sd < 0.02) return 4;
  if (sd < 0.04) return 2;
  return 0;
}

function scoreTermStructure(weeklyIv: number | null, monthlyIv: number | null): number {
  if (!weeklyIv || !monthlyIv || monthlyIv <= 0) return 0;
  const ratio = weeklyIv / monthlyIv;
  if (ratio > 1.5) return 5;
  if (ratio > 1.3) return 3;
  if (ratio > 1.1) return 1;
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

  const emPct = expectedMoveFromIv(weeklyIv, candidate.daysToExpiry);
  const movePcts = historicalMoves.map((m) => m.actualMovePct);
  const medianMove = movePcts.length > 0 ? median(movePcts) : null;
  console.log(
    `[stage3:${sym}] historicalMoves count=${historicalMoves.length} medianMove=${medianMove ?? "null"} ` +
      `emPct=${emPct ?? "null"} (weeklyIv * sqrt(${candidate.daysToExpiry}/365))`,
  );

  // 30-day realized vol proxy
  const today = new Date();
  const thirtyDaysAgo = new Date(today.getTime() - 45 * 24 * 60 * 60 * 1000);
  const prices = await getHistoricalPrices(candidate.symbol, thirtyDaysAgo, today);
  const closes = prices.map((p) => p.close).filter((c) => c > 0);
  const realizedVol = annualizedRealizedVol(closes);
  console.log(
    `[stage3:${sym}] realizedVol30d bars=${prices.length} usableCloses=${closes.length} rv=${realizedVol ?? "null"} ` +
      `ivEdgeRatio=${weeklyIv && realizedVol ? (weeklyIv / realizedVol).toFixed(2) : "n/a"}`,
  );

  const surprise = await getEarningsSurpriseHistory(candidate.symbol);

  const historicalMoveScore = scoreHistoricalMove(medianMove, emPct);
  const consistencyScore = scoreConsistency(movePcts);
  const termStructureScore = scoreTermStructure(weeklyIv, monthlyIv);
  const ivEdgeScore = scoreIvEdge(weeklyIv, realizedVol);
  const surpriseScore = surprise.surpriseScore;

  const score = historicalMoveScore + consistencyScore + termStructureScore + ivEdgeScore + surpriseScore;
  const threshold = crushThresholdForDte(candidate.daysToExpiry);

  console.log(
    `[stage3:${sym}] SCORES hist=${historicalMoveScore}/8 cons=${consistencyScore}/4 ` +
      `term=${termStructureScore}/5 ivEdge=${ivEdgeScore}/4 surprise=${surpriseScore}/4 ` +
      `total=${score}/25 threshold=${threshold} pass=${score >= threshold} ` +
      `grade=${gradeFromCrushScore(score)}`,
  );
  void monthlyExpiryKey;

  return {
    score,
    maxScore: 25,
    pass: score >= threshold,
    threshold,
    crushGrade: gradeFromCrushScore(score),
    insufficientData: historicalMoves.length < 3,
    details: {
      historicalMoveScore,
      consistencyScore,
      termStructureScore,
      ivEdgeScore,
      surpriseScore,
      medianHistoricalMovePct: medianMove,
      expectedMovePct: emPct,
      weeklyIv,
      monthlyIv,
      realizedVol30d: realizedVol,
    },
  };
}

// ---------- Stage 4 ----------

function scorePremiumYield(yieldPct: number): number {
  if (yieldPct > 0.5) return 8;
  if (yieldPct >= 0.3) return 5;
  if (yieldPct >= 0.15) return 2;
  return 0;
}

function scoreDelta(delta: number): number {
  const abs = Math.abs(delta);
  if (abs >= 0.08 && abs <= 0.12) return 6;
  if (abs > 0.12 && abs <= 0.18) return 4;
  if (abs > 0.18 && abs <= 0.25) return 2;
  return 0;
}

function scoreSpread(spreadPctOfMid: number): number {
  if (spreadPctOfMid < 5) return 6;
  if (spreadPctOfMid < 10) return 4;
  if (spreadPctOfMid < 20) return 2;
  return 0;
}

function gradeFromOpportunityScore(score: number): StageFourResult["opportunityGrade"] {
  if (score >= 17) return "A";
  if (score >= 12) return "B";
  if (score >= 8) return "C";
  return "F";
}

function pickStrikeNearest(chain: SchwabOptionsChain, expiryPrefix: string, targetStrike: number): SchwabOptionContract | null {
  const expKey = Object.keys(chain.putExpDateMap ?? {}).find((k) => k.startsWith(expiryPrefix));
  if (!expKey) return null;
  const contracts = Object.values(chain.putExpDateMap[expKey]).flat();
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
  return best;
}

export function runStageFour(
  candidate: EarningsCandidate,
  chain: SchwabOptionsChain,
  medianHistoricalMovePct: number | null,
  emPct: number | null,
): StageFourResult {
  const referenceMove = medianHistoricalMovePct ?? emPct;
  if (referenceMove === null) {
    return {
      score: 0,
      maxScore: 20,
      opportunityGrade: "F",
      suggestedStrike: null,
      premium: null,
      delta: null,
      bidAskSpreadPct: null,
      premiumYieldPct: null,
      note: null,
      details: { premiumYieldScore: 0, deltaScore: 0, spreadScore: 0, contractSymbol: null },
    };
  }
  const suggestedStrike = candidate.price * (1 - 2.0 * referenceMove);
  const contract = pickStrikeNearest(chain, candidate.expiry, suggestedStrike);
  if (!contract) {
    return {
      score: 0,
      maxScore: 20,
      opportunityGrade: "F",
      suggestedStrike,
      premium: null,
      delta: null,
      bidAskSpreadPct: null,
      premiumYieldPct: null,
      note: null,
      details: { premiumYieldScore: 0, deltaScore: 0, spreadScore: 0, contractSymbol: null },
    };
  }

  const mid = (contract.bid + contract.ask) / 2 || contract.mark || contract.last || 0;
  const premium = mid;
  const yieldPct = candidate.price > 0 ? (premium / candidate.price) * 100 : 0;
  const spreadPctOfMid = mid > 0 ? ((contract.ask - contract.bid) / mid) * 100 : 100;
  const delta = contract.delta;

  const premiumYieldScore = scorePremiumYield(yieldPct);
  const deltaScore = scoreDelta(delta);
  const spreadScore = scoreSpread(spreadPctOfMid);
  const rawScore = premiumYieldScore + deltaScore + spreadScore;

  const spreadTooWide = spreadPctOfMid > SPREAD_KILL_PCT;
  // Spread-too-wide is a hard kill: force grade F regardless of other scores.
  const opportunityGrade = spreadTooWide ? "F" : gradeFromOpportunityScore(rawScore);
  const note = spreadTooWide ? "Spread too wide to trade" : null;

  return {
    score: rawScore,
    maxScore: 20,
    opportunityGrade,
    suggestedStrike: Math.round(suggestedStrike * 100) / 100,
    premium: Math.round(premium * 100) / 100,
    delta: Math.round(delta * 1000) / 1000,
    bidAskSpreadPct: Math.round(spreadPctOfMid * 10) / 10,
    premiumYieldPct: Math.round(yieldPct * 1000) / 1000,
    note,
    details: {
      premiumYieldScore,
      deltaScore,
      spreadScore,
      contractSymbol: contract.symbol,
    },
  };
}

function isSpreadTooWide(stageFour: StageFourResult | null): boolean {
  if (!stageFour) return false;
  return stageFour.bidAskSpreadPct !== null && stageFour.bidAskSpreadPct > SPREAD_KILL_PCT;
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
  const friday = nextFridayOnOrAfter(earningsDate);
  const dte = businessDaysBetween(earningsDate, friday);
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
): Promise<SchwabOptionsChain | null> {
  try {
    const chain = await getOptionsChain(symbol, fromDate);
    void toDate;
    return chain;
  } catch {
    return null;
  }
}

export async function safeGetChainRange(
  symbol: string,
  fromDate: string,
  toDate: string,
): Promise<SchwabOptionsChain | null> {
  try {
    return await getOptionsChainRange(symbol, fromDate, toDate);
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
  const stageTwo = await runStageTwo(candidate, context.industryClass, { industryPenalty });

  const baseResult: Omit<ScreenerResult, "recommendation" | "stoppedAt" | "stageThree" | "stageFour" | "threeLayer"> = {
    symbol: candidate.symbol,
    price: candidate.price,
    earningsDate: candidate.earningsDate,
    earningsTiming: candidate.earningsTiming,
    daysToExpiry: candidate.daysToExpiry,
    expiry: candidate.expiry,
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
export async function runStagesThreeFour(base: ScreenerResult): Promise<ScreenerResult> {
  const candidate: EarningsCandidate = {
    symbol: base.symbol,
    price: base.price,
    earningsDate: base.earningsDate,
    earningsTiming: base.earningsTiming,
    daysToExpiry: base.daysToExpiry,
    expiry: base.expiry,
  };

  const chain = await safeGetChain(candidate.symbol, candidate.expiry, candidate.expiry);
  if (!chain || !chainHasWeeklyExpiry(chain, candidate.expiry)) {
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

  const historicalMoves = await getHistoricalEarningsMovements(candidate.symbol);

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

  const stageThree = await runStageThree(candidate, chain, monthlyChain, historicalMoves);
  const stageFour = runStageFour(
    candidate,
    chain,
    stageThree.details.medianHistoricalMovePct,
    stageThree.details.expectedMovePct,
  );

  const spreadTooWide = isSpreadTooWide(stageFour);
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
    stoppedAt: tradeable ? null : 3,
    stageThree,
    stageFour,
    recommendation,
    spreadTooWide,
    threeLayer: base.threeLayer ?? null,
  };
}

// ---------- Three-layer grade ----------

function gradeScore(g: Grade | null | undefined, a: number, b: number, c: number): number {
  if (g === "A") return a;
  if (g === "B") return b;
  if (g === "C") return c;
  return 0;
}

function scoreToGrade(score: number): Grade {
  if (score >= 80) return "A";
  if (score >= 65) return "B";
  if (score >= 50) return "C";
  return "F";
}

// Returns closed-position stats for a ticker: count, win rate, avg ROC.
// Used by Layer 2 of the three-layer grade. dataInsufficient=true when
// we have fewer than 5 closed trades on the ticker — in that case the
// grader treats Layer 2 as neutral rather than penalizing on noise.
export async function getPersonalHistory(symbol: string): Promise<PersonalHistory> {
  try {
    const supabase = createServerClient();
    const { data, error } = await supabase
      .from("positions")
      .select("avg_premium_sold, realized_pnl, total_contracts")
      .eq("symbol", symbol.toUpperCase())
      .eq("status", "closed");
    if (error || !data) {
      return { tradeCount: 0, winRate: null, avgRoc: null, dataInsufficient: true };
    }
    const rows = data as Array<{
      avg_premium_sold: number | null;
      realized_pnl: number | null;
      total_contracts: number | null;
    }>;
    const tradeCount = rows.length;
    if (tradeCount === 0) {
      return { tradeCount: 0, winRate: null, avgRoc: null, dataInsufficient: true };
    }
    const wins = rows.filter((r) => Number(r.realized_pnl ?? 0) > 0).length;
    const winRate = (wins / tradeCount) * 100;
    const rocs = rows
      .map((r) => {
        const sold = Number(r.avg_premium_sold ?? 0);
        const contracts = Number(r.total_contracts ?? 0);
        const pnl = Number(r.realized_pnl ?? 0);
        const capital = sold * contracts * 100;
        return capital > 0 ? (pnl / capital) * 100 : null;
      })
      .filter((r): r is number => r !== null);
    const avgRoc = rocs.length > 0 ? rocs.reduce((a, b) => a + b, 0) / rocs.length : null;
    return {
      tradeCount,
      winRate,
      avgRoc,
      dataInsufficient: tradeCount < 5,
    };
  } catch {
    return { tradeCount: 0, winRate: null, avgRoc: null, dataInsufficient: true };
  }
}

// Combines the three independent signal streams into one grade:
//   Layer 1 (industry): pure options metrics from Stage 3/4 (0-60 pts)
//   Layer 2 (personal): your closed-position win rate + ROC (0-25 pts)
//   Layer 3 (regime): news sentiment/overhang + VIX (0-15 pts, penalty up to -15)
// Final score = L1 + L2 + L3 + penalty, then mapped to A/B/C/F.
export function calculateThreeLayerGrade(
  stageThreeResult: StageThreeResult,
  stageFourResult: StageFourResult,
  newsContext: PerplexityNewsResult,
  personalHistory: PersonalHistory | null,
  vix: number | null,
): ThreeLayerGrade {
  // ---- Layer 1: Industry standard (0-60 pts) ----
  // For a 2x-EM CSP strategy, strike-survival probability is the dominant
  // signal — weight POP heavily. Crush grade is still shown in its own
  // column and Layer 2/3 factors; it isn't re-scored here.
  const crushGrade = stageThreeResult.crushGrade;
  const opportunityGrade = stageFourResult.opportunityGrade;

  // POP = 1 − |delta|. Compute before scoring so we can feed it into
  // Layer 1 directly.
  const delta = stageFourResult.delta ?? 0;
  const probabilityOfProfit = 1 - Math.abs(delta);
  const premium = stageFourResult.premium ?? 0;
  const strike = stageFourResult.suggestedStrike ?? 0;
  const breakevenPrice = strike - premium;
  // EV per contract (dollars): POP × premium − (1 − POP) × breakeven-to-zero loss.
  // Rough proxy — assumes the put assigns and stock drops to 0 on the miss side.
  const expectedValue = probabilityOfProfit * premium * 100 - (1 - probabilityOfProfit) * strike * 100;

  // Probability of profit (25 pts max).
  let popPts = 0;
  if (probabilityOfProfit >= 0.9) popPts = 25;
  else if (probabilityOfProfit >= 0.85) popPts = 20;
  else if (probabilityOfProfit >= 0.8) popPts = 15;
  else if (probabilityOfProfit >= 0.75) popPts = 8;
  else popPts = 0;

  // IV edge sweet-spot buckets (15 pts max).
  //   1.3-1.6 → 15 (ideal)
  //   1.6-1.9 → 10 (real event risk priced in)
  //   1.2-1.3 → 8  (modest)
  //   > 1.9   → 5  (market pricing a real move)
  //   < 1.2   → 0
  const weeklyIv = stageThreeResult.details.weeklyIv ?? null;
  const realizedVol = stageThreeResult.details.realizedVol30d ?? null;
  const ivEdge =
    weeklyIv !== null && realizedVol !== null && realizedVol > 0
      ? weeklyIv / realizedVol
      : 0;
  let ivEdgePts = 0;
  if (ivEdge >= 1.3 && ivEdge < 1.6) ivEdgePts = 15;
  else if (ivEdge >= 1.6 && ivEdge < 1.9) ivEdgePts = 10;
  else if (ivEdge >= 1.2 && ivEdge < 1.3) ivEdgePts = 8;
  else if (ivEdge >= 1.9) ivEdgePts = 5;
  else ivEdgePts = 0;

  // Term structure raw score 0-5 → 0-10.
  const termStructureRaw = stageThreeResult.details.termStructureScore;
  const termPts = (termStructureRaw / 5) * 10;

  // Opportunity grade (10 pts max).
  const oppPts = gradeScore(opportunityGrade, 10, 7, 3);

  const industryScore = popPts + ivEdgePts + termPts + oppPts;
  // Industry grade maps 0-60 to A/B/C/F on the 80/65/50 score thresholds
  // (same as final-score bucketing).
  const industryGrade = scoreToGrade((industryScore / 60) * 100);

  // ---- Layer 2: Personal intelligence (0-25 pts, or null if insufficient) ----
  let personalScore: number | null = null;
  let personalGrade: Grade | "INSUFFICIENT" = "INSUFFICIENT";
  const history = personalHistory ?? {
    tradeCount: 0,
    winRate: null,
    avgRoc: null,
    dataInsufficient: true,
  };
  if (!history.dataInsufficient && history.winRate !== null) {
    let wrPts = 0;
    if (history.winRate > 80) wrPts = 15;
    else if (history.winRate >= 60) wrPts = 10;
    else wrPts = 0;
    let rocPts = 0;
    const roc = history.avgRoc ?? 0;
    if (roc > 0.5) rocPts = 10;
    else if (roc >= 0.25) rocPts = 5;
    else rocPts = 0;
    personalScore = wrPts + rocPts;
    personalGrade = scoreToGrade((personalScore / 25) * 100);
  }

  // ---- Layer 3: Current regime (0-15 pts, penalty up to -15) ----
  let regimeScore = 15;
  if (newsContext.sentiment === "negative" && !newsContext.hasActiveOverhang) regimeScore = 10;
  if (newsContext.hasActiveOverhang) regimeScore = 0;

  let vixRegime: "calm" | "elevated" | "panic" | null = null;
  if (vix !== null) {
    if (vix > 25) vixRegime = "panic";
    else if (vix >= 20) vixRegime = "elevated";
    else vixRegime = "calm";
  }
  let vixAdj = 0;
  if (vixRegime === "elevated") vixAdj = -3;
  else if (vixRegime === "panic") vixAdj = -8;
  regimeScore = Math.max(0, regimeScore + vixAdj);
  const regimeGrade = scoreToGrade((regimeScore / 15) * 100);

  // ---- Final combined score ----
  // Layer 2 contributes a neutral 12.5 when we don't have enough history,
  // so the final grade isn't pulled down by ignorance.
  const l2ForFinal = personalScore ?? 12.5;
  const penalty = newsContext.gradePenalty ?? 0;
  const finalScore = Math.max(0, industryScore + l2ForFinal + regimeScore + penalty);
  const finalGrade = scoreToGrade(finalScore);

  // Recommendation text: short verdict + the specific reason string.
  let recommendation = "Skip";
  if (finalGrade === "A") recommendation = "Strong - Take the trade";
  else if (finalGrade === "B") recommendation = "Marginal - Size smaller";
  else if (finalGrade === "C") recommendation = "Marginal - Size small";

  const reasonParts: string[] = [];
  // Lead with POP + strike: the dominant signal for a 2x-EM CSP strategy.
  const popPct = (probabilityOfProfit * 100).toFixed(0);
  const ivEdgeBand =
    ivEdge >= 1.3 && ivEdge < 1.6
      ? "in ideal range"
      : ivEdge >= 1.6 && ivEdge < 1.9
        ? "slightly elevated but within range"
        : ivEdge >= 1.2 && ivEdge < 1.3
          ? "modest"
          : ivEdge >= 1.9
            ? "market pricing a real move"
            : ivEdge > 0
              ? "below crush-setup threshold"
              : "n/a";
  reasonParts.push(
    `${popPct}% probability of profit at $${strike.toFixed(2)} strike. IV edge ${ivEdge.toFixed(2)} ${ivEdgeBand}. Opp ${opportunityGrade}, crush ${crushGrade} — industry ${industryGrade} (${industryScore.toFixed(0)}/60).`,
  );
  if (personalScore !== null) {
    reasonParts.push(
      `${history.tradeCount} prior trades on this ticker: ${history.winRate?.toFixed(0)}% win rate, ${history.avgRoc?.toFixed(2)}% avg ROC → personal ${personalGrade}.`,
    );
  } else {
    reasonParts.push(
      `Insufficient history (${history.tradeCount} closed trades on this ticker; neutral 12.5 applied).`,
    );
  }
  if (newsContext.hasActiveOverhang) {
    reasonParts.push(
      `Active overhang: ${newsContext.overhangDescription ?? "see news"}. Triggered ${penalty}-pt penalty.`,
    );
  } else if (newsContext.sentiment === "negative") {
    reasonParts.push(`Negative news tone (${penalty}-pt penalty). ${newsContext.summary}`);
  } else {
    reasonParts.push(`News ${newsContext.sentiment}, no overhang.`);
  }
  if (vixRegime !== null && vixRegime !== "calm") {
    reasonParts.push(`VIX ${vix?.toFixed(1)} = ${vixRegime} (${vixAdj}-pt adjustment).`);
  }
  reasonParts.push(`Final ${finalGrade} (${finalScore.toFixed(0)}/100).`);

  return {
    industryGrade,
    industryScore,
    industryFactors: {
      probabilityOfProfit,
      ivRank: null, // not computed yet — needs 52-wk IV history
      ivEdge,
      termStructure: termStructureRaw,
      crushGrade,
      opportunityGrade,
      expectedValue,
      breakevenPrice,
    },
    personalGrade,
    personalScore,
    personalFactors: {
      tickerWinRate: history.winRate,
      tickerTradeCount: history.tradeCount,
      tickerAvgRoc: history.avgRoc,
      tickerCrushAccuracy: null, // requires stored screener-grade-vs-outcome join; deferred
      dataInsufficient: history.dataInsufficient,
    },
    regimeGrade,
    regimeScore,
    regimeFactors: {
      newsSentiment: newsContext.sentiment,
      hasActiveOverhang: newsContext.hasActiveOverhang,
      overhangDescription: newsContext.overhangDescription,
      newsSummary: newsContext.summary,
      gradePenalty: newsContext.gradePenalty,
      vix,
      vixRegime,
    },
    finalGrade,
    finalScore,
    recommendation,
    recommendationReason: reasonParts.join(" "),
  };
}

import {
  getOptionsChain,
  SchwabOptionContract,
  SchwabOptionsChain,
} from "@/lib/schwab";
import {
  getHistoricalEarningsMovements,
  getHistoricalPrices,
  getMarketCap,
  EarningsMove,
} from "@/lib/yahoo";
import {
  getAnalystEstimates,
  getEarningsSurpriseHistory,
} from "@/lib/earnings";
import {
  ACTIVE_OVERHANG,
  BUSINESS_SIMPLICITY,
  IndustryClass,
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
  details: {
    premiumYieldScore: number;
    deltaScore: number;
    spreadScore: number;
    contractSymbol: string | null;
  };
};

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
  recommendation: "Strong - Take the trade" | "Marginal - Size smaller" | "Skip" | "Cannot evaluate" | "Needs analysis";
  errors: string[];
  isWhitelisted: boolean;
  industryStatus: "pass" | "fail" | "unknown";
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
  const mcap = await getMarketCap(symbol);
  if (typeof mcap !== "number" || mcap <= 0) return null;
  return Math.round((mcap / 1e9) * 100) / 100;
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

export async function runStageThree(
  candidate: EarningsCandidate,
  chain: SchwabOptionsChain,
  monthlyChain: SchwabOptionsChain | null,
  historicalMoves: EarningsMove[],
): Promise<StageThreeResult> {
  const weeklyAtm = pickAtmContract(chain, candidate.expiry, candidate.price);
  const weeklyIv = ivPercent(weeklyAtm?.volatility);

  let monthlyIv: number | null = null;
  if (monthlyChain) {
    const expKey = Object.keys(monthlyChain.putExpDateMap ?? {})[0];
    if (expKey) {
      const prefix = expKey.split(":")[0];
      const monthlyAtm = pickAtmContract(monthlyChain, prefix, candidate.price);
      monthlyIv = ivPercent(monthlyAtm?.volatility);
    }
  }

  const emPct = expectedMoveFromIv(weeklyIv, candidate.daysToExpiry);
  const movePcts = historicalMoves.map((m) => m.actualMovePct);
  const medianMove = movePcts.length > 0 ? median(movePcts) : null;

  // 30-day realized vol proxy
  const today = new Date();
  const thirtyDaysAgo = new Date(today.getTime() - 45 * 24 * 60 * 60 * 1000);
  const prices = await getHistoricalPrices(candidate.symbol, thirtyDaysAgo, today);
  const closes = prices.map((p) => p.close).filter((c) => c > 0);
  const realizedVol = annualizedRealizedVol(closes);

  const surprise = await getEarningsSurpriseHistory(candidate.symbol);

  const historicalMoveScore = scoreHistoricalMove(medianMove, emPct);
  const consistencyScore = scoreConsistency(movePcts);
  const termStructureScore = scoreTermStructure(weeklyIv, monthlyIv);
  const ivEdgeScore = scoreIvEdge(weeklyIv, realizedVol);
  const surpriseScore = surprise.surpriseScore;

  const score = historicalMoveScore + consistencyScore + termStructureScore + ivEdgeScore + surpriseScore;
  const threshold = crushThresholdForDte(candidate.daysToExpiry);

  return {
    score,
    maxScore: 25,
    pass: score >= threshold,
    threshold,
    crushGrade: gradeFromCrushScore(score),
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
  const score = premiumYieldScore + deltaScore + spreadScore;

  return {
    score,
    maxScore: 20,
    opportunityGrade: gradeFromOpportunityScore(score),
    suggestedStrike: Math.round(suggestedStrike * 100) / 100,
    premium: Math.round(premium * 100) / 100,
    delta: Math.round(delta * 1000) / 1000,
    bidAskSpreadPct: Math.round(spreadPctOfMid * 10) / 10,
    premiumYieldPct: Math.round(yieldPct * 1000) / 1000,
    details: {
      premiumYieldScore,
      deltaScore,
      spreadScore,
      contractSymbol: contract.symbol,
    },
  };
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

  const baseResult: Omit<ScreenerResult, "recommendation" | "stoppedAt" | "stageThree" | "stageFour"> = {
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
  };

  return {
    ...baseResult,
    stoppedAt: null,
    stageThree: null,
    stageFour: null,
    recommendation: "Needs analysis",
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
    };
  }

  const historicalMoves = await getHistoricalEarningsMovements(candidate.symbol);
  const monthlyTarget = new Date(Date.now() + 35 * 24 * 60 * 60 * 1000);
  const monthlyChain = await safeGetChain(
    candidate.symbol,
    toIsoDate(monthlyTarget),
    toIsoDate(monthlyTarget),
  );

  const stageThree = await runStageThree(candidate, chain, monthlyChain, historicalMoves);
  const stageFour = runStageFour(
    candidate,
    chain,
    stageThree.details.medianHistoricalMovePct,
    stageThree.details.expectedMovePct,
  );

  const recommendation = stageThree.pass
    ? recommend(stageThree.crushGrade, stageFour.opportunityGrade)
    : "Skip";

  return {
    ...base,
    stoppedAt: stageThree.pass ? null : 3,
    stageThree,
    stageFour,
    recommendation,
  };
}

import {
  getOptionsChain,
  SchwabOptionContract,
  SchwabOptionsChain,
  isSchwabConnected,
} from "@/lib/schwab";
import {
  getCurrentPrice,
  getHistoricalEarningsMovements,
  getHistoricalPrices,
  getMarketCap,
  getSectorIndustry,
  EarningsMove,
} from "@/lib/yahoo";
import {
  getAnalystEstimates,
  getEarningsSurpriseHistory,
} from "@/lib/earnings";
import {
  ACTIVE_OVERHANG,
  BUSINESS_SIMPLICITY,
  INDUSTRY_MAP,
  IndustryClass,
  PASSING_CLASSES,
  classifyFromSector,
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
  recommendation: "Strong - Take the trade" | "Marginal - Size smaller" | "Skip" | "Cannot evaluate";
  errors: string[];
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

function classifyIndustry(symbol: string, sector: string | null, industry: string | null): IndustryClass {
  const mapped = INDUSTRY_MAP[normalizeSymbol(symbol)];
  if (mapped) return mapped;
  return classifyFromSector(sector, industry);
}

function hasWeeklyFridayExpiry(chain: SchwabOptionsChain, targetFriday: string): boolean {
  const keys = Object.keys(chain.putExpDateMap ?? {});
  return keys.some((k) => k.startsWith(targetFriday));
}

export async function runStageOne(
  candidate: EarningsCandidate,
  chain: SchwabOptionsChain | null,
  industryClass: IndustryClass,
): Promise<StageOneResult> {
  const details: StageOneResult["details"] = {
    timing: candidate.earningsTiming,
    price: candidate.price,
    industryClass,
    expiry: candidate.expiry,
    weeklyExpiryFound: null,
  };

  if (candidate.earningsTiming !== "BMO" && candidate.earningsTiming !== "AMC") {
    return { pass: false, reason: "Earnings during market hours — skip", details };
  }
  if (!Number.isFinite(candidate.price) || candidate.price < 20) {
    return { pass: false, reason: `Stock price ${candidate.price} below $20 floor`, details };
  }
  if (!PASSING_CLASSES.has(industryClass)) {
    return { pass: false, reason: `Industry class "${industryClass}" not on whitelist`, details };
  }
  const weeklyFound = chain ? hasWeeklyFridayExpiry(chain, candidate.expiry) : false;
  details.weeklyExpiryFound = weeklyFound;
  if (!weeklyFound) {
    return { pass: false, reason: "No weekly (Friday) option expiry in Schwab chain", details };
  }
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
): Promise<StageTwoResult> {
  const [mcapB, analyst] = await Promise.all([
    fetchMarketCapBillions(candidate.symbol),
    getAnalystEstimates(candidate.symbol),
  ]);
  const businessSimplicity = scoreBusinessSimplicity(candidate.symbol);
  const marketCapTier = scoreMarketCap(mcapB);
  const analystDispersion = scoreDispersion(analyst.dispersionPct);
  const preOverhang = businessSimplicity + marketCapTier + analystDispersion;
  const penalty = ACTIVE_OVERHANG.has(normalizeSymbol(candidate.symbol)) ? -3 : 0;
  const score = preOverhang + penalty;
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
      activeOverhangPenalty: penalty,
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

function buildCandidateFromEarnings(row: { symbol: string; date: string; timing: "BMO" | "AMC" }, price: number): EarningsCandidate {
  const earningsDate = new Date(row.date + "T00:00:00Z");
  // BMO: earnings before market open on `date`. Trade placed day before, exits at next Friday.
  // AMC: earnings after market close on `date`. Trade placed that day.
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
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

async function safeGetChain(symbol: string, fromDate: string, toDate: string): Promise<SchwabOptionsChain | null> {
  try {
    const chain = await getOptionsChain(symbol, fromDate);
    // Expand to date range if we need more coverage; rely on screener to pick the expiry it needs.
    void toDate;
    return chain;
  } catch {
    return null;
  }
}

export type RawEarningsCandidate = { symbol: string; date: string; timing: "BMO" | "AMC" };

// Known ETF / fund tickers that can occasionally appear in calendar feeds.
const KNOWN_ETFS: ReadonlySet<string> = new Set<string>([
  "SPY", "IVV", "VOO", "VTI", "VXUS", "QQQ", "QQQM", "IWM", "DIA",
  "EEM", "EFA", "VEA", "VWO", "AGG", "BND", "LQD", "HYG", "TLT", "IEF",
  "GLD", "SLV", "USO", "UNG", "DBC",
  "XLF", "XLK", "XLE", "XLV", "XLP", "XLU", "XLI", "XLRE", "XLB", "XLY", "XLC",
  "TQQQ", "SQQQ", "UVXY", "SOXL", "SOXS", "SPXL", "SPXS", "TMF", "TMV", "ARKK", "SVXY",
  "SCHD", "SCHB", "VIG", "JEPI", "JEPQ", "BIL", "SHV", "SGOV",
]);

function isLikelyCommonEquity(symbol: string): boolean {
  if (!symbol) return false;
  const s = symbol.trim().toUpperCase();
  if (s.length === 0 || s.length > 10) return false;
  // Plain letters, optionally followed by .CLASS or -CLASS (e.g. BRK.B, BRK-B).
  if (!/^[A-Z]{1,5}([.\-][A-Z]{1,2})?$/.test(s)) return false;
  if (KNOWN_ETFS.has(s)) return false;
  return true;
}

export type PreFilterOptions = { maxCount?: number };

export function preFilterEarningsCandidates<T extends RawEarningsCandidate>(
  raw: T[],
  options: PreFilterOptions = {},
): T[] {
  const maxCount = options.maxCount ?? 20;

  const timingOk = raw.filter((c) => c.timing === "BMO" || c.timing === "AMC");
  const shapeOk = timingOk.filter((c) => isLikelyCommonEquity(c.symbol));

  const classifiedPass = shapeOk.filter((c) => {
    const klass = INDUSTRY_MAP[normalizeSymbol(c.symbol)];
    return klass !== undefined && PASSING_CLASSES.has(klass);
  });

  const seen = new Set<string>();
  const deduped = classifiedPass.filter((c) => {
    const key = `${c.symbol}|${c.date}|${c.timing}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return deduped.slice(0, maxCount);
}

export async function runScreenerForCandidates(
  candidates: RawEarningsCandidate[],
): Promise<{ connected: boolean; results: ScreenerResult[]; errors: string[] }> {
  const errors: string[] = [];
  const { connected } = await isSchwabConnected();

  const results: ScreenerResult[] = [];
  for (const row of candidates) {
    const result = await evaluateOne(row, connected, errors);
    results.push(result);
  }

  const recOrder: Record<ScreenerResult["recommendation"], number> = {
    "Strong - Take the trade": 0,
    "Marginal - Size smaller": 1,
    Skip: 2,
    "Cannot evaluate": 3,
  };
  const gradeOrder: Record<string, number> = { A: 0, B: 1, C: 2, F: 3 };
  results.sort((a, b) => {
    const r = recOrder[a.recommendation] - recOrder[b.recommendation];
    if (r !== 0) return r;
    const ca = a.stageThree?.crushGrade ?? "F";
    const cb = b.stageThree?.crushGrade ?? "F";
    return gradeOrder[ca] - gradeOrder[cb];
  });

  return { connected, results, errors };
}

async function evaluateOne(
  row: { symbol: string; date: string; timing: "BMO" | "AMC" },
  connected: boolean,
  errors: string[],
): Promise<ScreenerResult> {
  const localErrors: string[] = [];

  const price = await getCurrentPrice(row.symbol);
  const candidatePrice = typeof price === "number" && Number.isFinite(price) ? price : 0;
  const candidate = buildCandidateFromEarnings(row, candidatePrice);

  const { sector, industry } = await getSectorIndustry(row.symbol);
  const industryClass = classifyIndustry(row.symbol, sector, industry);

  let chain: SchwabOptionsChain | null = null;
  if (connected) {
    chain = await safeGetChain(row.symbol, candidate.expiry, candidate.expiry);
    if (!chain) localErrors.push(`Schwab options chain unavailable for ${row.symbol}`);
  }

  const stageOne = await runStageOne(candidate, chain, industryClass);
  if (!stageOne.pass) {
    return {
      symbol: candidate.symbol,
      price: candidate.price,
      earningsDate: candidate.earningsDate,
      earningsTiming: candidate.earningsTiming,
      daysToExpiry: candidate.daysToExpiry,
      expiry: candidate.expiry,
      stoppedAt: 1,
      stageOne,
      stageTwo: null,
      stageThree: null,
      stageFour: null,
      recommendation: connected ? "Skip" : "Cannot evaluate",
      errors: localErrors,
    };
  }

  const stageTwo = await runStageTwo(candidate, industryClass);
  if (!stageTwo.pass) {
    return {
      symbol: candidate.symbol,
      price: candidate.price,
      earningsDate: candidate.earningsDate,
      earningsTiming: candidate.earningsTiming,
      daysToExpiry: candidate.daysToExpiry,
      expiry: candidate.expiry,
      stoppedAt: 2,
      stageOne,
      stageTwo,
      stageThree: null,
      stageFour: null,
      recommendation: "Skip",
      errors: localErrors,
    };
  }

  if (!chain) {
    errors.push(...localErrors);
    return {
      symbol: candidate.symbol,
      price: candidate.price,
      earningsDate: candidate.earningsDate,
      earningsTiming: candidate.earningsTiming,
      daysToExpiry: candidate.daysToExpiry,
      expiry: candidate.expiry,
      stoppedAt: 3,
      stageOne,
      stageTwo,
      stageThree: null,
      stageFour: null,
      recommendation: "Cannot evaluate",
      errors: [...localErrors, "Schwab chain required for stage 3+"],
    };
  }

  const historicalMoves = await getHistoricalEarningsMovements(candidate.symbol);
  const monthlyTarget = new Date(Date.now() + 35 * 24 * 60 * 60 * 1000);
  const monthlyChain = await safeGetChain(candidate.symbol, toIsoDate(monthlyTarget), toIsoDate(monthlyTarget));

  const stageThree = await runStageThree(candidate, chain, monthlyChain, historicalMoves);
  if (!stageThree.pass) {
    return {
      symbol: candidate.symbol,
      price: candidate.price,
      earningsDate: candidate.earningsDate,
      earningsTiming: candidate.earningsTiming,
      daysToExpiry: candidate.daysToExpiry,
      expiry: candidate.expiry,
      stoppedAt: 3,
      stageOne,
      stageTwo,
      stageThree,
      stageFour: null,
      recommendation: "Skip",
      errors: localErrors,
    };
  }

  const stageFour = runStageFour(candidate, chain, stageThree.details.medianHistoricalMovePct, stageThree.details.expectedMovePct);

  return {
    symbol: candidate.symbol,
    price: candidate.price,
    earningsDate: candidate.earningsDate,
    earningsTiming: candidate.earningsTiming,
    daysToExpiry: candidate.daysToExpiry,
    expiry: candidate.expiry,
    stoppedAt: null,
    stageOne,
    stageTwo,
    stageThree,
    stageFour,
    recommendation: recommend(stageThree.crushGrade, stageFour.opportunityGrade),
    errors: localErrors,
  };
}

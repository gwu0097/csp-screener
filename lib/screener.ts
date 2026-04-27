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

// ---------- Hard-kill thresholds ----------

// Minimum stock price for a CSP candidate. Below this, strike granularity
// gets too coarse and premium-to-capital ratios stop working for the
// strategy. Enforced upstream in /api/screener/screen.
export const MIN_STOCK_PRICE = 60;

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
  // Compact snapshot of the weekly put chain so the UI can run a custom
  // strike analysis client-side without a new API call. Populated by
  // runStageFour; sorted by strike ascending.
  availableStrikes?: Array<{
    strike: number;
    bid: number;
    ask: number;
    mark: number;
    delta: number;
  }>;
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

// Loosened from the original (A>=20, B>=16, C>=14) — the old C
// threshold meant anything below 56% of max scored F, which over-
// penalised stocks where one or two of the five sub-scores were
// thin. New brackets demand a 72% finish for an A, 56% for a B, and
// 40% for a C; stocks below 10/25 still skip out as F.
function gradeFromCrushScore(score: number): StageThreeResult["crushGrade"] {
  if (score >= 18) return "A";
  if (score >= 14) return "B";
  if (score >= 10) return "C";
  return "F";
}

// Score the median historical move against today's IV-implied move.
// We don't store per-event historical IV (Phase 2), so the denominator
// is the CURRENT weekly emPct for every event in the window — same as
// the per-event ratio shown in [DEBUG:SPOT crush].
//
// Bucketing tracks the user-facing crush narrative:
//   ratio < 0.7   stock historically undershoots the implied move (A)
//   ratio < 0.85  comfortable margin                             (B)
//   ratio < 1.0   median ≤ implied                               (C)
//   ratio < 1.2   stock typically prints close to / over implied (D)
//   ratio ≥ 1.2   stock consistently overshoots                  (F)
// Mapped onto the existing 0-8 sub-score scale (no D in the
// composite grade type — D collapses to a small partial-credit point).
function scoreHistoricalMove(medianMovePct: number | null, emPct: number | null): number {
  if (medianMovePct === null || emPct === null || emPct <= 0) return 0;
  const ratio = medianMovePct / emPct;
  if (ratio < 0.7) return 8;
  if (ratio < 0.85) return 5;
  if (ratio < 1.0) return 2;
  if (ratio < 1.2) return 1;
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

  // ---- DEBUG: SPOT-only validation dump (CRUSH inputs/intermediates). ----
  // NOTE: per-event implied move is NOT stored in EarningsMove — only `date`,
  // `actualMovePct`, `direction`. Ratio below uses the CURRENT weekly
  // IV-implied move (emPct) as denominator for every historical row, which
  // is the same denominator the median-vs-EM ratio uses in scoreHistoricalMove.
  if (sym === "SPOT") {
    const events = historicalMoves.map((m) => ({
      date: m.date,
      actualMovePct: m.actualMovePct,
      direction: m.direction,
      impliedMovePct_current: emPct,
      ratio_actualOverImplied: emPct && emPct > 0 ? m.actualMovePct / emPct : null,
    }));
    const crushRatio =
      medianMove !== null && emPct !== null && emPct > 0
        ? medianMove / emPct
        : null;
    const ratioGrade =
      crushRatio === null
        ? "—"
        : crushRatio < 0.7
          ? "A"
          : crushRatio < 0.85
            ? "B"
            : crushRatio < 1.0
              ? "C"
              : crushRatio < 1.2
                ? "D"
                : "F";
    console.log(
      "[DEBUG:SPOT crush] " +
        JSON.stringify(
          {
            historicalEventCount: historicalMoves.length,
            events,
            // Raw historical move array per spec — easy to eyeball.
            historicalMoves: movePcts,
            medianHistoricalMove: medianMove,
            currentImpliedMove: emPct,
            crushRatio,
            crushRatioGrade: ratioGrade,
            weeklyIv,
            monthlyIv,
            realizedVol30d: realizedVol,
            dte: candidate.daysToExpiry,
            scores: {
              historicalMoveScore,
              consistencyScore,
              termStructureScore,
              ivEdgeScore,
              surpriseScore,
              total: score,
              maxScore: 25,
              threshold,
              pass: score >= threshold,
              grade: gradeFromCrushScore(score),
            },
            gradeThresholds: "A>=18, B>=14, C>=10, else F",
            historicalMoveScoreRule:
              "ratio = medianMove/emPct: <0.7 => 8pts, <0.85 => 5pts, <1.0 => 2pts, <1.2 => 1pt, else 0",
            note: "Per-event impliedMove is not stored. crushRatio uses today's weekly IV-implied move for every event.",
          },
          null,
          2,
        ),
    );
  }

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

// Opportunity scoring is premium + delta only (20 pts max). Spread was
// removed — it's an execution-cost concern for day trades and doesn't
// affect overnight CSP holds. We still track bidAskSpreadPct for
// informational display in the expanded row, but it does not influence
// any grade, recommendation, or hard-kill.
function scorePremiumYield(yieldPct: number): number {
  if (yieldPct > 0.5) return 12;
  if (yieldPct >= 0.3) return 8;
  if (yieldPct >= 0.15) return 3;
  return 0;
}

function scoreDelta(delta: number): number {
  const abs = Math.abs(delta);
  if (abs >= 0.08 && abs <= 0.12) return 8;
  if (abs > 0.12 && abs <= 0.18) return 5;
  if (abs > 0.18 && abs <= 0.25) return 2;
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
  return best;
}

export function runStageFour(
  candidate: EarningsCandidate,
  chain: SchwabOptionsChain,
  medianHistoricalMovePct: number | null,
  emPct: number | null,
): StageFourResult {
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
      bidAskSpreadPct: null,
      premiumYieldPct: null,
      note: null,
      details: { premiumYieldScore: 0, deltaScore: 0, spreadScore: 0, contractSymbol: null },
    };
  }
  const contract = pickStrikeNearest(chain, candidate.expiry, suggestedStrike);

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
  const rawScore = premiumYieldScore + deltaScore;

  // Spread is no longer a hard-kill or scoring input. We still surface
  // bidAskSpreadPct as informational display in the expanded row.
  const opportunityGrade = gradeFromOpportunityScore(rawScore);
  const note: string | null = null;

  // Compact snapshot of the weekly put chain — the UI uses it to let
  // users try a custom strike without another API round-trip.
  const expKey = Object.keys(chain.putExpDateMap ?? {}).find((k) =>
    k.startsWith(candidate.expiry),
  );
  const availableStrikes: StageFourResult["availableStrikes"] = [];
  if (expKey) {
    for (const arr of Object.values(chain.putExpDateMap[expKey])) {
      for (const c of arr) {
        if (c.putCall && c.putCall !== "PUT") continue;
        const strikeMid = (c.bid + c.ask) / 2 || c.mark || c.last || 0;
        availableStrikes!.push({
          strike: c.strikePrice,
          bid: c.bid,
          ask: c.ask,
          mark: Math.round(strikeMid * 100) / 100,
          delta: Math.round(c.delta * 1000) / 1000,
        });
      }
    }
    availableStrikes!.sort((a, b) => a.strike - b.strike);
  }

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
    availableStrikes,
    details: {
      premiumYieldScore,
      deltaScore,
      // Kept at 0 for type compatibility — spread no longer scored.
      spreadScore: 0,
      contractSymbol: contract.symbol,
    },
  };
}

// Spread is no longer a hard-kill; retained as a display-only field on
// StageFourResult.bidAskSpreadPct. Helper always returns false so any
// remaining call short-circuits harmlessly.
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
  const dte = businessDaysBetween(seed, friday);
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
): ThreeLayerGrade {
  const crushGrade = stageThreeResult.crushGrade;
  const opportunityGrade = stageFourResult.opportunityGrade;

  const delta = stageFourResult.delta ?? 0;
  const probabilityOfProfit = 1 - Math.abs(delta);
  const premium = stageFourResult.premium ?? 0;
  const strike = stageFourResult.suggestedStrike ?? 0;
  const breakevenPrice = strike - premium;
  // EV per contract (dollars). The assignment-loss leg uses a realistic
  // 2× expected-move downside instead of "stock goes to zero", which
  // was the old proxy and made every CSP look terrible.
  //
  //   expectedDownsidePrice = currentPrice × (1 − emPct × 2)
  //   assignmentLoss        = max(strike − expectedDownsidePrice, 0) × 100
  //   EV                    = POP × premium × 100 − (1 − POP) × assignmentLoss
  //
  // If the 2× downside still lands above the strike, assignmentLoss = 0
  // and EV collapses to POP × premium × 100 (pure premium expectation).
  const emPct = stageThreeResult.details.expectedMovePct ?? 0;
  const expectedDownsidePrice =
    currentPrice > 0 ? currentPrice * (1 - emPct * 2) : 0;
  const assignmentLoss =
    currentPrice > 0
      ? Math.max(strike - expectedDownsidePrice, 0) * 100
      : strike * 100; // pre-currentPrice fallback keeps old behaviour
  const expectedValue =
    probabilityOfProfit * premium * 100 - (1 - probabilityOfProfit) * assignmentLoss;

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

  const history = personalHistory ?? {
    tradeCount: 0,
    winRate: null,
    avgRoc: null,
    dataInsufficient: true,
  };
  let personalGrade: Grade | "INSUFFICIENT" = "INSUFFICIENT";
  if (!history.dataInsufficient && history.winRate !== null) {
    const wr = history.winRate;
    const roc = history.avgRoc ?? 0;
    if (wr > 80 && roc > 0.4) personalGrade = "A";
    else if (wr >= 60) personalGrade = "B";
    else if (wr >= 50) personalGrade = "C";
    else personalGrade = "F";
  }

  // ---- Final grade: rule cascade ----
  let finalGrade: Grade;
  let matchedRule: "A" | "B" | "C" | "F";
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
    finalGrade = "B";
    matchedRule = "B";
  } else if (probabilityOfProfit >= 0.75 && penalty > -15) {
    finalGrade = "C";
    matchedRule = "C";
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

  // Personal history modifier: only when we have 5+ trades.
  let personalModifier: "boost" | "drop" | null = null;
  if (!history.dataInsufficient && history.winRate !== null && !hasOverhang) {
    const wr = history.winRate;
    const roc = history.avgRoc ?? 0;
    if (wr > 80 && roc > 0.4) {
      personalModifier = "boost";
      finalGrade = boostGrade(finalGrade);
    } else if (wr < 50) {
      personalModifier = "drop";
      finalGrade = dropGrade(finalGrade);
    }
  }

  // Derived illustrative scores (for sort order + display compatibility).
  const industryScore = gradeToL1Score(industryGrade);
  const regimeScore = gradeToL3Score(regimeGrade);
  const personalScore =
    personalGrade === "INSUFFICIENT" ? null : gradeToL2Score(personalGrade);
  const finalScore = gradeToFinalScore(finalGrade);

  let recommendation = "Skip";
  if (finalGrade === "A") recommendation = "Strong - Take the trade";
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
    cautions.push(
      `Crush F — historical moves have consistently exceeded expectations, implied-vol crush less reliable.`,
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
    const mod =
      personalModifier === "boost"
        ? " → boosts grade one level (winRate >80% & avgRoc >0.4%)"
        : personalModifier === "drop"
          ? " → drops grade one level (winRate <50%)"
          : " → no modifier (between boost/drop thresholds)";
    historyLines.push(
      `${history.tradeCount} prior trades: ${wr.toFixed(0)}% win rate, ${roc.toFixed(2)}% avg ROC${mod}.`,
    );
  } else {
    historyLines.push(
      `Insufficient history — ${history.tradeCount} closed trades on this ticker (need 5+). No modifier applied.`,
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
    overrideBits.push("Personal history boost (win rate >80%, avg ROC >0.4%) → +1 level.");
  } else if (personalModifier === "drop") {
    overrideBits.push("Personal history drop (win rate <50%) → −1 level.");
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
    },
    personalGrade,
    personalScore,
    personalFactors: {
      tickerWinRate: history.winRate,
      tickerTradeCount: history.tradeCount,
      tickerAvgRoc: history.avgRoc,
      tickerCrushAccuracy: null,
      dataInsufficient: history.dataInsufficient,
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
    finalScore,
    recommendation,
    recommendationReason,
  };
}

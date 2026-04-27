import { calculateThreeLayerGrade } from "../lib/screener";
import type { StageThreeResult, StageFourResult } from "../lib/screener";
import type { PerplexityNewsResult } from "../lib/perplexity";

const s3: StageThreeResult = {
  score: 22, maxScore: 25, pass: true, crushGrade: "A", threshold: 12, insufficientData: false,
  details: { historicalMoveScore: 5, consistencyScore: 4, termStructureScore: 3, ivEdgeScore: 4, surpriseScore: 4, medianHistoricalMovePct: 0.045, expectedMovePct: 0.053, weeklyIv: 0.45, monthlyIv: 0.32, realizedVol30d: 0.32 },
};
const s4: StageFourResult = {
  score: 11, maxScore: 20, opportunityGrade: "C",
  suggestedStrike: 312, premium: 0.74, delta: -0.09, bidAskSpreadPct: 3.5, premiumYieldPct: 0.22, note: null,
  details: { premiumYieldScore: 3, deltaScore: 8, spreadScore: 0, contractSymbol: "AXP" },
};
const news: PerplexityNewsResult = {
  summary: "Strong Q1 2026 earnings expected, 9.7% YoY growth.", sentiment: "positive",
  hasActiveOverhang: false, overhangDescription: null, sources: [], gradePenalty: 0,
};
const hist = { tradeCount: 0, winRate: null, avgRoc: null, dataInsufficient: true };
const g = calculateThreeLayerGrade(s3, s4, news, hist, 18);
console.log("finalGrade:", g.finalGrade, "finalScore:", g.finalScore);
console.log("\n=== recommendationReason ===\n");
console.log(g.recommendationReason);

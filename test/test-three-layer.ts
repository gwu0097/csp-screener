// Unit test for calculateThreeLayerGrade. Feeds mocked Stage3/Stage4/news/
// personal-history inputs and asserts the rule-based grade cascade.
// Run: env -u GEMINI_API_KEY -u PERPLEXITY_API_KEY node --env-file=.env.local --import=tsx test/test-three-layer.ts
import { calculateThreeLayerGrade } from "../lib/screener";
import type { StageThreeResult, StageFourResult } from "../lib/screener";
import type { PerplexityNewsResult } from "../lib/perplexity";

function mockStage3(crushGrade: "A" | "B" | "C" | "F", insufficient = false): StageThreeResult {
  return {
    score: crushGrade === "A" ? 22 : crushGrade === "B" ? 17 : crushGrade === "C" ? 14 : 10,
    maxScore: 25,
    pass: crushGrade !== "F",
    crushGrade,
    threshold: 12,
    insufficientData: insufficient,
    details: {
      historicalMoveScore: 5,
      consistencyScore: 4,
      termStructureScore: 3,
      ivEdgeScore: 4,
      surpriseScore: 4,
      medianHistoricalMovePct: 0.06,
      expectedMovePct: 0.07,
      weeklyIv: 0.45,
      monthlyIv: 0.32,
      realizedVol30d: 0.32,
    },
  };
}

function mockStage4(opp: "A" | "B" | "C" | "F", delta = -0.15): StageFourResult {
  return {
    score: opp === "A" ? 18 : opp === "B" ? 15 : opp === "C" ? 11 : 5,
    maxScore: 20,
    opportunityGrade: opp,
    suggestedStrike: 325,
    premium: 0.5,
    delta,
    bidAskSpreadPct: 3.5,
    premiumYieldPct: 0.35,
    note: null,
    details: {
      premiumYieldScore: 5,
      deltaScore: 6,
      spreadScore: 4,
      contractSymbol: "TEST",
    },
  };
}

function mockNews(
  sentiment: "positive" | "negative" | "neutral",
  overhang = false,
): PerplexityNewsResult {
  return {
    summary: sentiment === "negative" ? "Tough quarter expected" : "Steady outlook",
    sentiment,
    hasActiveOverhang: overhang,
    overhangDescription: overhang ? "DOJ antitrust probe opened" : null,
    sources: [],
    gradePenalty: overhang ? -15 : sentiment === "negative" ? -5 : 0,
  };
}

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  ✓ ${label}`);
    passed += 1;
  } else {
    console.log(`  ✗ ${label} ${detail ?? ""}`);
    failed += 1;
  }
}

// -------- Case 1: crush A, POP 85%, strong personal, calm VIX --------
// Rule A fails (POP <0.88), Rule B matches (POP ≥0.83, crush A/B).
// Personal boost (wr>80, roc>0.4) lifts B → A.
console.log("\n=== Case 1: crush A, POP 85%, strong personal, calm VIX → A ===");
{
  const g = calculateThreeLayerGrade(
    mockStage3("A"),
    mockStage4("B"),
    mockNews("neutral"),
    { tradeCount: 12, winRate: 85, avgRoc: 0.6, dataInsufficient: false },
    18,
  );
  console.log(`  industry=${g.industryGrade} personal=${g.personalGrade} regime=${g.regimeGrade} final=${g.finalGrade}`);
  check("industryGrade = B (POP 0.85 < 0.88)", g.industryGrade === "B");
  check("crushGrade preserved = A", g.industryFactors.crushGrade === "A");
  check("personalGrade = A (wr>80 & roc>0.4)", g.personalGrade === "A", `got ${g.personalGrade}`);
  check("regimeGrade = A (neutral, calm VIX)", g.regimeGrade === "A");
  check("no gradePenalty", g.regimeFactors.gradePenalty === 0);
  check("finalGrade A (Rule B + personal boost)", g.finalGrade === "A");
  check("recommendation is Strong", g.recommendation.startsWith("Strong"));
  check("probabilityOfProfit ≈ 0.85", Math.abs(g.industryFactors.probabilityOfProfit - 0.85) < 0.001);
  check("breakeven = 325 − 0.5 = 324.5", g.industryFactors.breakevenPrice === 324.5);
  check("reason mentions Rule B matched", g.recommendationReason.includes("Rule B matched"));
  check("reason mentions personal boost", g.recommendationReason.toLowerCase().includes("boost"));
}

// -------- Case 2: active overhang → override to F --------
console.log("\n=== Case 2: B crush, active overhang → F override ===");
{
  const g = calculateThreeLayerGrade(
    mockStage3("B"),
    mockStage4("B"),
    mockNews("negative", true),
    { tradeCount: 8, winRate: 75, avgRoc: 0.4, dataInsufficient: false },
    18,
  );
  console.log(`  industry=${g.industryGrade} personal=${g.personalGrade} regime=${g.regimeGrade} final=${g.finalGrade}`);
  check("overhang flagged", g.regimeFactors.hasActiveOverhang === true);
  check("regimeGrade = F on overhang", g.regimeGrade === "F");
  check("gradePenalty = -15", g.regimeFactors.gradePenalty === -15);
  check("finalGrade = F (overhang override)", g.finalGrade === "F");
  check("recommendation = Skip", g.recommendation === "Skip");
  check("reason mentions overhang", g.recommendationReason.toLowerCase().includes("overhang"));
}

// -------- Case 3: insufficient personal history --------
console.log("\n=== Case 3: A/A industry but only 2 trades on ticker ===");
{
  const g = calculateThreeLayerGrade(
    mockStage3("A"),
    mockStage4("A"),
    mockNews("neutral"),
    { tradeCount: 2, winRate: 100, avgRoc: 0.3, dataInsufficient: true },
    18,
  );
  console.log(`  industry=${g.industryGrade} personal=${g.personalGrade} final=${g.finalGrade}`);
  check("personalGrade = INSUFFICIENT", g.personalGrade === "INSUFFICIENT");
  check("personalScore = null", g.personalScore === null);
  check("personalFactors.dataInsufficient = true", g.personalFactors.dataInsufficient === true);
  check("reason mentions insufficient history", g.recommendationReason.toLowerCase().includes("insufficient"));
  check("no personal modifier applied (finalGrade = B since POP 0.85 < 0.88)", g.finalGrade === "B");
}

// -------- Case 4: VIX panic (35) drops grade one level --------
console.log("\n=== Case 4: VIX 35 drops the grade ===");
{
  const g = calculateThreeLayerGrade(
    mockStage3("A"),
    mockStage4("A"),
    mockNews("neutral"),
    { tradeCount: 10, winRate: 90, avgRoc: 0.5, dataInsufficient: false },
    35,
  );
  console.log(`  regime=${g.regimeGrade} vixRegime=${g.regimeFactors.vixRegime} final=${g.finalGrade}`);
  check("vixRegime = panic", g.regimeFactors.vixRegime === "panic");
  check("regimeGrade = F (VIX > 30)", g.regimeGrade === "F");
  // Rule B matches (POP 0.85, crushOk). VIX > 30 drops B → C. Personal boost lifts C → B.
  check("finalGrade = B (B→C VIX drop, then personal boost)", g.finalGrade === "B");
  check("reason mentions VIX override", g.recommendationReason.toLowerCase().includes("vix"));
}

// -------- Case 5: VIX elevated (22) — no drop override --------
console.log("\n=== Case 5: VIX 22 (elevated) — no drop, personal boost applies ===");
{
  const g = calculateThreeLayerGrade(
    mockStage3("A"),
    mockStage4("A"),
    mockNews("neutral"),
    { tradeCount: 10, winRate: 90, avgRoc: 0.5, dataInsufficient: false },
    22,
  );
  console.log(`  regime=${g.regimeGrade} vixRegime=${g.regimeFactors.vixRegime} final=${g.finalGrade}`);
  check("vixRegime = elevated", g.regimeFactors.vixRegime === "elevated");
  check("regimeGrade = B (vix 20-25)", g.regimeGrade === "B");
  // Rule A needs VIX < 25 — passes at 22 but POP 0.85 < 0.88. Rule B matches.
  // No VIX override (not >30). Personal boost → A.
  check("finalGrade = A (Rule B + boost)", g.finalGrade === "A");
}

// -------- Case 6: Rule A hits directly (POP 92%, crush A, oppB, calm VIX) --------
console.log("\n=== Case 6: Rule A match (POP 92%, crush A, oppB, no overhang) ===");
{
  const g = calculateThreeLayerGrade(
    mockStage3("A"),
    mockStage4("B", -0.08),
    mockNews("neutral"),
    null,
    18,
  );
  console.log(`  final=${g.finalGrade}`);
  check("Rule A matches (POP 0.92 ≥ 0.90)", g.finalGrade === "A");
  check("industryGrade = A", g.industryGrade === "A");
  check("reason mentions Rule A matched", g.recommendationReason.includes("Rule A matched"));
}

// -------- Case 6b: POP 0.89 just under the Rule A floor → Rule B --------
console.log("\n=== Case 6b: POP 89%, crush A → Rule B (just below Rule A POP 0.90 floor) ===");
{
  const g = calculateThreeLayerGrade(
    mockStage3("A"),
    mockStage4("B", -0.11),
    mockNews("neutral"),
    null,
    18,
  );
  console.log(`  final=${g.finalGrade}`);
  check("finalGrade = B (POP 0.89 < 0.90)", g.finalGrade === "B");
}

// -------- Case 7: crush F but POP 0.96 → Rule B (POP ≥ 0.95 carve-out) --------
console.log("\n=== Case 7: crush F + POP 96% → Rule B (POP≥0.95 carve-out) ===");
{
  const g = calculateThreeLayerGrade(
    mockStage3("F"),
    mockStage4("B", -0.04),
    mockNews("neutral"),
    null,
    18,
  );
  console.log(`  final=${g.finalGrade}`);
  check("Rule B matches on POP ≥ 0.95 despite crush F", g.finalGrade === "B");
}

// -------- Case 7b: crush F + POP 0.92 now falls to C (carve-out is 0.95) --------
console.log("\n=== Case 7b: crush F + POP 92% → Rule C (below 0.95 carve-out) ===");
{
  const g = calculateThreeLayerGrade(
    mockStage3("F"),
    mockStage4("B", -0.08),
    mockNews("neutral"),
    null,
    18,
  );
  console.log(`  final=${g.finalGrade}`);
  check("finalGrade = C (crush F and POP 0.92 < 0.95)", g.finalGrade === "C");
}

// -------- Case 8: POP 0.80 + crush F → falls to C (Rule C) --------
console.log("\n=== Case 8: POP 80% crush F → Rule C ===");
{
  const g = calculateThreeLayerGrade(
    mockStage3("F"),
    mockStage4("B", -0.2),
    mockNews("neutral"),
    null,
    18,
  );
  console.log(`  final=${g.finalGrade}`);
  check("Rule C matches (POP 0.80 ≥ 0.75, penalty > -15)", g.finalGrade === "C");
}

// -------- Case 9: POP 0.70 → Rule F (no match) --------
console.log("\n=== Case 9: POP 70% → Rule F ===");
{
  const g = calculateThreeLayerGrade(
    mockStage3("A"),
    mockStage4("A", -0.3),
    mockNews("neutral"),
    null,
    18,
  );
  console.log(`  final=${g.finalGrade}`);
  check("finalGrade = F (POP < 0.75)", g.finalGrade === "F");
}

console.log(`\n=== Summary: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);

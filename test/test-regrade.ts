// Replays the new three-layer scoring against production's analyzed
// results. Reads /tmp/analyzed.json (snapshot of current production
// analyze output), strips the old threeLayer, recomputes with the
// LOCAL calculateThreeLayerGrade (which has the new scoring), and
// prints the comparison table.
//
// Run: env -u GEMINI_API_KEY -u PERPLEXITY_API_KEY node --env-file=.env.local --import=tsx test/test-regrade.ts
import fs from "node:fs";
import { calculateThreeLayerGrade } from "../lib/screener";
import type { PerplexityNewsResult } from "../lib/perplexity";

type AnalyzedResponse = {
  results: Array<{
    symbol: string;
    stageThree: Parameters<typeof calculateThreeLayerGrade>[0] | null;
    stageFour: Parameters<typeof calculateThreeLayerGrade>[1] | null;
    threeLayer: {
      finalGrade: string;
      finalScore: number;
      industryScore: number;
      personalScore: number | null;
      regimeScore: number;
      industryFactors: { probabilityOfProfit: number; ivEdge: number };
      regimeFactors: {
        newsSentiment: "positive" | "negative" | "neutral";
        hasActiveOverhang: boolean;
        overhangDescription: string | null;
        newsSummary: string;
        gradePenalty: number;
        vix: number | null;
      };
    } | null;
  }>;
};

function main() {
  const raw = fs.readFileSync("/tmp/analyzed.json", "utf8");
  const data = JSON.parse(raw) as AnalyzedResponse;
  const results = data.results;

  // Header
  const hdr = `${"SYM".padEnd(6)} ${"oldGr".padStart(5)} ${"newGr".padStart(5)}   ${"oldS".padStart(4)} ${"newS".padStart(4)}   ${"L1".padStart(3)} ${"L2".padStart(3)} ${"L3".padStart(3)}   ${"POP".padStart(4)} ${"popPts".padStart(6)} ${"ivEdge".padStart(6)} ${"ivPts".padStart(5)} ${"crush".padStart(5)} ${"opp".padStart(3)}`;
  console.log(hdr);
  console.log("-".repeat(hdr.length));

  const gradeCount = { A: 0, B: 0, C: 0, F: 0 };

  // Sort by new finalScore desc so the output reads like a real ranking.
  const enriched = results.map((r) => {
    if (!r.stageThree || !r.stageFour || !r.threeLayer) return null;
    const rf = r.threeLayer.regimeFactors;
    const news: PerplexityNewsResult = {
      summary: rf.newsSummary,
      sentiment: rf.newsSentiment,
      hasActiveOverhang: rf.hasActiveOverhang,
      overhangDescription: rf.overhangDescription,
      sources: [],
      gradePenalty: rf.gradePenalty,
    };
    const personal = { tradeCount: 0, winRate: null, avgRoc: null, dataInsufficient: true };
    const newTl = calculateThreeLayerGrade(
      r.stageThree,
      r.stageFour,
      news,
      personal,
      rf.vix,
    );
    return { r, newTl };
  }).filter((x): x is NonNullable<typeof x> => x !== null);

  enriched.sort((a, b) => b.newTl.finalScore - a.newTl.finalScore);

  for (const { r, newTl } of enriched) {
    const iff = newTl.industryFactors;
    const s3 = r.stageThree!;
    const s4 = r.stageFour!;
    const oldTl = r.threeLayer!;
    const newGrade = newTl.finalGrade as "A" | "B" | "C" | "F";
    gradeCount[newGrade] += 1;

    // Recompute popPts / ivEdgePts for display — mirror the scoring buckets.
    const pop = iff.probabilityOfProfit;
    let popPts = 0;
    if (pop >= 0.95) popPts = 25;
    else if (pop >= 0.9) popPts = 22;
    else if (pop >= 0.85) popPts = 18;
    else if (pop >= 0.8) popPts = 12;
    else if (pop >= 0.75) popPts = 5;
    const ivEdge = iff.ivEdge;
    let ivPts = 0;
    if (ivEdge >= 1.3 && ivEdge < 1.6) ivPts = 15;
    else if (ivEdge >= 1.6 && ivEdge < 2.0) ivPts = 13;
    else if (ivEdge >= 2.0) ivPts = 10;
    else if (ivEdge >= 1.2 && ivEdge < 1.3) ivPts = 8;

    const row = [
      r.symbol.padEnd(6),
      oldTl.finalGrade.padStart(5),
      newGrade.padStart(5),
      "  ",
      oldTl.finalScore.toFixed(0).padStart(4),
      newTl.finalScore.toFixed(0).padStart(4),
      "  ",
      newTl.industryScore.toFixed(0).padStart(3),
      String(newTl.personalScore ?? 8).padStart(3),
      newTl.regimeScore.toFixed(0).padStart(3),
      "  ",
      `${(pop * 100).toFixed(0)}%`.padStart(4),
      String(popPts).padStart(6),
      ivEdge.toFixed(2).padStart(6),
      String(ivPts).padStart(5),
      // biome-ignore lint/suspicious/noExplicitAny: stageThree is any-ish above
      String((s3 as any).crushGrade).padStart(5),
      // biome-ignore lint/suspicious/noExplicitAny:
      String((s4 as any).opportunityGrade).padStart(3),
    ].join(" ");
    console.log(row);
  }

  console.log();
  console.log(
    `Distribution:  A=${gradeCount.A}  B=${gradeCount.B}  C=${gradeCount.C}  F=${gradeCount.F}`,
  );
}

main();

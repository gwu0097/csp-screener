// READ-ONLY: outcome-scores old vs new crushGrade against REALIZED
// move ratios for every persisted candidate whose own earnings event
// has since resolved. No writes, no deploy, no threshold changes.
//
// Usage: npx tsx --env-file=.env.local --tsconfig tsconfig.json scripts/score-crush-grade-outcomes.ts
//
// Input: scratchpad/crush_outcomes_join.json — a SQL join (symbol,
// earnings_date, dte, old_grade, weekly_iv, monthly_iv, crush_history,
// actual_move_pct, implied_move_pct, move_ratio, iv_crush_magnitude,
// iv_crushed, is_complete) pulled directly via the Supabase Management
// API, one row per deduped (symbol, earningsDate) persisted candidate,
// LEFT JOINed to that SAME event's own earnings_history row (its
// realized outcome, not the historical quarters used to grade it).

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { getHistoricalEarningsMovements, type EarningsMove } from "@/lib/yahoo";
import { getEarningsSurpriseHistory } from "@/lib/earnings";
import { computeCrushComposite } from "@/lib/screener";
import { getPopulationPriorMoveRatio, type CrushHistoryEvent } from "@/lib/earnings-history-table";

let POPULATION_PRIOR_RATIO = 1.0;

const JOIN_PATH = resolve(
  "/private/tmp/claude-501/-Users-raitsai-csp-screener/ab3c3900-236c-448e-8535-85d682a53a99/scratchpad/crush_outcomes_join.json",
);
const SNAPSHOT_PATH = resolve(
  "/private/tmp/claude-501/-Users-raitsai-csp-screener/ab3c3900-236c-448e-8535-85d682a53a99/scratchpad/crush-validation-yahoo-snapshot.json",
);

type JoinRow = {
  symbol: string;
  earnings_date: string;
  dte: number;
  old_grade: "A" | "B" | "C" | "F" | null;
  weekly_iv: string | null;
  monthly_iv: string | null;
  realized_vol: string | null;
  crush_history: CrushHistoryEvent[] | null;
  actual_move_pct: string | null;
  implied_move_pct: string | null;
  move_ratio: string | null;
  iv_crush_magnitude: string | null;
  iv_crushed: boolean | null;
  is_complete: boolean | null;
};

type ScoredRow = {
  symbol: string;
  earningsDate: string;
  oldGrade: string;
  newGrade: string;
  moveRatio: number;
  breached2xEm: boolean; // move_ratio implies actual > 2x implied
};

async function main() {
  const pop = await getPopulationPriorMoveRatio();
  POPULATION_PRIOR_RATIO = pop.median;
  console.log(`Population prior (median) move_ratio: ${pop.median.toFixed(4)} (n=${pop.n} valid pairs)\n`);

  if (!existsSync(JOIN_PATH)) {
    console.error(`Join file not found: ${JOIN_PATH}`);
    process.exit(1);
  }
  const rows = JSON.parse(readFileSync(JOIN_PATH, "utf8")) as JoinRow[];
  console.log(`Loaded ${rows.length} deduped (symbol, earningsDate) candidates.`);

  const yahooSnapshot: Record<string, EarningsMove[]> = existsSync(SNAPSHOT_PATH)
    ? JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8"))
    : {};
  console.log(`Pinned Yahoo snapshot: ${Object.keys(yahooSnapshot).length} symbols available.`);

  // ---- Step 1: resolved vs unresolved ----
  const resolved = rows.filter((r) => r.actual_move_pct !== null && r.implied_move_pct !== null);
  const unresolved = rows.length - resolved.length;
  console.log(`\nResolved (actual+implied both present): ${resolved.length}/${rows.length}. Unresolved (still pending): ${unresolved}.`);

  // ---- Step 2: contamination exclusion ----
  // Signature: near-zero actual_move_pct (< 1% abs) AND iv_crush_magnitude <= 0.
  // A T1 capture that ran same-session on an AMC name (or otherwise too
  // early) sees a still-uncertain, barely-moved price and flat-to-rising
  // IV — this is a pre-print snapshot, not a resolved outcome.
  const CONTAM_ACTUAL_THRESHOLD = 0.01;
  const isContaminated = (r: JoinRow): boolean => {
    const a = Math.abs(Number(r.actual_move_pct));
    const c = r.iv_crush_magnitude === null ? null : Number(r.iv_crush_magnitude);
    return a < CONTAM_ACTUAL_THRESHOLD && c !== null && c <= 0;
  };
  const contaminated = resolved.filter(isContaminated);
  const usable = resolved.filter((r) => !isContaminated(r));
  console.log(`Contaminated (near-zero actual AND iv_crush_magnitude<=0, threshold ${CONTAM_ACTUAL_THRESHOLD}): ${contaminated.length}`);
  console.log(`Usable resolved n = ${usable.length}`);
  console.log(`\nExcluded rows:`);
  for (const r of contaminated.sort((a, b) => a.symbol.localeCompare(b.symbol))) {
    console.log(`  ${r.symbol.padEnd(6)} ${r.earnings_date}  actual=${r.actual_move_pct}  ivCrushMag=${r.iv_crush_magnitude}`);
  }

  // ---- Step 3: recompute NEW grade for every row (all 116 — needed
  // for the gained/lost-A/B cross-check even on unresolved/excluded
  // rows), using the exact same methodology as the prior validation
  // pass: persisted crushHistory/weeklyIv/monthlyIv/dte, pinned Yahoo
  // snapshot (consistencyScore only), live (cached) Finnhub surprise.
  console.log(`\nRecomputing NEW grade for all ${rows.length} candidates...`);
  const scoredAll: Array<JoinRow & { newGrade: string; newScore: number; newMax: number }> = [];
  const CONCURRENCY = 6;
  let idx = 0;
  async function worker() {
    while (idx < rows.length) {
      const i = idx++;
      const r = rows[i];
      const historicalMoves = yahooSnapshot[r.symbol] ?? [];
      const surprise = await getEarningsSurpriseHistory(r.symbol).catch(() => ({
        surpriseScore: 0,
        beatsWithin5Pct: 0,
        quartersExamined: 0,
      }));
      const crushHistory = r.crush_history ?? [];
      const composite = computeCrushComposite({
        historicalMoves,
        crushHistory,
        earningsDate: r.earnings_date,
        dte: r.dte,
        weeklyIv: r.weekly_iv !== null ? Number(r.weekly_iv) : null,
        monthlyIv: r.monthly_iv !== null ? Number(r.monthly_iv) : null,
        realizedVol: r.realized_vol !== null ? Number(r.realized_vol) : null,
        surpriseScore: surprise.surpriseScore,
        surpriseQuartersExamined: surprise.quartersExamined,
        populationPriorRatio: POPULATION_PRIOR_RATIO,
      });
      // newGrade is the composite grade with no further modifier — since
      // 3049066, computeVerifiedModifier/applyGradeModifier are no longer
      // applied to the live crushGrade (kept as an inert diagnostic only),
      // so "new" here must match that, not fold the modifier back in.
      const newGrade = composite.crushGrade;
      scoredAll.push({ ...r, newGrade, newScore: composite.score, newMax: composite.maxScore });
      if ((i + 1) % 30 === 0) console.log(`  ...${i + 1}/${rows.length}`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  console.log(`Done.\n`);

  // ---- Build the usable-outcome scored set (resolved + not contaminated) ----
  const usableSymbols = new Set(usable.map((r) => `${r.symbol}:${r.earnings_date}`));
  const scored: ScoredRow[] = scoredAll
    .filter((r) => usableSymbols.has(`${r.symbol}:${r.earnings_date}`))
    .map((r) => {
      const moveRatio = Number(r.move_ratio ?? Math.abs(Number(r.actual_move_pct)) / Number(r.implied_move_pct));
      return {
        symbol: r.symbol,
        earningsDate: r.earnings_date,
        oldGrade: r.old_grade ?? "F",
        newGrade: r.newGrade,
        moveRatio,
        breached2xEm: moveRatio > 2.0,
      };
    });

  // ================ PART A: primary metric — A/B vs C/F, continuous ================
  console.log("================ PART A: primary metric (A/B vs C/F, continuous) ================\n");

  function stats(vals: number[]): { n: number; mean: number; median: number; sd: number; pctAbove1: number } {
    const n = vals.length;
    if (n === 0) return { n: 0, mean: NaN, median: NaN, sd: NaN, pctAbove1: NaN };
    const mean = vals.reduce((s, v) => s + v, 0) / n;
    const sorted = [...vals].sort((a, b) => a - b);
    const median = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
    const sd = n > 1 ? Math.sqrt(vals.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1)) : NaN;
    const pctAbove1 = vals.filter((v) => v > 1.0).length / n;
    return { n, mean, median, sd, pctAbove1 };
  }
  function fmtStats(s: ReturnType<typeof stats>): string {
    if (s.n === 0) return "n=0 (no data)";
    return `n=${s.n}  mean=${s.mean.toFixed(3)}  median=${s.median.toFixed(3)}  sd=${Number.isNaN(s.sd) ? "n/a" : s.sd.toFixed(3)}  %>1.0=${(s.pctAbove1 * 100).toFixed(0)}%`;
  }

  for (const version of ["old", "new"] as const) {
    const gradeOf = (r: ScoredRow) => (version === "old" ? r.oldGrade : r.newGrade);
    const abGroup = scored.filter((r) => gradeOf(r) === "A" || gradeOf(r) === "B");
    const cfGroup = scored.filter((r) => gradeOf(r) === "C" || gradeOf(r) === "F");
    const abStats = stats(abGroup.map((r) => r.moveRatio));
    const cfStats = stats(cfGroup.map((r) => r.moveRatio));
    const breachAB = abGroup.filter((r) => r.breached2xEm).length;
    const breachCF = cfGroup.filter((r) => r.breached2xEm).length;
    console.log(`--- ${version.toUpperCase()} grades ---`);
    console.log(`  A/B: ${fmtStats(abStats)}   2xEM breach: ${breachAB}/${abGroup.length}`);
    console.log(`  C/F: ${fmtStats(cfStats)}   2xEM breach: ${breachCF}/${cfGroup.length}`);
    const gap = cfStats.mean - abStats.mean;
    console.log(`  GAP (C/F mean - A/B mean) = ${Number.isNaN(gap) ? "n/a" : gap.toFixed(3)}`);
    console.log("");
  }

  {
    const gapFor = (version: "old" | "new") => {
      const gradeOf = (r: ScoredRow) => (version === "old" ? r.oldGrade : r.newGrade);
      const ab = stats(scored.filter((r) => gradeOf(r) === "A" || gradeOf(r) === "B").map((r) => r.moveRatio));
      const cf = stats(scored.filter((r) => gradeOf(r) === "C" || gradeOf(r) === "F").map((r) => r.moveRatio));
      return cf.mean - ab.mean;
    };
    const oldGap = gapFor("old");
    const newGap = gapFor("new");
    console.log(`--- PRIMARY QUESTION: is the new gap wider than the old? ---`);
    console.log(`  OLD gap: ${oldGap.toFixed(3)}`);
    console.log(`  NEW gap: ${newGap.toFixed(3)}`);
    console.log(`  Difference (NEW - OLD): ${(newGap - oldGap >= 0 ? "+" : "") + (newGap - oldGap).toFixed(3)}`);
    console.log(`  ${newGap > oldGap ? "NEW gap is WIDER — better separation." : newGap < oldGap ? "NEW gap is NARROWER — worse separation." : "Gap unchanged."}\n`);
  }

  // ================ PART B: per-letter breakdown ================
  console.log("================ PART B: per-letter breakdown ================\n");
  for (const version of ["old", "new"] as const) {
    const gradeOf = (r: ScoredRow) => (version === "old" ? r.oldGrade : r.newGrade);
    console.log(`--- ${version.toUpperCase()} ---`);
    const letters: Array<"A" | "B" | "C" | "F"> = ["A", "B", "C", "F"];
    let prevMean: number | null = null;
    for (const letter of letters) {
      const group = scored.filter((r) => gradeOf(r) === letter);
      const s = stats(group.map((r) => r.moveRatio));
      const monotonic = prevMean === null || Number.isNaN(s.mean) || s.mean >= prevMean;
      console.log(`  ${letter}: ${fmtStats(s)}${!monotonic ? "  <-- NON-MONOTONIC (mean did not rise vs previous letter)" : ""}`);
      if (!Number.isNaN(s.mean)) prevMean = s.mean;
    }
    console.log("");
  }

  // ================ PART C: gained/lost A/B check ================
  console.log("================ PART C: gained/lost A/B, checked against realized outcome ================\n");
  const isAB = (g: string) => g === "A" || g === "B";
  const lostAB = scoredAll.filter((r) => isAB(r.old_grade ?? "F") && !isAB(r.newGrade));
  const gainedAB = scoredAll.filter((r) => !isAB(r.old_grade ?? "F") && isAB(r.newGrade));
  console.log(`Lost A/B (old A/B -> new C/F): ${lostAB.length} total candidates (any resolution status)`);
  const lostABUsable = lostAB.filter((r) => usableSymbols.has(`${r.symbol}:${r.earnings_date}`));
  const lostABAbove1 = lostABUsable.filter((r) => Number(r.move_ratio) > 1.0);
  console.log(
    `  Of those, ${lostABUsable.length} have a usable realized outcome. Of THOSE, ${lostABAbove1.length}/${lostABUsable.length} ` +
      `(${lostABUsable.length > 0 ? ((lostABAbove1.length / lostABUsable.length) * 100).toFixed(0) : "n/a"}%) had realized move_ratio > 1.0.`,
  );
  const baseRateAbove1 = scored.filter((r) => r.moveRatio > 1.0).length / scored.length;
  console.log(`  Base rate across the full usable population: ${scored.filter((r) => r.moveRatio > 1.0).length}/${scored.length} (${(baseRateAbove1 * 100).toFixed(0)}%).`);
  console.log(`  Comparison: ${lostABUsable.length > 0 ? (lostABAbove1.length / lostABUsable.length > baseRateAbove1 ? "losers have a HIGHER >1.0 rate than base — consistent with them being correctly downgraded" : "losers have a LOWER OR EQUAL >1.0 rate than base — inconsistent with the downgrade being outcome-justified") : "n/a — no usable losers"}`);
  console.log(`  Individual usable losers:`);
  for (const r of lostABUsable.sort((a, b) => a.symbol.localeCompare(b.symbol))) {
    console.log(`    ${r.symbol.padEnd(6)} ${r.earnings_date}  ${r.old_grade} -> ${r.newGrade}  move_ratio=${Number(r.move_ratio).toFixed(3)}`);
  }

  console.log(`\nGained A/B (old C/F -> new A/B): ${gainedAB.length} total candidates`);
  for (const r of gainedAB) {
    const hasOutcome = usableSymbols.has(`${r.symbol}:${r.earnings_date}`);
    const contam = resolved.some((x) => x.symbol === r.symbol && x.earnings_date === r.earnings_date && isContaminated(x));
    const outcomeStr = hasOutcome
      ? `move_ratio=${Number(r.move_ratio).toFixed(3)}`
      : contam
        ? "resolved but CONTAMINATED (excluded)"
        : "not yet resolved";
    console.log(`  ${r.symbol.padEnd(6)} ${r.earnings_date}  ${r.old_grade} -> ${r.newGrade}  ${outcomeStr}`);
  }

  // ================ PART D: sample adequacy ================
  console.log("\n================ PART D: sample adequacy ================\n");
  const MIN_N = 10;
  for (const version of ["old", "new"] as const) {
    const gradeOf = (r: ScoredRow) => (version === "old" ? r.oldGrade : r.newGrade);
    console.log(`--- ${version.toUpperCase()} ---`);
    for (const letter of ["A", "B", "C", "F"] as const) {
      const n = scored.filter((r) => gradeOf(r) === letter).length;
      console.log(`  ${letter}: n=${n}${n < MIN_N ? `  <-- BELOW ${MIN_N}, mean not reportable as conclusive` : ""}`);
    }
    const abN = scored.filter((r) => isAB(gradeOf(r))).length;
    const cfN = scored.filter((r) => !isAB(gradeOf(r))).length;
    console.log(`  A/B combined: n=${abN}${abN < MIN_N ? "  <-- BELOW " + MIN_N : ""}`);
    console.log(`  C/F combined: n=${cfN}${cfN < MIN_N ? "  <-- BELOW " + MIN_N : ""}`);
    console.log("");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

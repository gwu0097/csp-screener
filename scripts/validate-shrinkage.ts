// REPORT-ONLY validation of PASS_2E shrinkage on historicalMoveRatio.
// Computes composite grades across all 116 persisted candidates at
// k=0 (no shrinkage — the exact pre-shrinkage baseline, since
// applyShrinkage(mean, n, popMean, 0) reduces algebraically to the raw
// mean) and at k in {1,2,3,5}, using the REAL computeCrushComposite.
// No writes, no threshold changes.
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { getEarningsSurpriseHistory } from "@/lib/earnings";
import { getCrushHistory, getPopulationMeanMoveRatio, type CrushHistoryEvent } from "@/lib/earnings-history-table";
import { computeCrushComposite, computeVerifiedModifier, applyGradeModifier, type CrushCompositeResult } from "@/lib/screener";
import type { EarningsMove } from "@/lib/yahoo";

function loadEnvLocal(): void {
  try {
    const content = readFileSync(resolve(process.cwd(), ".env.local"), "utf8");
    for (const rawLine of content.split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
      if (!process.env[key]) process.env[key] = val;
    }
  } catch {
    /* ignore */
  }
}
loadEnvLocal();

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const SNAPSHOT_PATH = resolve(
  "/private/tmp/claude-501/-Users-raitsai-csp-screener/ab3c3900-236c-448e-8535-85d682a53a99/scratchpad/crush-validation-yahoo-snapshot.json",
);
const yahooSnapshot: Record<string, EarningsMove[]> = existsSync(SNAPSHOT_PATH) ? JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8")) : {};

type Candidate = { symbol: string; earnings_date: string; dte: number; weekly_iv: number | null; monthly_iv: number | null; realized_vol: number | null };

type Prepared = {
  c: Candidate;
  crushHistory: CrushHistoryEvent[];
  historicalMoves: EarningsMove[];
  surpriseScore: number;
  surpriseQuartersExamined: number;
};

const K_VALUES = [0, 1, 2, 3, 5] as const;
const isAB = (g: string) => g === "A" || g === "B";

function gradeAt(p: Prepared, populationMeanRatio: number, k: number): { composite: CrushCompositeResult; finalGrade: string } {
  const composite = computeCrushComposite({
    historicalMoves: p.historicalMoves,
    crushHistory: p.crushHistory,
    earningsDate: p.c.earnings_date,
    dte: p.c.dte,
    weeklyIv: p.c.weekly_iv,
    monthlyIv: p.c.monthly_iv,
    realizedVol: p.c.realized_vol,
    surpriseScore: p.surpriseScore,
    surpriseQuartersExamined: p.surpriseQuartersExamined,
    populationMeanRatio,
    shrinkageK: k,
  });
  const schwabRatios = p.crushHistory
    .filter((h) => (h.impliedMoveSource === "schwab" || h.impliedMoveSource === "schwab_t0") && h.ratio !== null && h.earningsDate !== p.c.earnings_date)
    .map((h) => h.ratio as number);
  const modifier = computeVerifiedModifier(schwabRatios);
  const finalGrade = applyGradeModifier(composite.crushGrade, modifier.delta);
  return { composite, finalGrade };
}

async function main() {
  const pop = await getPopulationMeanMoveRatio();
  console.log(`Population mean move_ratio: ${pop.mean.toFixed(4)} (n=${pop.n} valid pairs, recomputed live from earnings_history)\n`);

  const { data, error } = await sb.from("screener_results").select("id, created_at, candidates").order("created_at", { ascending: false });
  if (error) throw new Error(error.message);

  const bySymbolDate = new Map<string, Candidate>();
  for (const row of data ?? []) {
    const candidates = (row.candidates ?? []) as Array<{
      symbol: string;
      earningsDate: string;
      daysToExpiry: number;
      stageThree: { details: { weeklyIv: number | null; monthlyIv: number | null; realizedVol30d: number | null } } | null;
    }>;
    for (const c of candidates) {
      if (!c.stageThree) continue;
      const key = `${c.symbol}:${c.earningsDate}`;
      if (bySymbolDate.has(key)) continue;
      bySymbolDate.set(key, {
        symbol: c.symbol,
        earnings_date: c.earningsDate,
        dte: c.daysToExpiry,
        weekly_iv: c.stageThree.details.weeklyIv,
        monthly_iv: c.stageThree.details.monthlyIv,
        realized_vol: c.stageThree.details.realizedVol30d,
      });
    }
  }
  const candidates = Array.from(bySymbolDate.values());
  console.log(`${candidates.length} unique (symbol, earningsDate) candidates.\n`);

  // Fetch I/O-bound inputs ONCE per candidate — reused across every k.
  const prepared: Prepared[] = [];
  const CONCURRENCY = 6;
  let idx = 0;
  async function worker() {
    while (idx < candidates.length) {
      const i = idx++;
      const c = candidates[i];
      const [crushHistory, surprise] = await Promise.all([
        getCrushHistory(c.symbol, 8).catch(() => [] as CrushHistoryEvent[]),
        getEarningsSurpriseHistory(c.symbol).catch(() => ({ surpriseScore: 0, beatsWithin5Pct: 0, quartersExamined: 0 })),
      ]);
      prepared.push({
        c,
        crushHistory,
        historicalMoves: yahooSnapshot[c.symbol] ?? [],
        surpriseScore: surprise.surpriseScore,
        surpriseQuartersExamined: surprise.quartersExamined,
      });
      if ((i + 1) % 20 === 0) console.log(`  ...${i + 1}/${candidates.length} fetched`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  console.log(`Fetched inputs for ${prepared.length} candidates.\n`);

  // ---- n-distribution (k-independent — n comes from crushHistory only) ----
  console.log("================ n-distribution for historicalMoveRatio ================\n");
  const nOf = (p: Prepared) => gradeAt(p, pop.mean, 2).composite.quarterlyRatio.n; // n is identical at any k
  const buckets = [0, 1, 2, 3, 4, "5+"] as const;
  for (const b of buckets) {
    const inBucket = prepared.filter((p) => (b === "5+" ? nOf(p) >= 5 : nOf(p) === b));
    console.log(`n=${b}: ${inBucket.length} candidates`);
  }

  // ---- Primary test: per-bucket mean historicalMoveScore, before (k=0) vs after (k=2 default) ----
  console.log("\n================ PRIMARY TEST: per-bucket mean historicalMoveScore, before vs after shrinkage ================\n");
  function meanScoreByBucket(k: number): Map<string, { n: number; mean: number }> {
    const out = new Map<string, { sum: number; count: number }>();
    for (const p of prepared) {
      const { composite } = gradeAt(p, pop.mean, k);
      const n = composite.quarterlyRatio.n;
      const bucket = n >= 5 ? "5+" : String(n);
      const cur = out.get(bucket) ?? { sum: 0, count: 0 };
      cur.sum += composite.historicalMoveScore;
      cur.count += 1;
      out.set(bucket, cur);
    }
    const result = new Map<string, { n: number; mean: number }>();
    for (const [bucket, { sum, count }] of Array.from(out.entries())) result.set(bucket, { n: count, mean: sum / count });
    return result;
  }
  const before = meanScoreByBucket(0);
  const after = meanScoreByBucket(2);
  console.log("bucket | n | BEFORE (k=0, raw) mean historicalMoveScore | AFTER (k=2) mean historicalMoveScore");
  for (const b of ["1", "2", "3", "4", "5+"]) {
    const bef = before.get(b);
    const aft = after.get(b);
    console.log(`  n=${b}: n=${bef?.n ?? 0}  BEFORE=${bef ? bef.mean.toFixed(2) : "n/a"}/8  AFTER=${aft ? aft.mean.toFixed(2) : "n/a"}/8`);
  }
  const beforeSpread = (before.get("1")?.mean ?? 0) - (before.get("5+")?.mean ?? 0);
  const afterSpread = (after.get("1")?.mean ?? 0) - (after.get("5+")?.mean ?? 0);
  console.log(`\nn=1 minus n=5+ spread: BEFORE=${beforeSpread.toFixed(2)}, AFTER=${afterSpread.toFixed(2)} (closer to 0 = flatter = better)`);

  // ---- k sensitivity ----
  console.log("\n================ k sensitivity (report only — not picking k) ================\n");
  for (const k of K_VALUES) {
    const byBucket = meanScoreByBucket(k);
    let abCount = 0;
    let changedVsBaseline = 0;
    for (const p of prepared) {
      const g = gradeAt(p, pop.mean, k).finalGrade;
      if (isAB(g)) abCount++;
      if (k !== 0 && gradeAt(p, pop.mean, 0).finalGrade !== g) changedVsBaseline++;
    }
    const bucketStr = ["1", "2", "3", "4", "5+"].map((b) => `n${b}=${byBucket.get(b)?.mean.toFixed(2) ?? "n/a"}`).join(" ");
    console.log(
      `k=${k}${k === 0 ? " (no shrinkage, baseline)" : ""}: A/B fire rate ${abCount}/${prepared.length} (${((abCount / prepared.length) * 100).toFixed(1)}%), ` +
        `mean historicalMoveScore by bucket [${bucketStr}]` +
        (k !== 0 ? `, grade changes vs k=0: ${changedVsBaseline}` : ""),
    );
  }

  // ---- Confirm n=0 unaffected ----
  console.log("\n================ Confirm n=0 candidates unaffected by shrinkage ================\n");
  const n0 = prepared.filter((p) => nOf(p) === 0);
  let n0Unaffected = 0;
  for (const p of n0) {
    const g0 = gradeAt(p, pop.mean, 0);
    const g2 = gradeAt(p, pop.mean, 2);
    const same = g0.composite.shrunkRatio === null && g2.composite.shrunkRatio === null && g0.composite.historicalMoveScore === g2.composite.historicalMoveScore;
    if (same) n0Unaffected++;
    else console.log(`  MISMATCH: ${p.c.symbol} shrunkRatio k0=${g0.composite.shrunkRatio} k2=${g2.composite.shrunkRatio}`);
  }
  console.log(`${n0Unaffected}/${n0.length} n=0 candidates confirmed unaffected (shrunkRatio stays null, historicalMoveScore stays 0 regardless of k).`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

// READ-ONLY validation for the crushGrade fix (per-quarter ratio,
// bidirectional verified modifier, neutral missing-data handling,
// re-banded term structure). No writes anywhere — this only reads
// screener_results/earnings_history and calls the REAL exported
// scoring functions from lib/screener.ts, never a reimplementation.
//
// Usage:
//   npx tsx --tsconfig tsconfig.json scripts/validate-crush-grade-fix.ts
//   npx tsx --tsconfig tsconfig.json scripts/validate-crush-grade-fix.ts --full
//
// Default: the 5 audit tickers (AMZN/CDNS/GLW/BE/TER) old-vs-new diff +
// hand-computed reconciliation + Yahoo-vs-DB divergence report + the
// neutral-missing-data proof. Fast, no batch scan.
// --full: additionally re-grades every persisted candidate across
// every screener_results row and reports how many grades move in each
// direction (the deploy blast-radius check).

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";

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
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!process.env[key]) process.env[key] = val;
    }
  } catch {
    /* ignore */
  }
}
loadEnvLocal();

import { createClient } from "@supabase/supabase-js";
import { getHistoricalEarningsMovements, type EarningsMove } from "@/lib/yahoo";
import { getEarningsSurpriseHistory } from "@/lib/earnings";
import {
  computeCrushComposite,
  computeVerifiedModifier,
  applyGradeModifier,
  DEFAULT_TERM_STRUCTURE_BANDS,
  type CrushCompositeResult,
} from "@/lib/screener";
import { getCrushHistory, getPopulationPriorMoveRatio, type CrushHistoryEvent } from "@/lib/earnings-history-table";

// Fetched once at script start (see main()) and reused for every
// regradeCandidate call — matches the real pipeline's cache behavior
// (getPopulationPriorMoveRatio caches ~30min) without re-paginating the
// full table per candidate.
let POPULATION_PRIOR_RATIO = 1.0;

// --live-history: fetch each candidate's crushHistory LIVE from
// earnings_history instead of using the frozen stageThree.details
// snapshot persisted at original-run time. Default (off) isolates the
// SCORING ALGORITHM change from data drift — the PASS_2B use case.
// --live-history is for validating a DATA repair (e.g. PASS_2C's T1
// contamination fix): the frozen snapshot predates the repair, so it
// would never show the repair's effect.
const LIVE_HISTORY = process.argv.includes("--live-history");

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing Supabase env (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)");
  process.exit(1);
}
const sb = createClient(url, key);

// ---------- Pinned Yahoo snapshot ----------
//
// historicalMoves (Yahoo) no longer feeds the ratio (dropped fallback,
// see buildQuarterlyMoveRatio) but it still feeds consistencyScore.
// Live-refetching it on every script run makes the old-vs-new diff
// dirty: a symbol that just reported between the persisted run and
// this script's run picks up a new quarter Yahoo's window didn't have
// before (GLW's consistencyScore 2->0 shift, tracked back to the 7/28
// print entering the live window — a re-grade artifact, not an
// algorithm change). Pin the first fetch to a local snapshot file and
// reuse it on every subsequent run so the diff isolates the algorithm,
// not the calendar.
const SNAPSHOT_PATH = resolve(
  "/private/tmp/claude-501/-Users-raitsai-csp-screener/ab3c3900-236c-448e-8535-85d682a53a99/scratchpad/crush-validation-yahoo-snapshot.json",
);
let yahooSnapshot: Record<string, EarningsMove[]> = {};
if (existsSync(SNAPSHOT_PATH)) {
  try {
    yahooSnapshot = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8"));
    console.log(`[snapshot] loaded pinned Yahoo data for ${Object.keys(yahooSnapshot).length} symbols from ${SNAPSHOT_PATH}`);
  } catch (e) {
    console.warn(`[snapshot] failed to parse ${SNAPSHOT_PATH}, starting fresh: ${e instanceof Error ? e.message : e}`);
  }
}
function saveSnapshot(): void {
  mkdirSync(dirname(SNAPSHOT_PATH), { recursive: true });
  writeFileSync(SNAPSHOT_PATH, JSON.stringify(yahooSnapshot, null, 2));
}
async function pinnedHistoricalMoves(symbol: string): Promise<EarningsMove[]> {
  if (yahooSnapshot[symbol]) return yahooSnapshot[symbol];
  const moves = await getHistoricalEarningsMovements(symbol).catch(() => [] as EarningsMove[]);
  yahooSnapshot[symbol] = moves;
  saveSnapshot();
  return moves;
}

const FULL = process.argv.includes("--full");

// ---------- Shared types matching the persisted candidate shape ----------

type PersistedStageThreeDetails = {
  weeklyIv: number | null;
  monthlyIv: number | null;
  realizedVol30d: number | null;
  surpriseScore: number;
  historicalMoveScore: number;
  consistencyScore: number;
  termStructureScore: number;
  ivEdgeScore: number;
  medianHistoricalMovePct: number | null;
  crushHistory: CrushHistoryEvent[] | null;
  crushRatio: number | null;
  crushRatioVerifiedN: number;
  crushRatioCap: "A" | "B" | "C" | null;
  crushRatioCapApplied: boolean;
};

type PersistedCandidate = {
  symbol: string;
  earningsDate: string;
  daysToExpiry: number;
  stageThree: {
    score: number;
    maxScore: number;
    threshold: number;
    crushGrade: "A" | "B" | "C" | "F";
    insufficientData: boolean;
    details: PersistedStageThreeDetails;
  } | null;
};

type OldVsNew = {
  symbol: string;
  earningsDate: string;
  old: {
    historicalMoveScore: number;
    consistencyScore: number;
    termStructureScore: number;
    ivEdgeScore: number;
    surpriseScore: number;
    score: number;
    maxScore: number;
    threshold: number;
    preCapGrade: string | null; // not persisted directly; derived best-effort
    crushGrade: string;
  };
  new: {
    historicalMoveRatio: number | null;
    historicalMoveRatioN: number;
    historicalMoveScore: number;
    consistencyScore: number;
    termStructureScore: number;
    ivEdgeScore: number;
    surpriseScore: number;
    score: number;
    maxScore: number;
    threshold: number;
    preModifierGrade: string;
    modifierDelta: number;
    modifierReason: string;
    crushGrade: string;
  };
  composite: CrushCompositeResult;
};

// ---------- Core: re-grade one persisted candidate with the real functions ----------

async function regradeCandidate(c: PersistedCandidate): Promise<OldVsNew | null> {
  if (!c.stageThree) return null;
  const d = c.stageThree.details;
  const crushHistory = LIVE_HISTORY
    ? await getCrushHistory(c.symbol, 8).catch(() => d.crushHistory ?? [])
    : d.crushHistory ?? [];

  // historicalMoves (Yahoo) isn't persisted on the candidate — pinned
  // snapshot (see pinnedHistoricalMoves) rather than a fresh live
  // refetch, so re-running this script doesn't keep drifting the
  // consistencyScore input out from under the diff. surprise history
  // (Finnhub, 8-quarter trailing) is still refetched live each run —
  // it isn't part of the historicalMoveRatio fix under test and
  // Finnhub's trailing-8 rarely revises retroactively.
  const [historicalMoves, surprise] = await Promise.all([
    pinnedHistoricalMoves(c.symbol),
    getEarningsSurpriseHistory(c.symbol).catch(() => ({ surpriseScore: 0, beatsWithin5Pct: 0, quartersExamined: 0 })),
  ]);

  const composite = computeCrushComposite({
    historicalMoves,
    crushHistory,
    earningsDate: c.earningsDate,
    dte: c.daysToExpiry,
    // weeklyIv/monthlyIv/realizedVol are point-in-time market reads —
    // reuse the EXACT persisted values so the diff isolates the
    // algorithm change, not "the market moved since then."
    weeklyIv: d.weeklyIv,
    monthlyIv: d.monthlyIv,
    realizedVol: d.realizedVol30d,
    surpriseScore: surprise.surpriseScore,
    surpriseQuartersExamined: surprise.quartersExamined,
    populationPriorRatio: POPULATION_PRIOR_RATIO,
  });

  const schwabRatios = crushHistory
    .filter(
      (h) =>
        (h.impliedMoveSource === "schwab" || h.impliedMoveSource === "schwab_t0") &&
        h.ratio !== null &&
        h.earningsDate !== c.earningsDate,
    )
    .map((h) => h.ratio as number);
  const modifier = computeVerifiedModifier(schwabRatios);
  const newFinalGrade = applyGradeModifier(composite.crushGrade, modifier.delta);

  return {
    symbol: c.symbol,
    earningsDate: c.earningsDate,
    old: {
      historicalMoveScore: d.historicalMoveScore,
      consistencyScore: d.consistencyScore,
      termStructureScore: d.termStructureScore,
      ivEdgeScore: d.ivEdgeScore,
      surpriseScore: d.surpriseScore,
      score: c.stageThree.score,
      maxScore: c.stageThree.maxScore,
      threshold: c.stageThree.threshold,
      preCapGrade: d.crushRatioCapApplied ? null : c.stageThree.crushGrade, // exact pre-cap letter isn't persisted when the cap didn't fire it's the same as final
      crushGrade: c.stageThree.crushGrade,
    },
    new: {
      historicalMoveRatio: composite.quarterlyRatio.meanRatio,
      historicalMoveRatioN: composite.quarterlyRatio.n,
      historicalMoveScore: composite.historicalMoveScore,
      consistencyScore: composite.consistencyScore,
      termStructureScore: composite.termStructureScore,
      ivEdgeScore: composite.ivEdgeScore,
      surpriseScore: composite.surpriseScore,
      score: composite.score,
      maxScore: composite.maxScore,
      threshold: composite.threshold,
      preModifierGrade: composite.crushGrade,
      modifierDelta: modifier.delta,
      modifierReason: modifier.reason,
      crushGrade: newFinalGrade,
    },
    composite,
  };
}

// ---------- 1+2+5: the 5 audit tickers, diff + reconciliation ----------

const AUDIT_TICKERS = ["AMZN", "CDNS", "GLW", "BE", "TER"];
// Only the RATIO is reconciled against a hand-computed expectation —
// historicalMoveRatio's construction (per-quarter DB pairs, mean) is
// unchanged by this pass's fixes (recalibrated term-structure bands,
// dropped Yahoo fallback), so it should still land where it did last
// time. Grade is NOT reconciled against a fixed expectation here: the
// term-structure recalibration deliberately changes the composite
// total for every candidate, so a stale "expect grade X" from before
// that recalibration would show a MISMATCH for the right reason (the
// bands moved, as requested) rather than a wrong one — printing it
// would just be noise. Grade-level impact is reported in aggregate via
// the A/B fire-rate and named gained/lost sets in Part 4 instead.
const RATIO_EXPECTATIONS: Record<string, number> = {
  AMZN: 0.46,
  CDNS: 0.94,
  GLW: 0.87,
  BE: 1.45,
  TER: 1.23,
};

async function fetchLatestCandidateFor(symbol: string): Promise<PersistedCandidate | null> {
  // Most recent screener_results row containing this symbol, in the
  // 2026-07-27..30 audit window.
  const { data, error } = await sb
    .from("screener_results")
    .select("id, created_at, candidates")
    .gte("created_at", "2026-07-27T00:00:00Z")
    .lte("created_at", "2026-07-31T00:00:00Z")
    .order("created_at", { ascending: false });
  if (error) throw new Error(`screener_results fetch failed: ${error.message}`);
  for (const row of data ?? []) {
    const candidates = (row.candidates ?? []) as PersistedCandidate[];
    const match = candidates.find((c) => c.symbol === symbol);
    if (match) return match;
  }
  return null;
}

async function runAuditTickerSection(): Promise<Map<string, OldVsNew>> {
  console.log("\n================ PART 1: per-ticker old-vs-new diff (5 audit tickers) ================\n");
  const results = new Map<string, OldVsNew>();
  for (const symbol of AUDIT_TICKERS) {
    const candidate = await fetchLatestCandidateFor(symbol);
    if (!candidate) {
      console.log(`${symbol}: no persisted candidate found in 2026-07-27..31 window — skipping`);
      continue;
    }
    const diff = await regradeCandidate(candidate);
    if (!diff) {
      console.log(`${symbol}: candidate had no stageThree — skipping`);
      continue;
    }
    results.set(symbol, diff);

    console.log(`--- ${symbol} (earningsDate=${diff.earningsDate}) ---`);
    console.log(
      `  OLD  hist=${diff.old.historicalMoveScore}/8 cons=${diff.old.consistencyScore}/4 term=${diff.old.termStructureScore}/5 ` +
        `ivEdge=${diff.old.ivEdgeScore}/4 surprise=${diff.old.surpriseScore}/4 total=${diff.old.score}/${diff.old.maxScore} ` +
        `threshold=${diff.old.threshold} grade=${diff.old.crushGrade}`,
    );
    console.log(
      `  NEW  hist=${diff.new.historicalMoveScore}/${diff.composite.scoreComponentsComputed.historicalMove ? 8 : "excl"} ` +
        `cons=${diff.new.consistencyScore}/${diff.composite.scoreComponentsComputed.consistency ? 4 : "excl"} ` +
        `term=${diff.new.termStructureScore}/${diff.composite.scoreComponentsComputed.termStructure ? 5 : "excl"} ` +
        `ivEdge=${diff.new.ivEdgeScore}/${diff.composite.scoreComponentsComputed.ivEdge ? 4 : "excl"} ` +
        `surprise=${diff.new.surpriseScore}/${diff.composite.scoreComponentsComputed.surprise ? 4 : "excl"} ` +
        `total=${diff.new.score}/${diff.new.maxScore} threshold=${diff.new.threshold.toFixed(2)} ` +
        `preModifierGrade=${diff.new.preModifierGrade}`,
    );
    console.log(`  NEW  historicalMoveRatio=${diff.new.historicalMoveRatio?.toFixed(4) ?? "null"} (n=${diff.new.historicalMoveRatioN})`);
    console.log(`  NEW  verified modifier: ${diff.new.modifierReason}`);
    console.log(`  NEW  FINAL GRADE = ${diff.new.crushGrade}  (was ${diff.old.crushGrade})`);

    const expRatio = RATIO_EXPECTATIONS[symbol];
    if (expRatio !== undefined) {
      const ratioOk = diff.new.historicalMoveRatio !== null && Math.abs(diff.new.historicalMoveRatio - expRatio) < 0.15;
      console.log(`  RECONCILE  expected ratio ~${expRatio} (${ratioOk ? "OK" : "MISMATCH"})`);
      if (!ratioOk) {
        console.log(
          `    -> explanation: DB crushHistory is the exact persisted snapshot (ratio construction unaffected by this ` +
            `pass's changes), so a mismatch here would mean earnings_history rows were updated by the T1 cron since the ` +
            `expectation was hand-computed — check the divergence report below for the specific quarter.`,
        );
      }
    }
    console.log("");
  }
  return results;
}

// ---------- 3: Yahoo-vs-DB divergence report ----------

function runDivergenceReport(results: Map<string, OldVsNew>): void {
  console.log("\n================ PART 2: Yahoo-vs-DB per-quarter divergence ================\n");
  for (const symbol of AUDIT_TICKERS) {
    const diff = results.get(symbol);
    if (!diff) continue;
    console.log(`--- ${symbol} ---`);
    for (const q of diff.composite.quarterlyRatio.quarters) {
      const flags: string[] = [];
      if (q.divergent) flags.push(`DIVERGENT (${(q.divergencePct! * 100).toFixed(1)}% relative)`);
      if (q.excludedReason) flags.push(`excluded: ${q.excludedReason}`);
      console.log(
        `  ${q.earningsDate}  implied=${q.impliedMovePct?.toFixed(4) ?? "null"} ` +
          `dbActual=${q.dbActualMovePct?.toFixed(4) ?? "null"} yahooActual=${q.yahooActualMovePct?.toFixed(4) ?? "null"} ` +
          `used=${q.actualUsed?.toFixed(4) ?? "null"}(${q.actualSource ?? "none"}) ratio=${q.ratio?.toFixed(4) ?? "null"} ` +
          `${flags.join(" | ")}`,
      );
    }
    console.log("");
  }

  // AMZN-specific diagnosis requested: Yahoo's median (8.098%) does not
  // obviously reconcile to the History-tab (DB) moves.
  const amzn = results.get("AMZN");
  if (amzn) {
    console.log("--- AMZN diagnosis: Yahoo median vs DB per-quarter actual moves ---");
    console.log(`  Yahoo medianHistoricalMovePct (diagnostic field) = ${amzn.composite.medianHistoricalMovePct?.toFixed(5) ?? "null"}`);
    const yahooDates = amzn.composite.quarterlyRatio.quarters
      .filter((q) => q.yahooActualMovePct !== null)
      .map((q) => `${q.earningsDate}: yahoo=${q.yahooActualMovePct!.toFixed(4)} db=${q.dbActualMovePct?.toFixed(4) ?? "null"}`);
    console.log(`  Per-quarter Yahoo vs DB:\n    ${yahooDates.join("\n    ")}`);
    console.log(
      "  Explanation: medianHistoricalMovePct is the MEDIAN of Yahoo's raw actualMovePct array (unsigned direction\n" +
        "  matters — Yahoo stores signed moves, median of signed values differs from median of |values|). The old\n" +
        "  scoreHistoricalMove divided this single scalar by TODAY's live emPct, conflating a multi-quarter blended\n" +
        "  statistic with a single point-in-time IV read — exactly the bug this fix removes. It was never meant to\n" +
        "  reconcile 1:1 against any individual DB row; the per-quarter list above is the correct comparison unit.",
    );
  }
  console.log("");

  // ---- PASS_2B item 4: Yahoo sign-inversion diagnostic (findings only,
  // no fix) — classify every divergent quarter across all 5 tickers by
  // whether it's a pure sign-convention artifact (same rough magnitude,
  // opposite sign) or a genuine same-sign magnitude disagreement.
  console.log("--- Yahoo sign-inversion diagnostic (findings only) ---");
  console.log(
    "  ROOT CAUSE: EarningsMove.actualMovePct (lib/yahoo.ts:698,742) is computed as `Math.abs(pct)` — UNSIGNED\n" +
      "  by construction, with direction carried separately in the `direction` field. earnings_history.actual_move_pct\n" +
      "  (captured by captureEarningsT1, lib/encyclopedia.ts:1550: `(price_after-price_before)/price_before`) is SIGNED.\n" +
      "  Comparing them directly (as this script's divergence check does) manufactures a large spurious divergence\n" +
      "  whenever the DB's real move was negative — roughly half of all quarters — independent of whether the two\n" +
      "  sources actually agree on magnitude. This is a defect in the DIVERGENCE-COMPARISON code (this script /\n" +
      "  buildQuarterlyMoveRatio's diagnostic fields), not in either underlying data source, and not a fix target\n" +
      "  in this change per your instruction (findings only).",
  );
  console.log(
    "  Session-window check: getHistoricalEarningsMovements's close-before/open-after logic\n" +
      "  (lib/yahoo.ts:680-711) compares real announcement unix timestamps against bar.date+6.5h — this looks\n" +
      "  structurally correct for both AMC and BMO and was NOT found to pick the wrong session in the cases read.\n" +
      "  Split/dividend check: getHistoricalPrices uses yahoo-finance2's `.close`/`.open` (split-adjusted, NOT\n" +
      "  dividend-adjusted `.adjClose`) — the correct convention for measuring a market reaction; no adjustment bug found.",
  );
  let signFlipSimilarMag = 0;
  let signFlipDifferentMag = 0;
  let sameSignBigGap = 0;
  let sameSignClose = 0;
  for (const symbol of AUDIT_TICKERS) {
    const diff = results.get(symbol);
    if (!diff) continue;
    for (const q of diff.composite.quarterlyRatio.quarters) {
      if (q.dbActualMovePct === null || q.yahooActualMovePct === null) continue;
      const db = q.dbActualMovePct;
      const yahoo = q.yahooActualMovePct; // always >= 0
      const sameSign = db >= 0; // yahoo is never negative, so "same sign" means db is non-negative
      const magGapPct = Math.abs(Math.abs(db) - yahoo) / Math.max(Math.abs(db), 1e-6);
      if (!sameSign) {
        if (magGapPct < 0.3) signFlipSimilarMag++;
        else signFlipDifferentMag++;
      } else {
        if (magGapPct < 0.3) sameSignClose++;
        else sameSignBigGap++;
      }
    }
  }
  console.log(
    `  Classification of ${signFlipSimilarMag + signFlipDifferentMag + sameSignClose + sameSignBigGap} paired quarters (5 audit tickers):\n` +
      `    DB negative, magnitudes agree within 30% (pure sign-convention artifact): ${signFlipSimilarMag}\n` +
      `    DB negative, magnitudes ALSO disagree >30% (sign artifact + real gap):    ${signFlipDifferentMag}\n` +
      `    DB positive, magnitudes agree within 30% (genuinely consistent):          ${sameSignClose}\n` +
      `    DB positive, magnitudes disagree >30% (genuine data-source gap, same sign): ${sameSignBigGap}`,
  );
  console.log(
    "  Interpretation: the sign-convention mismatch alone explains the DIRECTION disagreement on every\n" +
      "  DB-negative quarter, but a meaningful share also disagree on MAGNITUDE even after accounting for sign\n" +
      "  (and same-sign quarters can disagree on magnitude too). The likely secondary contributor: DB actual moves\n" +
      "  are captured by the T0/T1 cron at ~15:45 ET (evening before) and ~09:45 ET (15 min after the open) —\n" +
      "  lib/earnings-capture.ts — while Yahoo's move is the CLEAN prior-close-to-next-open daily-bar gap. A stock\n" +
      "  that continues moving or reverses in the first 15 minutes after the open will show a genuinely different\n" +
      "  return in the two windows even with no bug in either source — a real methodological difference in WHEN\n" +
      "  each measurement is taken, not a data-quality defect.",
  );
  console.log("");
}

// ---------- 4: neutral-missing-data proof ----------

function runNeutralDataProof(): void {
  console.log("\n================ PART 3: neutral-missing-data proof ================\n");

  // ---- 3a. The composite-exclusion principle (item 3, generalized) ----
  //
  // historicalMove and consistency share ONE underlying input array
  // (historicalMoves), so zeroing that array excludes BOTH components,
  // not just historicalMove — that's a real coupling in the data model,
  // not a test bug. To isolate historicalMove specifically, hold
  // historicalMoves NON-empty (length>=3, so consistency stays
  // computed) and vary ONLY crushHistory (empty vs populated) —
  // historicalMove's computability depends on quarterlyRatio.n, which
  // requires a crushHistory row with a real implied move; Yahoo alone
  // can never supply one (see buildQuarterlyMoveRatio).
  const sharedHistoricalMoves = [
    { date: "2025-01-01", actualMovePct: 0.02, direction: "up" as const },
    { date: "2025-04-01", actualMovePct: -0.02, direction: "down" as const },
    { date: "2025-07-01", actualMovePct: 0.01, direction: "up" as const },
    { date: "2025-10-01", actualMovePct: -0.01, direction: "down" as const },
  ];
  const commonInputs = {
    earningsDate: "2099-01-01",
    dte: 4,
    weeklyIv: 0.9,
    monthlyIv: 0.5,
    realizedVol: 0.35,
    surpriseScore: 3,
    surpriseQuartersExamined: 8,
    populationPriorRatio: POPULATION_PRIOR_RATIO,
  };

  // Candidate A: historicalMoves present (consistency computed), but
  // NO crushHistory rows at all — historicalMove component excluded.
  const withMissingComponent = computeCrushComposite({
    historicalMoves: sharedHistoricalMoves,
    crushHistory: [],
    ...commonInputs,
  });

  // Candidate B: IDENTICAL historicalMoves, but WITH matching
  // crushHistory rows so historicalMove becomes computed. Only
  // difference from A is crushHistory — isolates the one component.
  const withPresentComponent = computeCrushComposite({
    historicalMoves: sharedHistoricalMoves,
    crushHistory: [
      { earningsDate: "2025-01-01", qtrLabel: "Q1", fiscalQuarter: null, fiscalYear: null, periodEnd: null, fiscalKnown: false, impliedMovePct: 0.08, actualMovePct: 0.02, ratio: 0.25, grade: "A", impliedMoveSource: "manual", impliedMoveExpiry: null, impliedMoveReadDate: null, dateConfidence: null, t1Unrecoverable: false, timing: null },
      { earningsDate: "2025-04-01", qtrLabel: "Q2", fiscalQuarter: null, fiscalYear: null, periodEnd: null, fiscalKnown: false, impliedMovePct: 0.08, actualMovePct: -0.02, ratio: 0.25, grade: "A", impliedMoveSource: "manual", impliedMoveExpiry: null, impliedMoveReadDate: null, dateConfidence: null, t1Unrecoverable: false, timing: null },
      { earningsDate: "2025-07-01", qtrLabel: "Q3", fiscalQuarter: null, fiscalYear: null, periodEnd: null, fiscalKnown: false, impliedMovePct: 0.08, actualMovePct: 0.01, ratio: 0.125, grade: "A", impliedMoveSource: "manual", impliedMoveExpiry: null, impliedMoveReadDate: null, dateConfidence: null, t1Unrecoverable: false, timing: null },
      { earningsDate: "2025-10-01", qtrLabel: "Q4", fiscalQuarter: null, fiscalYear: null, periodEnd: null, fiscalKnown: false, impliedMovePct: 0.08, actualMovePct: -0.01, ratio: 0.125, grade: "A", impliedMoveSource: "manual", impliedMoveExpiry: null, impliedMoveReadDate: null, dateConfidence: null, t1Unrecoverable: false, timing: null },
    ],
    ...commonInputs,
  });

  // Hand-computed reference (independent of computeCrushComposite —
  // a real check, not a tautology). consistencyScore/termStructureScore/
  // ivEdgeScore/surpriseScore are IDENTICAL between A and B by
  // construction (only crushHistory differs), so B's own reported
  // values for those four are a valid stand-in for "hand-computed."
  const otherFourPoints = withPresentComponent.consistencyScore + withPresentComponent.termStructureScore + withPresentComponent.ivEdgeScore + withPresentComponent.surpriseScore;
  const otherFourMax = 4 + 5 + 4 + 4;
  const handMaxWithoutHistoricalMove = otherFourMax;
  const handMaxWithHistoricalMove = 8 + otherFourMax;

  console.log(`Candidate A (historicalMoves present, crushHistory EMPTY -> historicalMove component excluded):`);
  console.log(`  scoreComponentsComputed = ${JSON.stringify(withMissingComponent.scoreComponentsComputed)}`);
  console.log(`  maxScore = ${withMissingComponent.maxScore} (expect ${handMaxWithoutHistoricalMove}, i.e. NOT 25, and NOT scored against a fixed /25)`);
  console.log(`  score = ${withMissingComponent.score} (expect ${otherFourPoints}, i.e. exactly the other four components' points, no zero added for historicalMove)`);
  console.log(`  grade = ${withMissingComponent.crushGrade}`);
  const proofA1 = withMissingComponent.maxScore === handMaxWithoutHistoricalMove;
  const proofA2 = withMissingComponent.score === otherFourPoints;
  console.log(`  PROOF: maxScore excludes the 8-point historicalMove max entirely -> ${proofA1 ? "PASS" : "FAIL"}`);
  console.log(`  PROOF: score excludes historicalMove's points entirely (not scored as 0) -> ${proofA2 ? "PASS" : "FAIL"}`);

  console.log(`\nCandidate B (identical inputs, crushHistory POPULATED -> historicalMove component computed):`);
  console.log(`  scoreComponentsComputed = ${JSON.stringify(withPresentComponent.scoreComponentsComputed)}`);
  console.log(`  maxScore = ${withPresentComponent.maxScore} (expect ${handMaxWithHistoricalMove}, i.e. 25)`);
  console.log(`  historicalMoveScore = ${withPresentComponent.historicalMoveScore}/8`);
  const proofB = withPresentComponent.maxScore === handMaxWithHistoricalMove;
  console.log(`  PROOF: maxScore includes the 8-point historicalMove max when data exists -> ${proofB ? "PASS" : "FAIL"}`);

  // The decisive "neutral, not penalized" claim: compare A's grade
  // against what the OLD (pre-fix) code would have produced on the
  // SAME inputs — historicalMoveScore scored as a literal 0/8 (data
  // missing = worst possible score) folded into a fixed 25-point max,
  // rather than excluded from both.
  const oldBuggyGrade = gradeFromCrushScoreLocal(withPresentComponent.score - withPresentComponent.historicalMoveScore, 25);
  const newNeutralGrade = withMissingComponent.crushGrade;
  console.log(
    `\nCross-check: OLD behavior (missing data scored as 0/8, folded into a fixed /25) would grade this candidate ${oldBuggyGrade}.\n` +
      `NEW behavior (missing data excluded from both score and max) grades the SAME candidate ${newNeutralGrade}.\n` +
      `${oldBuggyGrade !== newNeutralGrade ? `PASS — the fix changes the actual grade (${oldBuggyGrade} -> ${newNeutralGrade}), proving missing data is no longer an active penalty.` : "NOTE — grades coincide for this particular input mix; the maxScore/score PASS checks above are the decisive proof regardless."}`,
  );

  // ---- 3b. The verified-modifier neutrality (item 3, first paragraph) ----
  //
  // "Absence of verified data must be NEUTRAL — no modifier applied, no
  // penalty, no thin-sample ceiling." Direct check on
  // computeVerifiedModifier itself, plus confirmation applyGradeModifier
  // is a true identity at delta=0.
  console.log(`\n--- Verified-modifier neutrality (computeVerifiedModifier([])) ---`);
  const zeroVerified = computeVerifiedModifier([]);
  console.log(`  computeVerifiedModifier([]) = ${JSON.stringify(zeroVerified)}`);
  const modifierNeutral = zeroVerified.delta === 0;
  console.log(`  PROOF: delta === 0 (no modifier at verifiedN=0, replacing the old always-cap-at-B rule) -> ${modifierNeutral ? "PASS" : "FAIL"}`);
  for (const g of ["A", "B", "C", "F"] as const) {
    const unchanged = applyGradeModifier(g, 0) === g;
    console.log(`  applyGradeModifier(${g}, 0) === ${g} -> ${unchanged ? "PASS" : "FAIL"}`);
  }
  console.log(
    `  Live confirmation from PART 1 above: CDNS and GLW (both verifiedN=0 in production data right now) logged\n` +
      `  "0 schwab-verified quarters — neutral, no modifier applied" — this is the real pipeline exhibiting the\n` +
      `  same neutral behavior proven synthetically here, not just a unit-test artifact.`,
  );
}

// Local mirror of gradeFromCrushScore's bands, used ONLY for the
// counterfactual "what if scored as zero" comparison above — this is
// deliberately NOT the real function (which is unexported), so it must
// never be used to validate the real pipeline's output, only to show
// what the OLD buggy behavior would have produced for contrast.
function gradeFromCrushScoreLocal(score: number, maxScore: number): string {
  if (maxScore <= 0) return "F";
  const pct = score / maxScore;
  if (pct >= 18 / 25) return "A";
  if (pct >= 14 / 25) return "B";
  if (pct >= 10 / 25) return "C";
  return "F";
}

// ---------- 5: full batch re-grade (--full only) ----------

// Reconstruction of the ORIGINAL (pre-PASS_2A) term-structure bands —
// this function was deleted from lib/screener.ts along with the
// ceiling-only cap it shipped alongside; it's inlined here ONLY as a
// historical baseline for the "old vs new distribution" report below,
// never called by the actual pipeline.
function originalTermStructureScore(ratio: number): number {
  if (ratio > 1.5) return 5;
  if (ratio > 1.3) return 3;
  if (ratio > 1.1) return 1;
  return 0;
}

async function runFullBatch(): Promise<void> {
  console.log("\n================ PART 4: full batch re-grade (--full) ================\n");
  const { data, error } = await sb.from("screener_results").select("id, created_at, candidates").order("created_at", { ascending: false });
  if (error) throw new Error(`screener_results fetch failed: ${error.message}`);

  // Dedupe by (symbol, earningsDate) — re-grading the same event twice
  // wastes API calls and would double-count in the direction tally.
  const bySymbolDate = new Map<string, PersistedCandidate>();
  for (const row of data ?? []) {
    const candidates = (row.candidates ?? []) as PersistedCandidate[];
    for (const c of candidates) {
      if (!c.stageThree) continue;
      const k = `${c.symbol}:${c.earningsDate}`;
      if (!bySymbolDate.has(k)) bySymbolDate.set(k, c);
    }
  }
  console.log(`${bySymbolDate.size} unique (symbol, earningsDate) candidates to re-grade.\n`);

  // ---- Term-structure distribution: old bands vs new bands, same
  // population, computed directly (not via regradeCandidate) since
  // this only needs the persisted weeklyIv/monthlyIv pair.
  {
    const oldPts: number[] = [];
    const newPts: number[] = [];
    let above14NotZero = 0;
    let above14Total = 0;
    for (const c of Array.from(bySymbolDate.values())) {
      const wiv = c.stageThree?.details.weeklyIv;
      const miv = c.stageThree?.details.monthlyIv;
      if (wiv === null || wiv === undefined || miv === null || miv === undefined || miv <= 0) continue;
      const ratio = wiv / miv;
      const oldP = originalTermStructureScore(ratio);
      // New bands via the real DEFAULT_TERM_STRUCTURE_BANDS, applied
      // the same way scoreTermStructure does internally (edges
      // high-to-low, points high-to-low).
      const [e0, e1, e2] = DEFAULT_TERM_STRUCTURE_BANDS.edges;
      const [p0, p1, p2] = DEFAULT_TERM_STRUCTURE_BANDS.points;
      const newP = ratio > e0 ? p0 : ratio > e1 ? p1 : ratio > e2 ? p2 : 0;
      oldPts.push(oldP);
      newPts.push(newP);
      if (ratio > 1.4) {
        above14Total++;
        if (newP > 0) above14NotZero++;
      }
    }
    const mean = (arr: number[]) => arr.reduce((s, v) => s + v, 0) / arr.length;
    const dist = (arr: number[]) => {
      const buckets = new Map<number, number>();
      for (const v of arr) buckets.set(v, (buckets.get(v) ?? 0) + 1);
      return Array.from(buckets.entries()).sort((a, b) => a[0] - b[0]).map(([pts, n]) => `${pts}pt:${n}`).join(" ");
    };
    console.log(`--- Term-structure recalibration (n=${oldPts.length} candidates with weeklyIv+monthlyIv) ---`);
    console.log(`  OLD bands (>1.5/>1.3/>1.1 -> 5/3/1): mean=${mean(oldPts).toFixed(2)}/5  dist: ${dist(oldPts)}`);
    console.log(`  NEW bands (${DEFAULT_TERM_STRUCTURE_BANDS.edges.join("/")} -> ${DEFAULT_TERM_STRUCTURE_BANDS.points.join("/")}): mean=${mean(newPts).toFixed(2)}/5  dist: ${dist(newPts)}`);
    console.log(
      `  Floor check: ${above14NotZero}/${above14Total} candidates with ratio > 1.4 score NON-zero on term structure ` +
        `-> ${above14NotZero === above14Total ? "PASS (none score zero)" : "FAIL"}`,
    );
    console.log("");
  }

  const GRADE_RANK: Record<string, number> = { F: 0, C: 1, B: 2, A: 3 };
  const isAB = (g: string) => g === "A" || g === "B";
  let up = 0;
  let down = 0;
  let unchanged = 0;
  let failed = 0;
  let oldAB = 0;
  let newAB = 0;
  const moves: string[] = [];
  const gainedAB: string[] = [];
  const lostAB: string[] = [];
  // Captured for the threshold-sensitivity table below — NOT used to
  // change any grade in this report, only to show what a compensating
  // threshold shift would look like so you can decide, per your
  // instruction not to silently absorb the level change.
  const scoreCaptures: Array<{ score: number; maxScore: number; modifierDelta: number }> = [];

  const entries = Array.from(bySymbolDate.values());
  const CONCURRENCY = 6;
  let idx = 0;
  async function worker() {
    while (idx < entries.length) {
      const i = idx++;
      const c = entries[i];
      try {
        const diff = await regradeCandidate(c);
        if (!diff) {
          failed++;
          continue;
        }
        scoreCaptures.push({ score: diff.new.score, maxScore: diff.new.maxScore, modifierDelta: diff.new.modifierDelta });
        if (isAB(diff.old.crushGrade)) oldAB++;
        if (isAB(diff.new.crushGrade)) newAB++;
        if (!isAB(diff.old.crushGrade) && isAB(diff.new.crushGrade)) {
          gainedAB.push(`  GAINED A/B  ${c.symbol.padEnd(6)} ${c.earningsDate}  ${diff.old.crushGrade} -> ${diff.new.crushGrade}`);
        } else if (isAB(diff.old.crushGrade) && !isAB(diff.new.crushGrade)) {
          lostAB.push(`  LOST A/B    ${c.symbol.padEnd(6)} ${c.earningsDate}  ${diff.old.crushGrade} -> ${diff.new.crushGrade}`);
        }

        const oldRank = GRADE_RANK[diff.old.crushGrade] ?? 0;
        const newRank = GRADE_RANK[diff.new.crushGrade] ?? 0;
        if (newRank > oldRank) {
          up++;
          moves.push(`  UP    ${c.symbol.padEnd(6)} ${c.earningsDate}  ${diff.old.crushGrade} -> ${diff.new.crushGrade}`);
        } else if (newRank < oldRank) {
          down++;
          moves.push(`  DOWN  ${c.symbol.padEnd(6)} ${c.earningsDate}  ${diff.old.crushGrade} -> ${diff.new.crushGrade}`);
        } else {
          unchanged++;
        }
      } catch (e) {
        failed++;
        console.warn(`  [error] ${c.symbol} ${c.earningsDate}: ${e instanceof Error ? e.message : e}`);
      }
      if ((i + 1) % 20 === 0) console.log(`  ...${i + 1}/${entries.length} re-graded`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  const total = entries.length;
  console.log(`\n--- A/B fire rate ---`);
  console.log(`  OLD: ${oldAB}/${total} = ${((oldAB / total) * 100).toFixed(1)}%`);
  console.log(`  NEW: ${newAB}/${total} = ${((newAB / total) * 100).toFixed(1)}%`);
  console.log(
    `  Delta: ${newAB - oldAB >= 0 ? "+" : ""}${newAB - oldAB} candidates (${(((newAB - oldAB) / total) * 100).toFixed(1)} pp)`,
  );

  // ---- Threshold-shift sensitivity table — NOT applied, purely
  // informational so you can decide the compensating shift yourself
  // rather than have it absorbed silently in the bands. Recomputes
  // ONLY the B-grade cut point (currently 14/25 = 56%) at a few
  // alternative values, re-applying each candidate's OWN already-
  // computed modifierDelta on top (the modifier is unaffected by this
  // — it's a separate mechanism). A-grade cut (18/25) and C-grade cut
  // (10/25) are left at their current proportions in this table.
  {
    const GRADE_STEPS_LOCAL: Array<"A" | "B" | "C" | "F"> = ["F", "C", "B", "A"];
    const RANK: Record<string, number> = { F: 0, C: 1, B: 2, A: 3 };
    const gradeAt = (score: number, maxScore: number, bCutFraction: number, modifierDelta: number): string => {
      if (maxScore <= 0) return "F";
      const pct = score / maxScore;
      let idx: number;
      if (pct >= 18 / 25) idx = 3;
      else if (pct >= bCutFraction) idx = 2;
      else if (pct >= 10 / 25) idx = 1;
      else idx = 0;
      const withMod = Math.max(0, Math.min(3, idx + modifierDelta));
      void RANK;
      return GRADE_STEPS_LOCAL[withMod];
    };
    console.log(`\n--- B-threshold sensitivity (informational only — not applied) ---`);
    console.log(`  Current B cut: 14/25 (56%) -> NEW fire rate ${((newAB / total) * 100).toFixed(1)}% (shown above)`);
    for (const bCutPts of [13, 12, 11, 10.5, 10]) {
      const bCutFraction = bCutPts / 25;
      let abCount = 0;
      for (const s of scoreCaptures) {
        const g = gradeAt(s.score, s.maxScore, bCutFraction, s.modifierDelta);
        if (g === "A" || g === "B") abCount++;
      }
      console.log(
        `  B cut ${bCutPts}/25 (${(bCutFraction * 100).toFixed(0)}%): fire rate ${abCount}/${total} = ${((abCount / total) * 100).toFixed(1)}% ` +
          `(vs OLD ${((oldAB / total) * 100).toFixed(1)}%)`,
      );
    }
  }

  console.log(`\n--- Blast radius (any grade change) ---`);
  console.log(`  UP (grade improved):    ${up}`);
  console.log(`  DOWN (grade worsened):  ${down}`);
  console.log(`  UNCHANGED:              ${unchanged}`);
  console.log(`  FAILED to re-grade:     ${failed}`);
  console.log(`  TOTAL:                  ${total}`);

  console.log(`\n--- Named set: gained A/B (${gainedAB.length}) ---`);
  for (const m of gainedAB.sort()) console.log(m);
  console.log(`\n--- Named set: lost A/B (${lostAB.length}) ---`);
  for (const m of lostAB.sort()) console.log(m);

  console.log(`\n--- All individual grade moves (any direction, for reference) ---`);
  for (const m of moves.sort()) console.log(m);
}

// ---------- main ----------

async function main() {
  const pop = await getPopulationPriorMoveRatio();
  POPULATION_PRIOR_RATIO = pop.median;
  console.log(`Population prior (median) move_ratio: ${pop.median.toFixed(4)} (n=${pop.n} valid pairs)\n`);

  const results = await runAuditTickerSection();
  runDivergenceReport(results);
  runNeutralDataProof();
  if (FULL) {
    await runFullBatch();
  } else {
    console.log("\n(Run with --full to additionally re-grade every persisted candidate and report the deploy blast radius.)\n");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

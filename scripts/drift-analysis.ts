// Post-earnings drift analysis. Design is fixed per spec — this script
// is written in full (sample, buckets, all horizons, both controls,
// robustness re-run) BEFORE being executed. Run once, report every
// cell. No threshold/filter/horizon gets adjusted after seeing output.
//
// Uses the Supabase Management API directly (raw SQL) rather than the
// app's PostgREST wrapper — this analysis needs window functions
// (ntile, stddev_samp, percentile_cont) that the wrapper doesn't
// expose, and Postgres's own arithmetic is less error-prone than
// hand-rolling variance/percentile in JS.
//
// Usage: npx tsx scripts/drift-analysis.ts
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

function loadEnvLocal(): void {
  const content = readFileSync(resolve(process.cwd(), ".env.local"), "utf8");
  for (const line of content.split("\n")) {
    const eq = line.indexOf("=");
    if (eq === -1 || line.trim().startsWith("#")) continue;
    const k = line.slice(0, eq).trim();
    if (!process.env[k]) process.env[k] = line.slice(eq + 1).trim();
  }
}

const PROJECT_REF = "zoqrxhdpthyxxqapcjgz";

async function sql(query: string): Promise<any[]> {
  const token = readFileSync(resolve(process.env.HOME ?? "", ".supabase/access-token"), "utf8").trim();
  const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const json = await res.json();
  if (!Array.isArray(json)) {
    throw new Error(`SQL failed: ${JSON.stringify(json)}\nQuery: ${query.slice(0, 300)}`);
  }
  return json;
}

// The base filter, minus the timing_review_status exclusion — shared
// by both the primary and robustness samples.
const BASE_WHERE = `
  date_confidence = 'vendor_derived'
  AND timing IS NOT NULL
  AND eps_actual IS NOT NULL
  AND eps_estimate IS NOT NULL
`;

async function buildFunnel() {
  const steps: Array<{ label: string; n: number }> = [];
  const push = async (label: string, where: string) => {
    const r = await sql(`SELECT count(*)::int AS n FROM earnings_history WHERE ${where}`);
    steps.push({ label, n: r[0].n });
  };
  await push("total earnings_history rows", "true");
  await push("date_confidence = 'vendor_derived'", "date_confidence = 'vendor_derived'");
  await push(
    "+ timing IS NOT NULL",
    "date_confidence = 'vendor_derived' AND timing IS NOT NULL",
  );
  await push(
    "+ timing IN ('bmo','amc')  [excludes 'unknown' — reaction-bar rule doesn't define an offset for it]",
    "date_confidence = 'vendor_derived' AND timing IN ('bmo','amc')",
  );
  await push(
    "+ eps_actual IS NOT NULL AND eps_estimate IS NOT NULL",
    "date_confidence = 'vendor_derived' AND timing IN ('bmo','amc') AND eps_actual IS NOT NULL AND eps_estimate IS NOT NULL",
  );
  await push(
    "+ eps_estimate != 0  [surprise formula divides by |eps_estimate|]",
    "date_confidence = 'vendor_derived' AND timing IN ('bmo','amc') AND eps_actual IS NOT NULL AND eps_estimate IS NOT NULL AND eps_estimate != 0",
  );
  const covRow = await sql(`
    SELECT count(*)::int AS n FROM earnings_history eh
    WHERE date_confidence = 'vendor_derived' AND timing IN ('bmo','amc')
      AND eps_actual IS NOT NULL AND eps_estimate IS NOT NULL AND eps_estimate != 0
      AND EXISTS (SELECT 1 FROM earnings_price_paths epp WHERE epp.earnings_history_id = eh.id AND epp.trading_day_offset = 20)
  `);
  steps.push({ label: "+ earnings_price_paths coverage through offset +20", n: covRow[0].n });

  const primaryRow = await sql(`
    SELECT count(*)::int AS n FROM earnings_history eh
    WHERE date_confidence = 'vendor_derived' AND timing IN ('bmo','amc')
      AND eps_actual IS NOT NULL AND eps_estimate IS NOT NULL AND eps_estimate != 0
      AND EXISTS (SELECT 1 FROM earnings_price_paths epp WHERE epp.earnings_history_id = eh.id AND epp.trading_day_offset = 20)
      AND (timing_review_status IS NULL OR timing_review_status != 'flagged_uncertain')
  `);
  steps.push({ label: "PRIMARY: - timing_review_status='flagged_uncertain'", n: primaryRow[0].n });

  const bmoAmcSplit = await sql(`
    SELECT timing, count(*)::int AS n FROM earnings_history eh
    WHERE date_confidence = 'vendor_derived' AND timing IN ('bmo','amc')
      AND eps_actual IS NOT NULL AND eps_estimate IS NOT NULL AND eps_estimate != 0
      AND EXISTS (SELECT 1 FROM earnings_price_paths epp WHERE epp.earnings_history_id = eh.id AND epp.trading_day_offset = 20)
      AND (timing_review_status IS NULL OR timing_review_status != 'flagged_uncertain')
    GROUP BY 1
  `);

  return { steps, bmoAmcSplit };
}

// Pulls the qualifying row set (with reaction-bar-relative moves
// computed in SQL from earnings_price_paths.adj_close) for a given
// extra WHERE clause (used to toggle the timing_review_status
// exclusion for primary vs robustness).
async function fetchSample(extraWhere: string) {
  return sql(`
    WITH cand AS (
      SELECT eh.id, eh.symbol, eh.earnings_date, eh.timing,
             eh.eps_actual, eh.eps_estimate,
             (eh.eps_actual - eh.eps_estimate) / abs(eh.eps_estimate) AS eps_surprise,
             extract(year FROM eh.earnings_date)::int AS yr,
             CASE WHEN eh.timing = 'bmo' THEN 0 ELSE 1 END AS reaction_offset
      FROM earnings_history eh
      WHERE ${BASE_WHERE}
        AND eh.timing IN ('bmo','amc')
        AND eh.eps_estimate != 0
        AND EXISTS (SELECT 1 FROM earnings_price_paths epp WHERE epp.earnings_history_id = eh.id AND epp.trading_day_offset = 20)
        ${extraWhere}
    ),
    paths AS (
      SELECT c.id, epp.trading_day_offset AS off, epp.adj_close
      FROM cand c
      JOIN earnings_price_paths epp ON epp.earnings_history_id = c.id
      WHERE epp.trading_day_offset BETWEEN -5 AND 25
    ),
    piv AS (
      SELECT c.id, c.symbol, c.earnings_date, c.timing, c.eps_surprise, c.yr, c.reaction_offset,
        MAX(CASE WHEN p.off = c.reaction_offset - 1 THEN p.adj_close END) AS pre_close,
        MAX(CASE WHEN p.off = c.reaction_offset THEN p.adj_close END) AS reaction_close,
        MAX(CASE WHEN p.off = c.reaction_offset + 1 THEN p.adj_close END) AS d1_close,
        MAX(CASE WHEN p.off = c.reaction_offset + 3 THEN p.adj_close END) AS d3_close,
        MAX(CASE WHEN p.off = c.reaction_offset + 5 THEN p.adj_close END) AS d5_close,
        MAX(CASE WHEN p.off = c.reaction_offset + 10 THEN p.adj_close END) AS d10_close,
        MAX(CASE WHEN p.off = c.reaction_offset + 20 THEN p.adj_close END) AS d20_close
      FROM cand c
      JOIN paths p ON p.id = c.id
      GROUP BY c.id, c.symbol, c.earnings_date, c.timing, c.eps_surprise, c.yr, c.reaction_offset
    )
    SELECT symbol, earnings_date, timing, eps_surprise, yr,
      pre_close, reaction_close,
      CASE WHEN pre_close IS NOT NULL AND pre_close != 0 THEN (reaction_close - pre_close) / pre_close END AS reaction_move,
      CASE WHEN d1_close IS NOT NULL THEN (d1_close - reaction_close) / reaction_close END AS drift1,
      CASE WHEN d3_close IS NOT NULL THEN (d3_close - reaction_close) / reaction_close END AS drift3,
      CASE WHEN d5_close IS NOT NULL THEN (d5_close - reaction_close) / reaction_close END AS drift5,
      CASE WHEN d10_close IS NOT NULL THEN (d10_close - reaction_close) / reaction_close END AS drift10,
      CASE WHEN d20_close IS NOT NULL THEN (d20_close - reaction_close) / reaction_close END AS drift20
    FROM piv
  `);
}

type Row = {
  symbol: string;
  earnings_date: string;
  timing: string;
  eps_surprise: number;
  yr: number;
  pre_close: number | null;
  reaction_close: number | null;
  reaction_move: number | null;
  drift1: number | null;
  drift3: number | null;
  drift5: number | null;
  drift10: number | null;
  drift20: number | null;
};

const HORIZONS = ["drift1", "drift3", "drift5", "drift10", "drift20"] as const;

// Postgres numeric/double columns come back from the Management API as
// JSON strings (precision preservation), not JS numbers. Coerce
// defensively at every arithmetic site — `+` on two strings
// concatenates instead of adding, which silently produced NaN/garbage
// throughout the first run of this script.
function mean(xs: number[]): number {
  return xs.reduce((s, x) => s + Number(x), 0) / xs.length;
}
function median(xs: number[]): number {
  const s = [...xs].map(Number).sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}
function stddevSamp(xs: number[]): number {
  if (xs.length < 2) return NaN;
  const m = mean(xs);
  const ss = xs.reduce((s, x) => s + (x - m) ** 2, 0);
  return Math.sqrt(ss / (xs.length - 1));
}
function se(xs: number[]): number {
  return stddevSamp(xs) / Math.sqrt(xs.length);
}

function quintileBucket(rows: Row[], key: "eps_surprise" | "reaction_move"): Row[][] {
  // ntile(5)-equivalent: sort ascending, split into 5 as-equal-as-
  // possible contiguous groups (matches Postgres ntile's behavior of
  // giving the remainder to the first groups).
  const valid = rows.filter((r) => r[key] !== null) as Row[];
  const sorted = [...valid].sort((a, b) => (a[key] as number) - (b[key] as number));
  const n = sorted.length;
  const base = Math.floor(n / 5);
  const rem = n % 5;
  const buckets: Row[][] = [];
  let idx = 0;
  for (let i = 0; i < 5; i++) {
    const size = base + (i < rem ? 1 : 0);
    buckets.push(sorted.slice(idx, idx + size));
    idx += size;
  }
  return buckets;
}

function measureBucket(bucket: Row[], key: "eps_surprise" | "reaction_move") {
  const boundaryVals = bucket.map((r) => r[key] as number);
  const horizonStats: Record<string, { n: number; mean: number; median: number; se: number }> = {};
  for (const h of HORIZONS) {
    const vals = bucket.map((r) => r[h]).filter((v): v is number => v !== null);
    horizonStats[h] = {
      n: vals.length,
      mean: vals.length ? mean(vals) : NaN,
      median: vals.length ? median(vals) : NaN,
      se: vals.length >= 2 ? se(vals) : NaN,
    };
  }
  return {
    n: bucket.length,
    boundary_min: Math.min(...boundaryVals),
    boundary_max: Math.max(...boundaryVals),
    horizons: horizonStats,
  };
}

function spreadReport(bucketStats: ReturnType<typeof measureBucket>[]) {
  const top = bucketStats[4];
  const bottom = bucketStats[0];
  const out: Record<string, { spread: number; se: number; ratio: number; n_top: number; n_bottom: number }> = {};
  for (const h of HORIZONS) {
    const t = top.horizons[h];
    const b = bottom.horizons[h];
    const spread = t.mean - b.mean;
    const spreadSe = Math.sqrt(t.se ** 2 + b.se ** 2);
    out[h] = { spread, se: spreadSe, ratio: spread / spreadSe, n_top: t.n, n_bottom: b.n };
  }
  return out;
}

async function main() {
  loadEnvLocal();

  console.log("=== building funnel ===");
  const funnel = await buildFunnel();
  console.log(JSON.stringify(funnel, null, 2));

  console.log("\n=== fetching primary sample (excludes flagged_uncertain) ===");
  const primaryRaw = (await fetchSample(
    "AND (eh.timing_review_status IS NULL OR eh.timing_review_status != 'flagged_uncertain')",
  )) as Row[];
  console.log(`primary sample n = ${primaryRaw.length}`);

  console.log("\n=== fetching robustness sample (includes the 19) ===");
  const robustnessRaw = (await fetchSample("")) as Row[];
  console.log(`robustness sample n = ${robustnessRaw.length}`);

  // adj_close coverage check — do NOT assume parity with `close` just
  // because the sample filter required offset=20's row to exist; that
  // row's adj_close specifically could still be null.
  const nullChecks = {
    primary_missing_pre_or_reaction: primaryRaw.filter((r) => r.pre_close === null || r.reaction_close === null).length,
    primary_missing_drift1: primaryRaw.filter((r) => r.drift1 === null).length,
    primary_missing_drift20_bmo: primaryRaw.filter((r) => r.timing === "bmo" && r.drift20 === null).length,
    primary_missing_drift20_amc: primaryRaw.filter((r) => r.timing === "amc" && r.drift20 === null).length,
  };
  console.log("\n=== adj_close null checks ===");
  console.log(JSON.stringify(nullChecks, null, 2));

  // Drop rows unusable for the core measure (missing pre/reaction
  // close — can't even compute the reaction move or any drift leg).
  const primary = primaryRaw.filter((r) => r.pre_close !== null && r.reaction_close !== null);
  const robustness = robustnessRaw.filter((r) => r.pre_close !== null && r.reaction_close !== null);
  console.log(`\nusable primary n = ${primary.length} (dropped ${primaryRaw.length - primary.length} missing pre/reaction close)`);
  console.log(`usable robustness n = ${robustness.length} (dropped ${robustnessRaw.length - robustness.length})`);

  function runEpsAnalysis(rows: Row[]) {
    const buckets = quintileBucket(rows, "eps_surprise");
    const stats = buckets.map((b) => measureBucket(b, "eps_surprise"));
    return { n: rows.length, buckets: stats, spread: spreadReport(stats) };
  }
  function runReactionMoveAnalysis(rows: Row[]) {
    const buckets = quintileBucket(rows, "reaction_move");
    const stats = buckets.map((b) => measureBucket(b, "reaction_move"));
    return { n: rows.length, buckets: stats, spread: spreadReport(stats) };
  }

  console.log("\n=== PRIMARY: EPS-surprise quintiles ===");
  const primaryEps = runEpsAnalysis(primary);

  console.log("=== ROBUSTNESS (incl. 19): EPS-surprise quintiles ===");
  const robustnessEps = runEpsAnalysis(robustness);

  console.log("=== CONTROL: reaction-move quintiles (primary sample) ===");
  const reactionMoveControl = runReactionMoveAnalysis(primary);

  const years = Array.from(new Set(primary.map((r) => r.yr))).sort();
  console.log(`=== YEAR SPLIT: years present = ${years.join(", ")} ===`);
  const byYear: Record<number, ReturnType<typeof runEpsAnalysis> & { minDate: string; maxDate: string }> = {};
  for (const y of years) {
    const yrRows = primary.filter((r) => r.yr === y);
    const dates = yrRows.map((r) => r.earnings_date).sort();
    byYear[y] = { ...runEpsAnalysis(yrRows), minDate: dates[0], maxDate: dates[dates.length - 1] };
  }

  const report = {
    funnel,
    nullChecks,
    primary: primaryEps,
    robustness: robustnessEps,
    reactionMoveControl,
    byYear,
    generatedAt: new Date().toISOString(),
  };
  writeFileSync(resolve(process.cwd(), "drift-analysis-report.json"), JSON.stringify(report, null, 2));
  console.log("\nfull report: drift-analysis-report.json");
}
main().catch((e) => {
  console.error("[drift-analysis] fatal:", e);
  process.exit(1);
});

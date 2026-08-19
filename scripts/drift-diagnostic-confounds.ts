// Diagnostic-only follow-up to the drift analysis: tests whether the
// +2.50% / +20d Q5-Q1 spread (concentrated in the +10..+20 window) is
// explained by composition/timing confounds rather than the earnings
// surprise itself. No strategy conclusions — measurements only.
//
// Reuses the EXACT sample + quintile-cut methodology from
// drift-analysis.ts (same SQL filters, same contiguous-quintile split)
// so "Q1"/"Q5" here are the identical row sets already reported.
//
// Usage: npx tsx scripts/drift-diagnostic-confounds.ts
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
  if (!Array.isArray(json)) throw new Error(`SQL failed: ${JSON.stringify(json)}\nQuery: ${query.slice(0, 300)}`);
  return json;
}

type Row = {
  symbol: string;
  earnings_date: string;
  timing: string;
  eps_surprise: number;
  price_before: number | null;
  reaction_close: number;
  reaction_date: string;
  d1_close: number | null; d1_date: string | null;
  d3_close: number | null; d3_date: string | null;
  d5_close: number | null; d5_date: string | null;
  d10_close: number | null; d10_date: string | null;
  d20_close: number | null; d20_date: string | null;
};

const HORIZONS = ["drift1", "drift3", "drift5", "drift10", "drift20"] as const;
const HZ_TO_CLOSE: Record<string, string> = { drift1: "d1", drift3: "d3", drift5: "d5", drift10: "d10", drift20: "d20" };

function N(x: any): number { return Number(x); }
function mean(xs: number[]): number { return xs.reduce((s, x) => s + Number(x), 0) / xs.length; }
function median(xs: number[]): number {
  const s = [...xs].map(Number).sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}
function stddevSamp(xs: number[]): number {
  if (xs.length < 2) return NaN;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (Number(x) - m) ** 2, 0) / (xs.length - 1));
}
function se(xs: number[]): number { return stddevSamp(xs) / Math.sqrt(xs.length); }
function quantile(sortedXs: number[], q: number): number {
  const idx = (sortedXs.length - 1) * q;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sortedXs[lo];
  return sortedXs[lo] + (sortedXs[hi] - sortedXs[lo]) * (idx - lo);
}
function fiveNum(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  return { min: s[0], p25: quantile(s, 0.25), median: quantile(s, 0.5), p75: quantile(s, 0.75), max: s[s.length - 1], n: s.length };
}

// Same contiguous ntile(5)-equivalent split as drift-analysis.ts.
function quintileBucket<T>(rows: T[], key: (r: T) => number): T[][] {
  const sorted = [...rows].sort((a, b) => key(a) - key(b));
  const n = sorted.length;
  const base = Math.floor(n / 5);
  const rem = n % 5;
  const buckets: T[][] = [];
  let idx = 0;
  for (let i = 0; i < 5; i++) {
    const size = base + (i < rem ? 1 : 0);
    buckets.push(sorted.slice(idx, idx + size));
    idx += size;
  }
  return buckets;
}

function addDaysIso(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function main() {
  loadEnvLocal();

  console.log("=== rebuilding the primary sample (identical to drift-analysis.ts) ===");
  const raw = (await sql(`
    WITH cand AS (
      SELECT eh.id, eh.symbol, eh.earnings_date::text AS earnings_date, eh.timing, eh.price_before,
             eh.eps_actual, eh.eps_estimate,
             (eh.eps_actual - eh.eps_estimate) / abs(eh.eps_estimate) AS eps_surprise,
             CASE WHEN eh.timing = 'bmo' THEN 0 ELSE 1 END AS reaction_offset
      FROM earnings_history eh
      WHERE eh.date_confidence = 'vendor_derived'
        AND eh.timing IN ('bmo','amc')
        AND eh.eps_actual IS NOT NULL AND eh.eps_estimate IS NOT NULL AND eh.eps_estimate != 0
        AND EXISTS (SELECT 1 FROM earnings_price_paths epp WHERE epp.earnings_history_id = eh.id AND epp.trading_day_offset = 20)
        AND (eh.timing_review_status IS NULL OR eh.timing_review_status != 'flagged_uncertain')
    ),
    paths AS (
      SELECT c.id, epp.trading_day_offset AS off, epp.adj_close, epp.trade_date::text AS trade_date
      FROM cand c
      JOIN earnings_price_paths epp ON epp.earnings_history_id = c.id
      WHERE epp.trading_day_offset BETWEEN -5 AND 25
    )
    SELECT c.symbol, c.earnings_date, c.timing, c.eps_surprise, c.price_before,
      MAX(CASE WHEN p.off = c.reaction_offset THEN p.adj_close END) AS reaction_close,
      MAX(CASE WHEN p.off = c.reaction_offset THEN p.trade_date END) AS reaction_date,
      MAX(CASE WHEN p.off = c.reaction_offset+1 THEN p.adj_close END) AS d1_close,
      MAX(CASE WHEN p.off = c.reaction_offset+1 THEN p.trade_date END) AS d1_date,
      MAX(CASE WHEN p.off = c.reaction_offset+3 THEN p.adj_close END) AS d3_close,
      MAX(CASE WHEN p.off = c.reaction_offset+3 THEN p.trade_date END) AS d3_date,
      MAX(CASE WHEN p.off = c.reaction_offset+5 THEN p.adj_close END) AS d5_close,
      MAX(CASE WHEN p.off = c.reaction_offset+5 THEN p.trade_date END) AS d5_date,
      MAX(CASE WHEN p.off = c.reaction_offset+10 THEN p.adj_close END) AS d10_close,
      MAX(CASE WHEN p.off = c.reaction_offset+10 THEN p.trade_date END) AS d10_date,
      MAX(CASE WHEN p.off = c.reaction_offset+20 THEN p.adj_close END) AS d20_close,
      MAX(CASE WHEN p.off = c.reaction_offset+20 THEN p.trade_date END) AS d20_date
    FROM cand c JOIN paths p ON p.id = c.id
    GROUP BY c.id, c.symbol, c.earnings_date, c.timing, c.eps_surprise, c.price_before
  `)) as Row[];
  console.log(`sample n = ${raw.length}`);

  const buckets = quintileBucket(raw, (r) => Number(r.eps_surprise));
  const q1 = buckets[0], q5 = buckets[4];
  console.log(`Q1 n=${q1.length}, Q5 n=${q5.length}`);

  // ---------------- 1. COMPOSITION ----------------
  const q1Symbols = Array.from(new Set(q1.map((r) => r.symbol)));
  const q5Symbols = Array.from(new Set(q5.map((r) => r.symbol)));
  const allSymbols = Array.from(new Set([...q1Symbols, ...q5Symbols]));
  const symbolOverlap = q1Symbols.filter((s) => q5Symbols.includes(s));
  console.log(
    `\n=== composition: distinct symbols Q1=${q1Symbols.length} Q5=${q5Symbols.length}, ` +
      `overlap (same symbol appears in both quintiles on different dates) = ${symbolOverlap.length} ` +
      `(${((symbolOverlap.length / Math.min(q1Symbols.length, q5Symbols.length)) * 100).toFixed(0)}% of the smaller set) ===`,
  );

  const profileRows = await sql(`
    select symbol, industry, market_cap_billions from stock_profiles where symbol = any(array[${allSymbols.map((s) => `'${s.replace(/'/g, "''")}'`).join(",")}])
  `);
  const snapshotRows = await sql(`
    select symbol, market_cap, price from symbol_market_snapshot where symbol = any(array[${allSymbols.map((s) => `'${s.replace(/'/g, "''")}'`).join(",")}])
  `);
  const profileMap = new Map(profileRows.map((r: any) => [r.symbol, r]));
  const snapshotMap = new Map(snapshotRows.map((r: any) => [r.symbol, r]));

  function industryDist(rows: Row[]) {
    const counts = new Map<string, number>();
    let matched = 0;
    for (const r of rows) {
      const p = profileMap.get(r.symbol);
      const industry = p?.industry ?? "(no stock_profiles row)";
      if (p?.industry) matched += 1;
      counts.set(industry, (counts.get(industry) ?? 0) + 1);
    }
    return { matched, total: rows.length, counts: Array.from(counts.entries()).sort((a, b) => b[1] - a[1]) };
  }
  function marketCapDist(rows: Row[]) {
    const distinctSymbols = Array.from(new Set(rows.map((r) => r.symbol)));
    const fromProfiles = distinctSymbols.map((s) => profileMap.get(s)?.market_cap_billions).filter((v) => v !== undefined && v !== null).map(Number);
    const fromSnapshot = distinctSymbols
      .filter((s) => profileMap.get(s)?.market_cap_billions === undefined || profileMap.get(s)?.market_cap_billions === null)
      .map((s) => snapshotMap.get(s)?.market_cap)
      .filter((v) => v !== undefined && v !== null)
      .map((v) => Number(v) / 1e9);
    const combinedBillions = [...fromProfiles, ...fromSnapshot];
    return {
      distinctSymbols: distinctSymbols.length,
      coveredByProfiles: fromProfiles.length,
      coveredBySnapshotFallback: fromSnapshot.length,
      uncovered: distinctSymbols.length - combinedBillions.length,
      distributionBillions: combinedBillions.length ? fiveNum(combinedBillions) : null,
    };
  }
  function sharePriceDist(rows: Row[]) {
    const vals = rows.map((r) => r.price_before).filter((v): v is number => v !== null).map(Number);
    return { n: vals.length, distribution: vals.length ? fiveNum(vals) : null };
  }

  const composition = {
    q1: { industry: industryDist(q1), marketCap: marketCapDist(q1), sharePrice: sharePriceDist(q1) },
    q5: { industry: industryDist(q5), marketCap: marketCapDist(q5), sharePrice: sharePriceDist(q5) },
  };

  // ---------------- 2. TIMING CLUSTERING ----------------
  function monthDist(rows: Row[]) {
    const counts = new Map<string, number>();
    for (const r of rows) {
      const ym = r.earnings_date.slice(0, 7);
      counts.set(ym, (counts.get(ym) ?? 0) + 1);
    }
    return Array.from(counts.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }
  function dateStats(rows: Row[]) {
    const epochDays = rows.map((r) => Math.round(new Date(r.earnings_date + "T00:00:00Z").getTime() / 86400000));
    const sorted = [...epochDays].sort((a, b) => a - b);
    const meanDay = mean(epochDays);
    const medianDay = median(epochDays);
    const toIso = (d: number) => new Date(d * 86400000).toISOString().slice(0, 10);
    return { meanDate: toIso(Math.round(meanDay)), medianDate: toIso(Math.round(medianDay)), minDate: toIso(sorted[0]), maxDate: toIso(sorted[sorted.length - 1]) };
  }
  const timingClustering = {
    q1: { byMonth: monthDist(q1), stats: dateStats(q1) },
    q5: { byMonth: monthDist(q5), stats: dateStats(q5) },
  };
  const q1Mean = new Date(timingClustering.q1.stats.meanDate).getTime();
  const q5Mean = new Date(timingClustering.q5.stats.meanDate).getTime();
  const meanDateGapDays = Math.round(Math.abs(q1Mean - q5Mean) / 86400000);

  // ---------------- 3. BENCHMARK ADJUSTMENT (SPY excess return) ----------------
  console.log("\n=== fetching SPY daily bars for benchmark adjustment ===");
  const allDates = raw.flatMap((r) => [r.reaction_date, r.d1_date, r.d3_date, r.d5_date, r.d10_date, r.d20_date]).filter((d): d is string => !!d);
  const minDate = allDates.reduce((a, b) => (a < b ? a : b));
  const maxDate = allDates.reduce((a, b) => (a > b ? a : b));

  const YahooFinanceMod = (await import("yahoo-finance2")).default;
  const yf = new (YahooFinanceMod as unknown as new () => {
    historical: (symbol: string, opts: { period1: Date; period2: Date; interval: "1d" }, moduleOpts: { validateResult: boolean }) => Promise<Array<{ date: Date; close: number; adjClose?: number }>>;
    suppressNotices?: (keys: string[]) => void;
  })();
  try { yf.suppressNotices?.(["yahooSurvey"]); } catch { /* cosmetic */ }
  const spyBars = await yf.historical(
    "SPY",
    { period1: new Date(addDaysIso(minDate, -5) + "T00:00:00Z"), period2: new Date(addDaysIso(maxDate, 5) + "T00:00:00Z"), interval: "1d" },
    { validateResult: false },
  );
  const spyMap = new Map<string, number>();
  for (const b of spyBars) {
    const iso = b.date instanceof Date ? b.date.toISOString().slice(0, 10) : String(b.date).slice(0, 10);
    if (typeof b.adjClose === "number" && Number.isFinite(b.adjClose)) spyMap.set(iso, b.adjClose);
  }
  console.log(`SPY bars fetched: ${spyMap.size} (${minDate} .. ${maxDate})`);

  type ExcessRow = Row & { excess: Record<string, number | null> };
  let spyLookupMisses = 0;
  let spyReactionBaseMisses = 0;
  const withExcess: ExcessRow[] = raw.map((r) => {
    const excess: Record<string, number | null> = {};
    const spyReaction = spyMap.get(r.reaction_date);
    if (spyReaction === undefined) spyReactionBaseMisses += 1;
    for (const h of HORIZONS) {
      const closeKey = HZ_TO_CLOSE[h] + "_close";
      const dateKey = HZ_TO_CLOSE[h] + "_date";
      const close = (r as any)[closeKey] as number | null;
      const date = (r as any)[dateKey] as string | null;
      if (close === null || date === null || spyReaction === undefined) { excess[h] = null; continue; }
      const spyHz = spyMap.get(date);
      if (spyHz === undefined) { excess[h] = null; spyLookupMisses += 1; continue; }
      const stockDrift = close / r.reaction_close - 1;
      const spyDrift = spyHz / spyReaction - 1;
      excess[h] = stockDrift - spyDrift;
    }
    return { ...r, excess };
  });
  console.log(
    `spy reaction-date base misses (whole row drops out of ALL horizons): ${spyReactionBaseMisses}; ` +
      `spy horizon-date misses (single-cell drops): ${spyLookupMisses}`,
  );

  const excessBuckets = quintileBucket(withExcess, (r) => Number(r.eps_surprise));
  function measureExcessBucket(bucket: ExcessRow[]) {
    const out: Record<string, { n: number; mean: number; median: number; se: number }> = {};
    for (const h of HORIZONS) {
      const vals = bucket.map((r) => r.excess[h]).filter((v): v is number => v !== null);
      out[h] = { n: vals.length, mean: vals.length ? mean(vals) : NaN, median: vals.length ? median(vals) : NaN, se: vals.length >= 2 ? se(vals) : NaN };
    }
    return out;
  }
  const excessStats = excessBuckets.map(measureExcessBucket);
  const excessSpread: Record<string, { spread: number; se: number; ratio: number; n_top: number; n_bottom: number }> = {};
  for (const h of HORIZONS) {
    const t = excessStats[4][h], b = excessStats[0][h];
    const spread = t.mean - b.mean;
    const spreadSe = Math.sqrt(t.se ** 2 + b.se ** 2);
    excessSpread[h] = { spread, se: spreadSe, ratio: spread / spreadSe, n_top: t.n, n_bottom: b.n };
  }

  // ---------------- SANITY CHECK: rebuilt sample must match the published run ----------------
  // Acceptance criterion, stated before looking: Q5-Q1 spread for
  // cumulative drift10/drift20 on this rebuilt sample must match the
  // already-published +0.52% / +2.50% to within floating-point noise.
  // If not, this diagnostic is running on a different sample than what
  // was reported and must not be used until reconciled.
  function rawCumStats(bucket: Row[], hz: "d10" | "d20") {
    const closeKey = (hz + "_close") as "d10_close" | "d20_close";
    const vals: number[] = [];
    for (const r of bucket) {
      const c = r[closeKey];
      if (c !== null) vals.push(N(c) / N(r.reaction_close) - 1);
    }
    return { n: vals.length, mean: vals.length ? mean(vals) : NaN };
  }
  const rawD10Top = rawCumStats(buckets[4], "d10"), rawD10Bot = rawCumStats(buckets[0], "d10");
  const rawD20Top = rawCumStats(buckets[4], "d20"), rawD20Bot = rawCumStats(buckets[0], "d20");
  const sanityCheck = {
    drift10Spread: rawD10Top.mean - rawD10Bot.mean,
    drift10ExpectedApprox: 0.0052,
    drift20Spread: rawD20Top.mean - rawD20Bot.mean,
    drift20ExpectedApprox: 0.025,
  };
  const sanityOk =
    Math.abs(sanityCheck.drift10Spread - sanityCheck.drift10ExpectedApprox) < 0.001 &&
    Math.abs(sanityCheck.drift20Spread - sanityCheck.drift20ExpectedApprox) < 0.001;
  console.log(`\n=== sanity check vs. published spreads ===`);
  console.log(JSON.stringify(sanityCheck, null, 2));
  console.log(sanityOk ? "PASS — rebuilt sample matches the published run" : "MISMATCH — STOP, do not report until reconciled");
  if (!sanityOk) {
    throw new Error("Sanity check failed: rebuilt sample does not match the previously published drift-analysis.ts spreads. Aborting before computing diagnostics on a divergent sample.");
  }

  // ---------------- 4. HORIZON SHAPE: two legs side by side ----------------
  // Leg A: +0 (reaction close) -> +10 (this is just drift10, restated
  // here for direct visual comparison). Leg B: +10 -> +20, computed
  // standalone (not inferred from the difference of two cumulative
  // figures) so the "flat then jumps" shape is directly visible.
  function legAStats(bucket: Row[]) {
    const vals: number[] = [];
    for (const r of bucket) if (r.d10_close !== null) vals.push(N(r.d10_close) / N(r.reaction_close) - 1);
    return { n: vals.length, mean: vals.length ? mean(vals) : NaN, median: vals.length ? median(vals) : NaN, se: vals.length >= 2 ? se(vals) : NaN };
  }
  function legBStats(bucket: Row[]) {
    const vals: number[] = [];
    for (const r of bucket) if (r.d10_close !== null && r.d20_close !== null) vals.push(N(r.d20_close) / N(r.d10_close) - 1);
    return { n: vals.length, mean: vals.length ? mean(vals) : NaN, median: vals.length ? median(vals) : NaN, se: vals.length >= 2 ? se(vals) : NaN };
  }
  const legAByBucket = buckets.map(legAStats);
  const legBByBucket = buckets.map(legBStats);
  const legATop = legAByBucket[4], legABottom = legAByBucket[0];
  const legBTop = legBByBucket[4], legBBottom = legBByBucket[0];
  const legASpread = legATop.mean - legABottom.mean;
  const legASpreadSe = Math.sqrt(legATop.se ** 2 + legABottom.se ** 2);
  const legBSpread = legBTop.mean - legBBottom.mean;
  const legBSpreadSe = Math.sqrt(legBTop.se ** 2 + legBBottom.se ** 2);

  const report = {
    sampleN: raw.length,
    q1n: q1.length,
    q5n: q5.length,
    sanityCheck: { ...sanityCheck, passed: sanityOk },
    symbolOverlapQ1Q5: symbolOverlap.length,
    composition,
    timingClustering: { ...timingClustering, meanDateGapDays },
    benchmark: {
      spyBarsFetched: spyMap.size,
      spyReactionBaseMisses,
      spyLookupMisses,
      buckets: excessStats,
      spread: excessSpread,
    },
    horizonShape: {
      leg0to10ByBucket: legAByBucket,
      leg10to20ByBucket: legBByBucket,
      leg0to10Spread: { spread: legASpread, se: legASpreadSe, ratio: legASpread / legASpreadSe, n_top: legATop.n, n_bottom: legABottom.n },
      leg10to20Spread: { spread: legBSpread, se: legBSpreadSe, ratio: legBSpread / legBSpreadSe, n_top: legBTop.n, n_bottom: legBBottom.n },
    },
    generatedAt: new Date().toISOString(),
  };

  writeFileSync(resolve(process.cwd(), "drift-diagnostic-confounds-report.json"), JSON.stringify(report, null, 2));
  console.log("\nfull report: drift-diagnostic-confounds-report.json");
  console.log(JSON.stringify({ symbolOverlap: symbolOverlap.length, meanDateGapDays, excessSpread, legASpread, legBSpread }, null, 2));
}
main().catch((e) => {
  console.error("[drift-diagnostic-confounds] fatal:", e);
  process.exit(1);
});

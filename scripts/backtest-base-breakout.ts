// Backtest for the Base Breakout screener (lib/base-breakout.ts) —
// weekly checkpoints across available price history, actionable count
// per week, and gate-attribution ("which gate binds most often").
//
// No precedent exists for this: neither RS Pullback nor any other tab
// in this repo has ever had a backtest script (confirmed via repo-wide
// search, including git history) — "the same way RS Pullback was" refers
// to an ad hoc, never-saved analysis. This is built from scratch.
//
// Scope, stated explicitly: gates + actionable-count + gate-attribution
// ONLY — no R:R. Base Breakout's target/stop derivation partly depends
// on q.analystTarget (Yahoo's live consensus price target), which has no
// historical/point-in-time source anywhere in this codebase — a
// backtested R:R would have to fabricate that input. Base Breakout IS
// otherwise fully bar-derivable (base, trigger, RVOL, freshness, and the
// 200MA check all come from one OHLCV fetch per symbol via
// getHistoricalPrices), unlike RS Pullback, which also needs point-in-
// time 52w-high/low, sector, and earnings-date fields with no historical
// source here either — so this backtest's gate coverage is complete even
// though its R:R coverage is deliberately absent. The live validation
// run (see the conversation) is where the R:R distribution comes from.
//
// Usage:
//   npx tsx --env-file=.env.local scripts/backtest-base-breakout.ts [--symbols=N] [--years=N]
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function loadEnvLocal(): void {
  try {
    const content = readFileSync(resolve(process.cwd(), ".env.local"), "utf8");
    for (const line of content.split("\n")) {
      const eq = line.indexOf("=");
      if (eq === -1 || line.trim().startsWith("#")) continue;
      const k = line.slice(0, eq).trim();
      if (!process.env[k]) process.env[k] = line.slice(eq + 1).trim();
    }
  } catch {
    /* ignore */
  }
}
loadEnvLocal();

type Bar = { date: string; open: number; high: number; low: number; close: number; volume: number };

function parseArgs(): { symbolCap: number | null; years: number } {
  const args = process.argv.slice(2);
  let symbolCap: number | null = null;
  let years = 2;
  for (const a of args) {
    const symbolsMatch = a.match(/^--symbols=(\d+)$/);
    const yearsMatch = a.match(/^--years=(\d+)$/);
    if (symbolsMatch) symbolCap = Number(symbolsMatch[1]);
    if (yearsMatch) years = Number(yearsMatch[1]);
  }
  return { symbolCap, years };
}

// Weekly checkpoint index: the last trading-day index at or before each
// Friday across the fetched range. bars: oldest-first, already sorted.
function weeklyCheckpointIndices(bars: Bar[]): number[] {
  const out: number[] = [];
  let lastWeekKey = "";
  for (let i = 0; i < bars.length; i += 1) {
    const d = new Date(bars[i].date + "T00:00:00Z");
    // ISO week key (year-week) so a checkpoint fires once per calendar
    // week, on that week's LAST available trading day (since we overwrite
    // out[out.length-1] rather than push on every day of the same week).
    const day = d.getUTCDay();
    const diffToMonday = (day + 6) % 7;
    const monday = new Date(d);
    monday.setUTCDate(d.getUTCDate() - diffToMonday);
    const weekKey = monday.toISOString().slice(0, 10);
    if (weekKey !== lastWeekKey) {
      out.push(i);
      lastWeekKey = weekKey;
    } else {
      out[out.length - 1] = i;
    }
  }
  return out;
}

async function main() {
  const { symbolCap, years } = parseArgs();

  const { getHistoricalPrices } = await import("../lib/yahoo");
  const { SWING_UNIVERSE } = await import("../lib/stock-universe");
  const { evaluateBaseBreakout, classifyBaseBreakout, DEFAULT_BASE_BREAKOUT_THRESHOLDS } = await import(
    "../lib/base-breakout"
  );
  const { computeSMA } = await import("../lib/indicators");

  const thresholds = DEFAULT_BASE_BREAKOUT_THRESHOLDS;
  const universe = symbolCap ? SWING_UNIVERSE.slice(0, symbolCap) : SWING_UNIVERSE;
  console.log(
    `Backtesting Base Breakout: ${universe.length} symbols, ${years} year(s) of history, weekly checkpoints.\n`,
  );

  const to = new Date();
  const from = new Date(to);
  from.setUTCFullYear(from.getUTCFullYear() - years);

  // Minimum bars needed before the FIRST checkpoint can be evaluated —
  // mirrors lib/base-breakout.ts's MIN_BARS_NEEDED (75); duplicated here
  // (not imported — that constant is module-private) since the search
  // floor/ceiling and trigger lookback are all internal to
  // evaluateBaseBreakout anyway; this is just where to start iterating
  // checkpoints from.
  const MIN_BARS_NEEDED = 75;

  const startedAt = Date.now();
  let symbolsProcessed = 0;
  let symbolsSkippedNoHistory = 0;

  // Per-week aggregates, keyed by the checkpoint's calendar date (the
  // trading day that week's checkpoint landed on).
  type WeekAgg = {
    ready: number;
    leadingExtended: number;
    inZoneLagging: number;
    nearMiss: number;
    excluded: number;
    gateFailCounts: Record<string, number>; // tallied across near-miss + excluded, one +1 per failing gate
  };
  const weeks = new Map<string, WeekAgg>();
  function weekAgg(dateKey: string): WeekAgg {
    let w = weeks.get(dateKey);
    if (!w) {
      w = {
        ready: 0,
        leadingExtended: 0,
        inZoneLagging: 0,
        nearMiss: 0,
        excluded: 0,
        gateFailCounts: { base_range: 0, base_length: 0, atr_contraction: 0, rvol: 0, adr_floor: 0 },
      };
      weeks.set(dateKey, w);
    }
    return w;
  }

  const CONCURRENCY = 6;
  let idx = 0;
  async function worker() {
    while (idx < universe.length) {
      const i = idx++;
      const symbol = universe[i];
      let rows: Array<{ date: Date; open: number; high: number; low: number; close: number; volume: number }>;
      try {
        rows = await getHistoricalPrices(symbol, from, to);
      } catch {
        symbolsSkippedNoHistory += 1;
        continue;
      }
      if (!rows || rows.length < MIN_BARS_NEEDED) {
        symbolsSkippedNoHistory += 1;
        continue;
      }
      const bars: Bar[] = rows
        .map((r) => ({
          date: r.date.toISOString().slice(0, 10),
          open: r.open,
          high: r.high,
          low: r.low,
          close: r.close,
          volume: r.volume,
        }))
        .sort((a, b) => a.date.localeCompare(b.date));

      const checkpoints = weeklyCheckpointIndices(bars).filter((ci) => ci + 1 >= MIN_BARS_NEEDED);
      for (const ci of checkpoints) {
        const slice = bars.slice(0, ci + 1); // bars up to and including this checkpoint day
        const currentPrice = slice[slice.length - 1].close;
        const dateKey = slice[slice.length - 1].date;

        // Trend gate (above 200d) — pregate-level in the live path, using
        // Yahoo's point-quote ma200; here it's bars-derived (only source
        // available historically). Same treatment as the "not above a
        // rising 50-day" design decision: 200-session SMA needs 200 bars,
        // which a `years=1` run won't always have for the earliest
        // checkpoints — those simply can't evaluate the trend gate and
        // are skipped (not counted as excluded-by-trend, since we don't
        // actually know).
        if (slice.length < 200) continue;
        const sma200 = computeSMA(
          slice.map((b) => b.close),
          200,
        );
        if (sma200 === null || currentPrice <= sma200) continue;

        const ev = evaluateBaseBreakout(slice, thresholds);
        if (ev === null) continue;
        const classified = classifyBaseBreakout(ev, currentPrice, thresholds);

        const w = weekAgg(dateKey);
        if (classified.list === "ready") w.ready += 1;
        else if (classified.list === "leading_extended") w.leadingExtended += 1;
        else if (classified.list === "in_zone_lagging") w.inZoneLagging += 1;
        else if (classified.nearMiss !== null) {
          w.nearMiss += 1;
          w.gateFailCounts[classified.nearMiss.gate] += 1;
        } else {
          w.excluded += 1;
          for (const g of ev.gates) {
            if (!g.pass) w.gateFailCounts[g.gate] += 1;
          }
        }
      }
      symbolsProcessed += 1;
      if (symbolsProcessed % 25 === 0) {
        const elapsedS = (Date.now() - startedAt) / 1000;
        console.log(`  ...${symbolsProcessed}/${universe.length} symbols (${elapsedS.toFixed(0)}s elapsed)`);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  console.log(
    `\nDone. ${symbolsProcessed} symbols processed, ${symbolsSkippedNoHistory} skipped (insufficient history). ` +
      `${((Date.now() - startedAt) / 1000).toFixed(0)}s total.\n`,
  );

  const sortedWeeks = Array.from(weeks.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  console.log(`================ Weekly actionable counts (${sortedWeeks.length} weeks) ================\n`);
  console.log("week        ready  lead-ext  in-zone  near-miss  excluded");
  let totalReady = 0;
  let totalLeadExt = 0;
  for (const [date, w] of sortedWeeks) {
    console.log(
      `${date}  ${String(w.ready).padStart(5)}  ${String(w.leadingExtended).padStart(8)}  ` +
        `${String(w.inZoneLagging).padStart(7)}  ${String(w.nearMiss).padStart(9)}  ${String(w.excluded).padStart(8)}`,
    );
    totalReady += w.ready;
    totalLeadExt += w.leadingExtended;
  }

  const nWeeks = sortedWeeks.length || 1;
  console.log(`\n================ Summary ================\n`);
  console.log(`Actionable (ready) per week: mean=${(totalReady / nWeeks).toFixed(2)}, total=${totalReady} across ${nWeeks} weeks`);
  console.log(
    `Actionable (ready + leading_extended) per week: mean=${((totalReady + totalLeadExt) / nWeeks).toFixed(2)}, total=${totalReady + totalLeadExt}`,
  );

  const gateTotals: Record<string, number> = { base_range: 0, base_length: 0, atr_contraction: 0, rvol: 0, adr_floor: 0 };
  for (const [, w] of sortedWeeks) {
    for (const [gate, n] of Object.entries(w.gateFailCounts)) gateTotals[gate] += n;
  }
  console.log(`\n================ Which gate binds most often ================\n`);
  console.log("(tallied across near-miss + fully-excluded symbol-weeks; a fully-excluded week can tally more than one gate)\n");
  const rankedGates = Object.entries(gateTotals).sort((a, b) => b[1] - a[1]);
  for (const [gate, n] of rankedGates) {
    console.log(`  ${gate.padEnd(16)} ${n}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

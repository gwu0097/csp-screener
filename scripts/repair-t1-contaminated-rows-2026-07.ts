// One-off repair script (NOT committed to the repo — scratchpad only).
// Repairs the 35 T1-same-session-contaminated earnings_history rows
// identified by the outcome-scoring pass. Dry-run by default; pass
// --write to actually execute the UPDATEs.
//
// Usage:
//   npx tsx --env-file=.env.local --tsconfig tsconfig.json <this file>          (dry run, prints the plan)
//   npx tsx --env-file=.env.local --tsconfig tsconfig.json <this file> --write  (executes)

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { getHistoricalPrices } from "@/lib/yahoo";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const sb = createClient(url, key);

const WRITE = process.argv.includes("--write");

// Ground truth pulled live via mcp__robinhood__get_earnings_calendar
// (2026-07-15..2026-07-31 window, high_market_cap filter, cross-
// checked against the contaminated set's own earnings_date). 33 of 35
// confirmed AMC ("pm"); 1 confirmed BMO ("am", BX) — that one is NOT
// the bug this repairs (same-day capture is correct for BMO) and is
// left untouched. XOM's earnings_history row is dated 2026-07-24 but
// Robinhood's only Q2 XOM report is 2026-07-31 (still eps.actual=null,
// i.e. not yet reported) — the DB row's date itself looks wrong, not
// reconstructable with confidence, so it's nulled rather than repaired.
const CONFIRMED_AMC: string[] = [
  "AAPL", "ALGN", "AMZN", "ARM", "BE", "CDNS", "CMG", "COF", "COIN", "DECK",
  "DLR", "DXCM", "EQT", "FTNT", "GDDY", "IBM", "INTC", "ISRG", "JBHT", "KMI",
  "LVS", "LYV", "MGM", "MSFT", "MSTR", "NEM", "NFLX", "QCOM", "SBUX", "TSLA",
  "UAL", "URI", "V",
];
const CONFIRMED_BMO_SKIP = new Set(["BX"]);
const DATE_MISMATCH_NULL = new Set(["XOM"]);

type ContamRow = {
  symbol: string;
  earnings_date: string;
  actual_move_pct: string | null;
  implied_move_pct: string | null;
  move_ratio: string | null;
  iv_before: string | null;
  iv_after: string | null;
  iv_crush_magnitude: string | null;
};

async function main() {
  const raw = JSON.parse(
    readFileSync(
      "/private/tmp/claude-501/-Users-raitsai-csp-screener/ab3c3900-236c-448e-8535-85d682a53a99/scratchpad/pre_repair_snapshot_earnings_history.json",
      "utf8",
    ),
  ) as ContamRow[];
  console.log(`Loaded ${raw.length} pre-repair contaminated rows.`);

  const results: Array<{ symbol: string; earnings_date: string; action: string; detail: string }> = [];

  for (const row of raw) {
    const { symbol, earnings_date } = row;

    if (CONFIRMED_BMO_SKIP.has(symbol)) {
      results.push({ symbol, earnings_date, action: "SKIP (confirmed BMO, not this bug)", detail: "no change" });
      continue;
    }
    if (DATE_MISMATCH_NULL.has(symbol)) {
      results.push({ symbol, earnings_date, action: "NULL (date mismatch, unreconstructable)", detail: "actual_move_pct, move_ratio -> null" });
      if (WRITE) {
        const { error } = await sb
          .from("earnings_history")
          .update({ actual_move_pct: null, move_ratio: null, timing: "bmo" })
          .eq("symbol", symbol)
          .eq("earnings_date", earnings_date);
        if (error) console.error(`  [ERROR] ${symbol}: ${error.message}`);
      }
      continue;
    }
    if (!CONFIRMED_AMC.includes(symbol)) {
      results.push({ symbol, earnings_date, action: "SKIP (no ground-truth timing found)", detail: "no change — needs manual review" });
      continue;
    }

    // AMC repair: close(earnings_date) -> close(next trading session).
    const from = new Date(new Date(earnings_date + "T00:00:00Z").getTime() - 10 * 24 * 60 * 60 * 1000);
    const to = new Date(new Date(earnings_date + "T00:00:00Z").getTime() + 10 * 24 * 60 * 60 * 1000);
    let bars;
    try {
      bars = await getHistoricalPrices(symbol, from, to);
    } catch (e) {
      results.push({ symbol, earnings_date, action: "NULL (price fetch failed)", detail: e instanceof Error ? e.message : String(e) });
      continue;
    }
    const sorted = [...bars].sort((a, b) => a.date.getTime() - b.date.getTime());
    const earnIso = earnings_date;
    const closeOnEarn = sorted.find((b) => b.date.toISOString().slice(0, 10) === earnIso);
    const idx = closeOnEarn ? sorted.indexOf(closeOnEarn) : -1;
    const nextBar = idx >= 0 && idx + 1 < sorted.length ? sorted[idx + 1] : null;

    if (!closeOnEarn || !nextBar || !(closeOnEarn.close > 0)) {
      results.push({
        symbol,
        earnings_date,
        action: "NULL (missing session bars)",
        detail: `closeOnEarn=${closeOnEarn ? closeOnEarn.close : "null"} nextBar=${nextBar ? nextBar.close : "null"}`,
      });
      if (WRITE) {
        const { error } = await sb
          .from("earnings_history")
          .update({ actual_move_pct: null, move_ratio: null, timing: "amc" })
          .eq("symbol", symbol)
          .eq("earnings_date", earnings_date);
        if (error) console.error(`  [ERROR] ${symbol}: ${error.message}`);
      }
      continue;
    }

    const recomputedActual = (nextBar.close - closeOnEarn.close) / closeOnEarn.close;
    const implied = row.implied_move_pct !== null ? Number(row.implied_move_pct) : null;
    const recomputedRatio = implied !== null && implied > 0 ? Math.abs(recomputedActual) / implied : null;

    results.push({
      symbol,
      earnings_date,
      action: "REPAIR",
      detail:
        `old actual=${row.actual_move_pct} -> new actual=${recomputedActual.toFixed(4)} ` +
        `(close ${earnIso}=${closeOnEarn.close.toFixed(2)} -> close ${nextBar.date.toISOString().slice(0, 10)}=${nextBar.close.toFixed(2)}); ` +
        `old ratio=${row.move_ratio} -> new ratio=${recomputedRatio !== null ? recomputedRatio.toFixed(4) : "null"}`,
    });

    if (WRITE) {
      const { error } = await sb
        .from("earnings_history")
        .update({
          actual_move_pct: recomputedActual,
          move_ratio: recomputedRatio,
          timing: "amc",
        })
        .eq("symbol", symbol)
        .eq("earnings_date", earnings_date);
      if (error) console.error(`  [ERROR] ${symbol}: ${error.message}`);
    }
  }

  console.log(`\n${WRITE ? "=== EXECUTED ===" : "=== DRY RUN (pass --write to execute) ==="}\n`);
  let repaired = 0;
  let nulled = 0;
  let skipped = 0;
  for (const r of results) {
    console.log(`  ${r.symbol.padEnd(6)} ${r.earnings_date}  ${r.action.padEnd(35)} ${r.detail}`);
    if (r.action === "REPAIR") repaired++;
    else if (r.action.startsWith("NULL")) nulled++;
    else skipped++;
  }
  console.log(`\nTotals: repaired=${repaired} nulled=${nulled} skipped(not-this-bug)=${skipped} total=${results.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

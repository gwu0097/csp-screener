// End-to-end test of lib/encyclopedia.ts against live Finnhub + Yahoo +
// Supabase. Requires the stock_encyclopedia and earnings_history tables
// to be created first.
//
// Run: node --env-file=.env.local --import=tsx test/test-encyclopedia.ts
import { updateEncyclopedia } from "../lib/encyclopedia";
import { createServerClient } from "../lib/supabase";

async function printSymbol(symbol: string) {
  const sb = createServerClient();
  const encRes = await sb
    .from("stock_encyclopedia")
    .select("*")
    .eq("symbol", symbol)
    .limit(1);
  const enc = (encRes.data ?? [])[0] as
    | {
        total_earnings_records: number;
        crush_rate: number | null;
        avg_move_ratio: number | null;
        beat_rate: number | null;
        recovery_rate_after_breach: number | null;
        last_historical_pull_date: string | null;
        updated_at: string;
      }
    | undefined;
  console.log(`\n=== ${symbol} encyclopedia ===`);
  if (!enc) {
    console.log("  (no row)");
  } else {
    console.log(`  total_earnings_records = ${enc.total_earnings_records}`);
    console.log(
      `  crush_rate = ${enc.crush_rate !== null ? (enc.crush_rate * 100).toFixed(1) + "%" : "null"}`,
    );
    console.log(
      `  avg_move_ratio = ${enc.avg_move_ratio !== null ? enc.avg_move_ratio.toFixed(3) : "null"}`,
    );
    console.log(
      `  beat_rate = ${enc.beat_rate !== null ? (enc.beat_rate * 100).toFixed(1) + "%" : "null"}`,
    );
    console.log(
      `  recovery_rate_after_breach = ${enc.recovery_rate_after_breach !== null ? (enc.recovery_rate_after_breach * 100).toFixed(1) + "%" : "null"}`,
    );
    console.log(`  last_historical_pull_date = ${enc.last_historical_pull_date}`);
  }

  const histRes = await sb
    .from("earnings_history")
    .select(
      "earnings_date,eps_estimate,eps_actual,eps_surprise_pct,price_before,price_after,actual_move_pct,implied_move_pct,move_ratio,two_x_em_strike,breached_two_x_em,recovered_by_expiry,price_at_expiry,is_complete",
    )
    .eq("symbol", symbol)
    .order("earnings_date", { ascending: false });
  const rows = (histRes.data ?? []) as Array<{
    earnings_date: string;
    eps_estimate: number | null;
    eps_actual: number | null;
    eps_surprise_pct: number | null;
    price_before: number | null;
    price_after: number | null;
    actual_move_pct: number | null;
    implied_move_pct: number | null;
    move_ratio: number | null;
    two_x_em_strike: number | null;
    breached_two_x_em: boolean | null;
    recovered_by_expiry: boolean | null;
    price_at_expiry: number | null;
    is_complete: boolean;
  }>;
  console.log(`\n  last 5 history rows (of ${rows.length}):`);
  console.log(
    "  DATE       EST     ACT     SURP%    PRE      POST     MOVE%   IMP%    RATIO   2xEM     BRC  REC  COMPL",
  );
  for (const r of rows.slice(0, 5)) {
    const fmt = (v: number | null, d: number) =>
      v === null ? "    —" : v.toFixed(d).padStart(7);
    const bool = (b: boolean | null) => (b === null ? " —" : b ? "✓ " : "· ");
    console.log(
      `  ${r.earnings_date} ${fmt(r.eps_estimate, 2)} ${fmt(r.eps_actual, 2)} ${
        r.eps_surprise_pct !== null ? (r.eps_surprise_pct * 100).toFixed(1).padStart(6) + "%" : "     —"
      } ${fmt(r.price_before, 2)} ${fmt(r.price_after, 2)} ${
        r.actual_move_pct !== null ? (r.actual_move_pct * 100).toFixed(2).padStart(6) + "%" : "     —"
      } ${
        r.implied_move_pct !== null ? (r.implied_move_pct * 100).toFixed(2).padStart(6) + "%" : "     —"
      } ${fmt(r.move_ratio, 2)} ${fmt(r.two_x_em_strike, 2)}  ${bool(r.breached_two_x_em)} ${bool(r.recovered_by_expiry)} ${r.is_complete ? "✓" : "·"}`,
    );
  }

  // Sanity checks
  const moveRatios = rows
    .map((r) => r.move_ratio)
    .filter((v): v is number => v !== null && Number.isFinite(v));
  if (moveRatios.length > 0) {
    const min = Math.min(...moveRatios);
    const max = Math.max(...moveRatios);
    console.log(
      `\n  move_ratio range: ${min.toFixed(2)}..${max.toFixed(2)} (n=${moveRatios.length})`,
    );
  }
  return rows.length;
}

async function main() {
  console.log("--- updateEncyclopedia('NOW') ---");
  const nowRes = await updateEncyclopedia("NOW");
  console.log(
    `  newRecords=${nowRes.newRecords} updatedRecords=${nowRes.updatedRecords} isComplete=${nowRes.isComplete}`,
  );

  console.log("\n--- updateEncyclopedia('TSLA') ---");
  const tslaRes = await updateEncyclopedia("TSLA");
  console.log(
    `  newRecords=${tslaRes.newRecords} updatedRecords=${tslaRes.updatedRecords} isComplete=${tslaRes.isComplete}`,
  );

  const nowCount = await printSymbol("NOW");
  const tslaCount = await printSymbol("TSLA");

  console.log("\n=== Summary ===");
  console.log(`NOW history rows: ${nowCount}`);
  console.log(`TSLA history rows: ${tslaCount}`);
  if (nowCount < 4 && tslaCount < 4) {
    console.log(
      "\n⚠ Low row counts — Finnhub /stock/earnings on the free tier only returns ~4 quarters per call.",
    );
    console.log(
      "  Historical backfill beyond 4 quarters requires paid Finnhub tier or a secondary source.",
    );
  }
}

main().catch((e) => {
  console.error("test error:", e);
  process.exit(1);
});

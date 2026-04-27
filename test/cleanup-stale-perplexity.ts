// One-time cleanup: null the Perplexity fields on NOW/TSLA rows whose
// actual_move_pct was changed by the Phase 2C reingest. These rows have
// narrative content generated against the old (wrong) move, so we clear
// and let runEncyclopediaMaintenance re-pull against the corrected data.
import { createServerClient } from "../lib/supabase";
import { runEncyclopediaMaintenance } from "../lib/encyclopedia";

async function main() {
  const sb = createServerClient();

  // Snapshot before so we can see what was cleared.
  const before = await sb
    .from("earnings_history")
    .select("symbol,earnings_date,actual_move_pct,analyst_sentiment,news_summary,perplexity_pulled_at")
    .in("symbol", ["NOW", "TSLA"]);
  const beforeRows = (before.data ?? []) as Array<{
    symbol: string;
    earnings_date: string;
    actual_move_pct: number | null;
    analyst_sentiment: string | null;
    news_summary: string | null;
    perplexity_pulled_at: string | null;
  }>;
  console.log(`pre-cleanup: ${beforeRows.length} NOW/TSLA rows`);
  for (const r of beforeRows) {
    const mv = r.actual_move_pct !== null ? (r.actual_move_pct * 100).toFixed(2) + "%" : "—";
    console.log(
      `  ${r.symbol} ${r.earnings_date}  move=${mv}  sentiment=${r.analyst_sentiment ?? "—"}  pulled_at=${r.perplexity_pulled_at ? "✓" : "·"}`,
    );
  }

  // Clear every NOW/TSLA row — all of them were subject to reingest and
  // their narrative (if any) is therefore suspect.
  const clear = await sb
    .from("earnings_history")
    .update({
      analyst_sentiment: null,
      news_summary: null,
      perplexity_pulled_at: null,
    })
    .in("symbol", ["NOW", "TSLA"]);
  console.log(`\ncleared: error=${clear.error?.message ?? "none"}`);

  // Now run maintenance to re-pull.
  console.log(`\n--- runEncyclopediaMaintenance() ---`);
  const report = await runEncyclopediaMaintenance();
  console.log(
    `symbolsProcessed=${report.symbolsProcessed} t0=${report.t0Captured.length} t1=${report.t1Captured.length} expiry=${report.expiryBackfilled.length} perplexity=${report.perplexityBackfilled.length} errors=${report.errors.length}`,
  );
  console.log("re-pulled:");
  for (const x of report.perplexityBackfilled) console.log(`  ${x.symbol} ${x.earnings_date}`);
  if (report.errors.length > 0) {
    console.log("errors:");
    for (const e of report.errors) console.log(`  ${e.stage} ${e.symbol} ${e.earnings_date} → ${e.reason}`);
  }

  // Inspect the NOW 2026-04-22 row specifically.
  console.log(`\n--- NOW 2026-04-22 post-repull ---`);
  const now422 = await sb
    .from("earnings_history")
    .select("actual_move_pct,analyst_sentiment,news_summary")
    .eq("symbol", "NOW")
    .eq("earnings_date", "2026-04-22")
    .limit(1);
  const row = ((now422.data ?? [])[0] as
    | { actual_move_pct: number | null; analyst_sentiment: string | null; news_summary: string | null }
    | undefined);
  if (!row) {
    console.log("  (no row — nothing to verify)");
    return;
  }
  const mv = row.actual_move_pct !== null ? (row.actual_move_pct * 100).toFixed(2) + "%" : "—";
  console.log(`  actual_move_pct: ${mv}`);
  console.log(`  analyst_sentiment: ${row.analyst_sentiment}`);
  if (row.news_summary) {
    try {
      const parsed = JSON.parse(row.news_summary) as Record<string, unknown>;
      console.log(`  summary: ${parsed.summary}`);
      console.log(`  primary_reason_for_move: ${parsed.primary_reason_for_move}`);
    } catch {
      console.log(`  news_summary (unparseable): ${row.news_summary.slice(0, 200)}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

// End-to-end tests for Phase 2A capture functions + orchestrator.
// Run: node --env-file=.env.local --import=tsx test/test-phase2a.ts
import {
  captureEarningsT0,
  ensurePerplexityData,
  ensurePriceAtExpiry,
  runEncyclopediaMaintenance,
} from "../lib/encyclopedia";
import { createServerClient } from "../lib/supabase";

function section(title: string) {
  console.log(`\n==================== ${title} ====================`);
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

async function getRow(symbol: string, earningsDate: string) {
  const sb = createServerClient();
  const r = await sb
    .from("earnings_history")
    .select(
      "symbol,earnings_date,analyst_sentiment,news_summary,perplexity_pulled_at,price_at_expiry,recovered_by_expiry,two_x_em_strike,implied_move_pct,iv_before,price_before",
    )
    .eq("symbol", symbol)
    .eq("earnings_date", earningsDate)
    .limit(1);
  return (r.data ?? [])[0] as Record<string, unknown> | undefined;
}

async function test1_perplexityBackfill() {
  section("Test 1: Perplexity backfill (TSLA 2025-09-30 + 2025-12-31)");
  for (const date of ["2025-09-30", "2025-12-31"]) {
    // Reset first so we exercise the real path even if a prior run populated it.
    await createServerClient()
      .from("earnings_history")
      .update({ analyst_sentiment: null, news_summary: null, perplexity_pulled_at: null })
      .eq("symbol", "TSLA")
      .eq("earnings_date", date);
  }
  for (const date of ["2025-09-30", "2025-12-31"]) {
    const r = await ensurePerplexityData("TSLA", date);
    console.log(`  call #1 TSLA/${date} →`, JSON.stringify(r));
    const row = await getRow("TSLA", date);
    const payloadStr =
      typeof row?.news_summary === "string" ? (row.news_summary as string) : null;
    let parsedOk = false;
    let keys: string[] = [];
    if (payloadStr) {
      try {
        const p = JSON.parse(payloadStr) as Record<string, unknown>;
        parsedOk = true;
        keys = Object.keys(p);
      } catch {
        /* ignore */
      }
    }
    console.log(
      `    stored: sentiment=${row?.analyst_sentiment} parseable=${parsedOk} keys=[${keys.join(",")}] pulled_at=${row?.perplexity_pulled_at ? "✓" : "✗"}`,
    );
  }
  // Idempotent re-call
  const second = await ensurePerplexityData("TSLA", "2025-09-30");
  console.log(
    `  call #2 TSLA/2025-09-30 → ${JSON.stringify(second)}  ${"reason" in second && second.reason === "already_captured" ? "✓ idempotent" : "✗ should have skipped"}`,
  );
}

async function test2_priceAtExpiry() {
  section("Test 2: price-at-expiry backfill");
  // TSLA 2025-09-30 is a Phase-1 quarter-end row — spec says
  // recovered_by_expiry stays null because two_x_em_strike isn't set on
  // those. And our quarter-end guard will actually skip the expiry
  // backfill entirely. Pick a non-quarter-end date to exercise the path.
  // Insert a synthetic row with announcement date 2025-10-22 (TSLA's
  // actual Q3 2025 announcement) and an arbitrary two_x_em_strike.
  const sb = createServerClient();
  const synthDate = "2025-10-22";
  await sb.from("earnings_history").upsert(
    {
      symbol: "TSLA",
      earnings_date: synthDate,
      price_before: 440,
      two_x_em_strike: 400,
      data_source: "test",
      is_complete: false,
    },
    { onConflict: "symbol,earnings_date" },
  );
  await sb
    .from("earnings_history")
    .update({ price_at_expiry: null, recovered_by_expiry: null })
    .eq("symbol", "TSLA")
    .eq("earnings_date", synthDate);
  const r = await ensurePriceAtExpiry("TSLA", synthDate);
  console.log(`  ensurePriceAtExpiry TSLA/${synthDate} →`, JSON.stringify(r));
  const row = await getRow("TSLA", synthDate);
  console.log(
    `    stored: price_at_expiry=${row?.price_at_expiry} recovered_by_expiry=${row?.recovered_by_expiry}`,
  );

  // Quarter-end legacy row should be explicitly skipped.
  const quarterEnd = await ensurePriceAtExpiry("TSLA", "2025-09-30");
  console.log(
    `  ensurePriceAtExpiry TSLA/2025-09-30 (quarter-end) →`,
    JSON.stringify(quarterEnd),
    quarterEnd.captured === false && "reason" in quarterEnd && quarterEnd.reason === "quarter_end_legacy_row"
      ? "✓ skipped"
      : "✗ should have skipped",
  );
}

async function test3_t0Capture() {
  section("Test 3: T0 capture (accepts either real data or no_options_data skip)");
  // Insert a fake earnings_history row for tomorrow with a real symbol.
  const sb = createServerClient();
  const tomorrow = new Date(new Date().getTime() + 86400000).toISOString().slice(0, 10);
  await sb.from("earnings_history").upsert(
    {
      symbol: "TSLA",
      earnings_date: tomorrow,
      data_source: "test",
      is_complete: false,
    },
    { onConflict: "symbol,earnings_date" },
  );
  // Clear T0 fields so the gate fires properly.
  await sb
    .from("earnings_history")
    .update({
      implied_move_pct: null,
      iv_before: null,
      price_before: null,
      two_x_em_strike: null,
    })
    .eq("symbol", "TSLA")
    .eq("earnings_date", tomorrow);
  const r = await captureEarningsT0("TSLA", tomorrow);
  console.log(`  captureEarningsT0 TSLA/${tomorrow} →`, JSON.stringify(r));
  const row = await getRow("TSLA", tomorrow);
  console.log(
    `    stored: implied_move_pct=${row?.implied_move_pct} iv_before=${row?.iv_before} price_before=${row?.price_before} two_x_em_strike=${row?.two_x_em_strike}`,
  );
  if (r.captured) {
    // If real data, fields must all be non-null.
    const allSet =
      row?.implied_move_pct !== null &&
      row?.iv_before !== null &&
      row?.price_before !== null &&
      row?.two_x_em_strike !== null;
    console.log(`    all 4 T0 fields populated: ${allSet ? "✓" : "✗"}`);
  } else {
    // If skipped, fields must all still be null (no partial write).
    const allNull =
      row?.implied_move_pct === null &&
      row?.iv_before === null &&
      row?.price_before === null &&
      row?.two_x_em_strike === null;
    console.log(`    skipped cleanly (no partial write): ${allNull ? "✓" : "✗"}`);
  }

  // Cleanup synthetic row so the orchestrator test doesn't inherit it.
  await sb.from("earnings_history").delete().eq("symbol", "TSLA").eq("earnings_date", tomorrow);
}

async function test4_orchestrator() {
  section("Test 4: runEncyclopediaMaintenance()");
  const report = await runEncyclopediaMaintenance();
  console.log(
    `  symbolsProcessed=${report.symbolsProcessed}`,
    `t0=${report.t0Captured.length}`,
    `t1=${report.t1Captured.length}`,
    `expiry=${report.expiryBackfilled.length}`,
    `perplexity=${report.perplexityBackfilled.length}`,
    `errors=${report.errors.length}`,
  );
  if (report.perplexityBackfilled.length > 0) {
    console.log("  perplexityBackfilled:");
    for (const x of report.perplexityBackfilled) console.log(`    ${x.symbol} ${x.earnings_date}`);
  }
  if (report.errors.length > 0) {
    console.log("  errors (first 10):");
    for (const e of report.errors.slice(0, 10)) {
      console.log(`    ${e.stage} ${e.symbol}/${e.earnings_date ?? "—"} → ${e.reason}`);
    }
  }
  console.log(`  today=${todayIso()}`);
}

async function main() {
  await test1_perplexityBackfill();
  await test2_priceAtExpiry();
  await test3_t0Capture();
  await test4_orchestrator();
  console.log("\n=== done ===");
}

main().catch((e) => {
  console.error("test error:", e);
  process.exit(1);
});

// Phase 2C re-key tests: calendar fetch, quarter→announcement matching,
// dry-run + real re-ingest on TSLA, and merge behavior when Phase 2A
// has already inserted a T0 row for the same quarter.
//
// Run: node --env-file=.env.local --import=tsx test/test-phase2c.ts
import {
  ensurePerplexityData,
  fetchFinnhubEarningsCalendar,
  matchQuarterToAnnouncement,
  reingestHistoricalDates,
  type CalendarEntry,
} from "../lib/encyclopedia";
import { createServerClient } from "../lib/supabase";

let passed = 0;
let failed = 0;

function check(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  ✓ ${label}`);
    passed += 1;
  } else {
    console.log(`  ✗ ${label} ${detail ?? ""}`);
    failed += 1;
  }
}

function section(title: string) {
  console.log(`\n=============== ${title} ===============`);
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function isQuarterEnd(iso: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return false;
  const month = Number(m[2]);
  const day = Number(m[3]);
  return (
    (month === 3 && day === 31) ||
    (month === 6 && day === 30) ||
    (month === 9 && day === 30) ||
    (month === 12 && day === 31)
  );
}

// -------------------- Test 1: calendar fetch --------------------

async function test1_calendarFetch() {
  section("Test 1: fetchFinnhubEarningsCalendar('TSLA')");
  const entries = await fetchFinnhubEarningsCalendar("TSLA");
  console.log(`  returned ${entries.length} entries`);
  for (const e of entries.slice(0, 6)) {
    console.log(
      `    ${e.announcementDate}  Q${e.quarter ?? "?"} ${e.year ?? "?"}  hour=${e.hour ?? "?"}  eps=${e.epsActual ?? "?"}/${e.epsEstimate ?? "?"}`,
    );
  }
  // Yahoo caps earningsChart.quarterly at 4 entries. Anything less is
  // a red flag for the data source.
  check("returned 4+ entries", entries.length >= 4, `got ${entries.length}`);
  check("every entry has a date", entries.every((e) => /^\d{4}-\d{2}-\d{2}$/.test(e.announcementDate)));
  check(
    "no entry lands on a quarter-end (03-31/06-30/09-30/12-31)",
    !entries.some((e) => isQuarterEnd(e.announcementDate)),
  );
  check(
    "at least one entry has year+quarter populated",
    entries.some((e) => e.year !== null && e.quarter !== null),
  );
  return entries;
}

// -------------------- Test 2: matcher --------------------

function test2_matcher(tslaEntries: CalendarEntry[]) {
  section("Test 2: matchQuarterToAnnouncement");
  // TSLA Q3 2025 (quarter end 2025-09-30) — expected ~Oct 22, 2025
  const tslaQ3 = matchQuarterToAnnouncement("2025-09-30", tslaEntries);
  console.log(`  TSLA 2025-09-30 → ${tslaQ3?.announcementDate ?? "NO MATCH"} (Q${tslaQ3?.quarter}/${tslaQ3?.year})`);
  check("TSLA Q3 2025 match found", tslaQ3 !== null);
  if (tslaQ3) {
    const d = tslaQ3.announcementDate;
    // TSLA Q3 2025 earnings announcement was 2025-10-22. Calendar year/quarter
    // attribution can vary slightly (fiscal year offsets), so accept anything
    // between Oct 15 and Nov 10 of 2025 as "matches Q3".
    check(
      "  → date in expected window (2025-10-15 .. 2025-11-10)",
      d >= "2025-10-15" && d <= "2025-11-10",
      `got ${d}`,
    );
  }
}

async function test2b_nowMatcher() {
  section("Test 2b: matcher on NOW");
  const entries = await fetchFinnhubEarningsCalendar("NOW");
  console.log(`  NOW calendar entries: ${entries.length}`);
  for (const e of entries.slice(0, 6)) {
    console.log(`    ${e.announcementDate}  Q${e.quarter ?? "?"} ${e.year ?? "?"}  hour=${e.hour ?? "?"}`);
  }
  const nowQ3 = matchQuarterToAnnouncement("2025-09-30", entries);
  console.log(`  NOW 2025-09-30 → ${nowQ3?.announcementDate ?? "NO MATCH"}`);
  check("NOW Q3 2025 match found", nowQ3 !== null);
  if (nowQ3) {
    // NOW (ServiceNow) usually reports 3-4 weeks after quarter end.
    check(
      "  → within 60 days of 2025-09-30",
      nowQ3.announcementDate >= "2025-09-30" && nowQ3.announcementDate <= "2025-11-29",
      nowQ3.announcementDate,
    );
  }
}

// -------------------- Test 3: dry-run re-ingest --------------------

async function test3_dryRun() {
  section("Test 3: reingestHistoricalDates('TSLA', dryRun=true)");
  const report = await reingestHistoricalDates("TSLA", { dryRun: true });
  console.log(
    `  already_clean=${report.already_clean} reingested=${report.reingested} merged=${report.merged_with_existing} unmatched=${report.unmatched_rows.length}`,
  );
  console.log("  proposed changes:");
  for (const c of report.changes) {
    console.log(`    ${c.oldDate} → ${c.newDate}  action=${c.action}  hour=${c.hour ?? "?"}`);
  }

  if (report.already_clean) {
    console.log("  (no quarter-end rows found — test considered skipped)");
    return;
  }
  check("dry run did not write (reingested=0, merged_with_existing=0)", report.reingested === 0 && report.merged_with_existing === 0);
  check("has at least one proposed change", report.changes.length > 0);
  check(
    "every proposed newDate is not a quarter-end",
    report.changes.every((c) => !isQuarterEnd(c.newDate)),
  );
  check(
    "every change has a hour (bmo/amc/dmh) or null",
    report.changes.every(
      (c) => c.hour === null || ["bmo", "amc", "dmh"].includes(c.hour as string),
    ),
  );
}

// -------------------- Test 4: real re-ingest on TSLA --------------------

async function test4_realReingest() {
  section("Test 4: reingestHistoricalDates('TSLA') for real");
  const sb = createServerClient();
  // Snapshot Perplexity-populated rows before so we can verify we don't
  // lose narrative data in the re-key.
  const before = await sb
    .from("earnings_history")
    .select("symbol,earnings_date,perplexity_pulled_at,analyst_sentiment,news_summary")
    .eq("symbol", "TSLA");
  const beforeRows = (before.data ?? []) as Array<{
    earnings_date: string;
    perplexity_pulled_at: string | null;
    analyst_sentiment: string | null;
    news_summary: string | null;
  }>;
  const beforePerplexityCount = beforeRows.filter((r) => r.perplexity_pulled_at !== null).length;
  console.log(`  pre-reingest: ${beforeRows.length} TSLA rows, ${beforePerplexityCount} with Perplexity data`);

  const report = await reingestHistoricalDates("TSLA");
  console.log(
    `  reingested=${report.reingested} merged=${report.merged_with_existing} unmatched=${report.unmatched_rows.length}`,
  );
  if (report.unmatched_rows.length > 0) {
    console.log("  unmatched rows:");
    for (const u of report.unmatched_rows) console.log(`    ${u.oldDate}  reason=${u.reason}`);
  }

  const after = await sb
    .from("earnings_history")
    .select(
      "symbol,earnings_date,perplexity_pulled_at,analyst_sentiment,actual_move_pct,price_before,price_after,price_at_expiry",
    )
    .eq("symbol", "TSLA");
  const afterRows = (after.data ?? []) as Array<{
    earnings_date: string;
    perplexity_pulled_at: string | null;
    analyst_sentiment: string | null;
    actual_move_pct: number | null;
    price_before: number | null;
    price_after: number | null;
    price_at_expiry: number | null;
  }>;
  console.log(`  post-reingest: ${afterRows.length} TSLA rows`);
  for (const r of afterRows.sort((a, b) => b.earnings_date.localeCompare(a.earnings_date)).slice(0, 8)) {
    const pre = r.price_before !== null ? r.price_before.toFixed(2) : "—";
    const post = r.price_after !== null ? r.price_after.toFixed(2) : "—";
    const expiry = r.price_at_expiry !== null ? r.price_at_expiry.toFixed(2) : "—";
    const move =
      r.actual_move_pct !== null ? (r.actual_move_pct * 100).toFixed(2) + "%" : "—";
    console.log(
      `    ${r.earnings_date}  pre=${pre} post=${post} exp=${expiry} move=${move} perplexity=${r.perplexity_pulled_at ? "✓" : "·"}`,
    );
  }

  check(
    "no remaining quarter-end rows",
    !afterRows.some((r) => isQuarterEnd(r.earnings_date)),
  );
  const afterPerplexityCount = afterRows.filter((r) => r.perplexity_pulled_at !== null).length;
  // A merge can reduce absolute row count (quarter-end row folds into
  // a T0 row at the announcement date), so we check that no row lost
  // its narrative — every row that exists after should still carry
  // Perplexity data if every row carried it before.
  const allBeforeHadPerplexity =
    beforeRows.length > 0 && beforePerplexityCount === beforeRows.length;
  if (allBeforeHadPerplexity) {
    check(
      `no row lost Perplexity data (${afterPerplexityCount} of ${afterRows.length} retain it)`,
      afterPerplexityCount === afterRows.length,
    );
  } else {
    check(
      `Perplexity row count non-decreasing relative to merge (${afterPerplexityCount} vs ${beforePerplexityCount})`,
      afterPerplexityCount >= beforePerplexityCount - (beforeRows.length - afterRows.length),
    );
  }
  const moveRatios = afterRows
    .map((r) => r.actual_move_pct)
    .filter((v): v is number => v !== null && Number.isFinite(v));
  if (moveRatios.length > 0) {
    const maxAbs = Math.max(...moveRatios.map((v) => Math.abs(v)));
    console.log(`  max |actual_move_pct| = ${(maxAbs * 100).toFixed(2)}%`);
    check(
      "actual_move_pct values look sane (<30% overnight move)",
      maxAbs < 0.3,
    );
  }
  const expiryPopulated = afterRows.filter((r) => r.price_at_expiry !== null).length;
  console.log(`  price_at_expiry populated on ${expiryPopulated}/${afterRows.length} rows`);
  check("some price_at_expiry rows populated", expiryPopulated > 0);

  // Verify encyclopedia stats recomputed without error.
  const enc = await sb
    .from("stock_encyclopedia")
    .select("total_earnings_records,last_historical_pull_date,updated_at")
    .eq("symbol", "TSLA")
    .limit(1);
  const encRow = (enc.data ?? [])[0] as
    | {
        total_earnings_records: number;
        last_historical_pull_date: string | null;
        updated_at: string;
      }
    | undefined;
  console.log(`  stock_encyclopedia: total=${encRow?.total_earnings_records} updated_at=${encRow?.updated_at}`);
  check("stock_encyclopedia stats updated today", (encRow?.updated_at ?? "").startsWith(todayIso()));
}

// -------------------- Test 5: merge behavior (NOW) --------------------

async function test5_nowMerge() {
  section("Test 5: NOW merge behavior");
  // Before re-ingest: check for quarter-end rows AND non-quarter-end rows
  const sb = createServerClient();
  const before = await sb
    .from("earnings_history")
    .select("earnings_date,implied_move_pct,perplexity_pulled_at,analyst_sentiment")
    .eq("symbol", "NOW");
  const rows = (before.data ?? []) as Array<{
    earnings_date: string;
    implied_move_pct: number | null;
    perplexity_pulled_at: string | null;
    analyst_sentiment: string | null;
  }>;
  const qEnd = rows.filter((r) => isQuarterEnd(r.earnings_date));
  const announcement = rows.filter((r) => !isQuarterEnd(r.earnings_date));
  console.log(
    `  pre-reingest: ${rows.length} NOW rows (${qEnd.length} quarter-end, ${announcement.length} announcement-date)`,
  );
  if (qEnd.length === 0) {
    console.log("  (no NOW quarter-end rows — nothing to merge)");
    return;
  }

  const report = await reingestHistoricalDates("NOW");
  console.log(
    `  reingested=${report.reingested} merged=${report.merged_with_existing} unmatched=${report.unmatched_rows.length}`,
  );

  const after = await sb
    .from("earnings_history")
    .select("earnings_date")
    .eq("symbol", "NOW");
  const afterDates = ((after.data ?? []) as Array<{ earnings_date: string }>).map(
    (r) => r.earnings_date,
  );
  const dupes = afterDates.filter((d, i) => afterDates.indexOf(d) !== i);
  check("no duplicate earnings_date values post-merge", dupes.length === 0);
  check(
    "no remaining quarter-end rows",
    !afterDates.some(isQuarterEnd),
  );
}

// Regression test for the Perplexity staleness bug. When a row's
// actual_move_pct changes via reingest, the narrative attached to it
// is stale — ensurePerplexityData must re-pull. We simulate the
// reingest mutation by manually clearing the Perplexity fields (which
// is what the fixed reingestHistoricalDates now does), then verify
// that (a) the fields ARE cleared, and (b) the next ensurePerplexityData
// produces different content against the new move value.
async function test6_perplexityStaleness() {
  section("Test 6: Perplexity staleness + clear-on-mutation");
  const sb = createServerClient();
  const sym = "__FXTST_PERPLEXITY_STALE__";
  const date = "2025-06-15"; // well in the past so not a live event
  // Fresh row with a tiny move — Perplexity should produce a "minimal
  // reaction" narrative.
  await sb
    .from("earnings_history")
    .upsert(
      {
        symbol: sym,
        earnings_date: date,
        eps_estimate: 1.0,
        eps_actual: 1.0,
        eps_surprise_pct: 0,
        actual_move_pct: -0.005, // -0.5%
        data_source: "test-staleness",
        is_complete: true,
      },
      { onConflict: "symbol,earnings_date" },
    );
  try {
    const r1 = await ensurePerplexityData(sym, date);
    console.log(`  first pull: captured=${r1.captured}`);
    const before = await sb
      .from("earnings_history")
      .select("analyst_sentiment,news_summary,perplexity_pulled_at")
      .eq("symbol", sym)
      .eq("earnings_date", date)
      .limit(1);
    const beforeRow = (before.data ?? [])[0] as {
      analyst_sentiment: string | null;
      news_summary: string | null;
      perplexity_pulled_at: string | null;
    };
    check("(1a) pulled_at set after first call", beforeRow.perplexity_pulled_at !== null);
    check("(1b) news_summary populated", (beforeRow.news_summary ?? "").length > 10);
    const oldSummary = beforeRow.news_summary;

    // Simulate reingest mutation: actual_move_pct flips to a big drop,
    // Perplexity fields cleared (what the fixed reingestHistoricalDates
    // now writes on update/merge).
    await sb
      .from("earnings_history")
      .update({
        actual_move_pct: -0.15,
        analyst_sentiment: null,
        news_summary: null,
        perplexity_pulled_at: null,
      })
      .eq("symbol", sym)
      .eq("earnings_date", date);

    const mid = await sb
      .from("earnings_history")
      .select("perplexity_pulled_at,news_summary")
      .eq("symbol", sym)
      .eq("earnings_date", date)
      .limit(1);
    const midRow = (mid.data ?? [])[0] as {
      perplexity_pulled_at: string | null;
      news_summary: string | null;
    };
    check(
      "(2) perplexity_pulled_at cleared by simulated reingest",
      midRow.perplexity_pulled_at === null,
    );
    check("(2) news_summary cleared", midRow.news_summary === null);

    // Re-pull with new move.
    const r2 = await ensurePerplexityData(sym, date);
    console.log(`  re-pull: captured=${r2.captured}`);
    const after = await sb
      .from("earnings_history")
      .select("analyst_sentiment,news_summary,perplexity_pulled_at")
      .eq("symbol", sym)
      .eq("earnings_date", date)
      .limit(1);
    const afterRow = (after.data ?? [])[0] as {
      analyst_sentiment: string | null;
      news_summary: string | null;
      perplexity_pulled_at: string | null;
    };
    check("(3a) re-pulled successfully", afterRow.perplexity_pulled_at !== null);
    check(
      "(3b) new news_summary differs from old",
      afterRow.news_summary !== null && afterRow.news_summary !== oldSummary,
    );
    if (oldSummary && afterRow.news_summary) {
      console.log(`    old (tiny move): ${oldSummary.slice(0, 140)}...`);
      console.log(`    new (big drop): ${afterRow.news_summary.slice(0, 140)}...`);
    }
  } finally {
    await sb.from("earnings_history").delete().eq("symbol", sym);
  }
}

async function main() {
  const tslaEntries = await test1_calendarFetch();
  test2_matcher(tslaEntries);
  await test2b_nowMatcher();
  await test3_dryRun();
  await test4_realReingest();
  await test5_nowMerge();
  await test6_perplexityStaleness();
  console.log(`\n=== Summary: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error("test error:", e);
  process.exit(1);
});

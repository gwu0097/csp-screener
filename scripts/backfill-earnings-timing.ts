// Backfills earnings_history.timing for rows where it's null, by
// re-deriving from Yahoo's earningsChart.quarterly reportedDate — the
// SAME heuristic fetchFinnhubEarningsCalendar already computes and
// lib/encyclopedia.ts's insert paths already use to pick
// price_before/price_after, just never persisted to the timing column
// until now (see the three insert-path patches in this same change).
//
// Scope: date_confidence='vendor_derived' rows only (the direct
// successor of the old 'confirmed' value). 'inferred' rows (successor
// of the old 'low') carry an unverified quarter-end date, not a real
// announcement date — deriving timing against a date we don't trust
// would be building on sand. 'unknown'-tier rows carry no date
// classification at all and are excluded for the same reason.
//
// 2026-08-19: the skip check used to be `!== "low"`, an exclude-list
// against the pre-migration 2-value vocabulary. Once date_confidence
// moved to 5 tiers, "low" stopped existing anywhere in the table and
// the check silently matched everything — this script's "eligible" set
// quietly grew to include the 34 inferred rows this comment always
// said to exclude. Now an explicit include-list against the one tier
// this script actually trusts, so a future tier addition can't repeat
// the same silent-drift bug.
//
// Writes route through lib/earnings-history-writer.ts at
// data_source=manual_repair_script (this is a hand-invoked repair
// script, not a live automated path) / date_confidence=vendor_derived
// (asserting the same tier this script's own eligibility scope
// requires of its input rows — a repeat run reasserts, never
// downgrades, since it only ever operates on vendor_derived rows to
// begin with).
//
// For every row where a calendar match exists, this ALSO reconciles the
// heuristic against the row's own stored price_before/price_after by
// recomputing both the BMO-style and AMC-style price pair (via the
// exact same fetchYahooPriceActionTimed function the write path uses)
// and checking which one the stored values actually match. Disagreement
// means the row was originally written under a different timing
// assumption than the heuristic now produces — that's reported, not
// silently overwritten.
//
// Usage: npx tsx scripts/backfill-earnings-timing.ts [--dry] [--symbol SYM]
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const ELIGIBLE_TIER = "vendor_derived";

function loadEnvLocal(): void {
  const content = readFileSync(resolve(process.cwd(), ".env.local"), "utf8");
  for (const line of content.split("\n")) {
    const eq = line.indexOf("=");
    if (eq === -1 || line.trim().startsWith("#")) continue;
    const k = line.slice(0, eq).trim();
    if (!process.env[k]) process.env[k] = line.slice(eq + 1).trim();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Tolerant compare — Yahoo bars can carry tiny rounding/revision drift
// between the original write and this re-fetch; anything beyond that is
// a real disagreement, not noise.
function pricesMatch(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return false;
  const diff = Math.abs(a - b);
  if (diff < 0.01) return true;
  const denom = Math.max(Math.abs(a), Math.abs(b), 1e-9);
  return diff / denom < 0.0005;
}

type Row = {
  id: string;
  symbol: string;
  earnings_date: string;
  date_confidence: string | null;
  price_before: number | null;
  price_after: number | null;
};

async function main() {
  loadEnvLocal();
  const { createServerClient } = await import("../lib/supabase");
  const { fetchFinnhubEarningsCalendar, fetchYahooPriceActionTimed } = await import(
    "../lib/encyclopedia"
  );
  const { writeEarningsHistory } = await import("../lib/earnings-history-writer");

  const dryRun = process.argv.includes("--dry");
  const symArgIdx = process.argv.indexOf("--symbol");
  const onlySymbol = symArgIdx !== -1 ? process.argv[symArgIdx + 1]?.toUpperCase() : null;

  const sb = createServerClient();

  // Cursor-paginate past the custom Supabase wrapper's ~1000-row cap.
  const rows: Row[] = [];
  let lastId = "00000000-0000-0000-0000-000000000000";
  for (;;) {
    let q = sb
      .from("earnings_history")
      .select("id,symbol,earnings_date,date_confidence,price_before,price_after")
      .is("timing", null)
      .order("id", { ascending: true })
      .gt("id", lastId)
      .limit(1000);
    if (onlySymbol) q = q.eq("symbol", onlySymbol);
    const res = await q;
    const batch = (res.data ?? []) as Row[];
    if (batch.length === 0) break;
    rows.push(...batch);
    lastId = batch[batch.length - 1].id;
    if (batch.length < 1000) break;
  }
  console.log(`[${new Date().toISOString()}] candidates: ${rows.length} rows with timing IS NULL${dryRun ? " [dry run]" : ""}`);

  const lowConfidence = rows.filter((r) => r.date_confidence !== ELIGIBLE_TIER);
  const confirmed = rows.filter((r) => r.date_confidence === ELIGIBLE_TIER);
  console.log(
    `  confirmed=${confirmed.length} (eligible, tier=${ELIGIBLE_TIER}) low_confidence=${lowConfidence.length} (skipped — untrusted/no date classification, left null)`,
  );

  const bySymbol = new Map<string, Row[]>();
  for (const r of confirmed) {
    if (!bySymbol.has(r.symbol)) bySymbol.set(r.symbol, []);
    bySymbol.get(r.symbol)!.push(r);
  }
  console.log(`distinct symbols: ${bySymbol.size}`);

  let writtenConsistent = 0;
  let writtenNoReconciliation = 0;
  let writtenAmbiguousMatch = 0;
  let noCalendarCoverageRow = 0; // symbol has a calendar, but not for this row's date
  const calendarEmptySymbols: string[] = []; // calendar fetch returned nothing at all for the symbol
  const inconsistent: Array<{ symbol: string; earnings_date: string; heuristic: string; impliedFromPrices: string }> = [];
  const unverifiable: Array<{ symbol: string; earnings_date: string }> = [];
  const writeFailures: Array<{ symbol: string; earnings_date: string; error: string }> = [];

  let symIdx = 0;
  for (const [symbol, symRows] of Array.from(bySymbol.entries())) {
    symIdx += 1;
    let calendar: Awaited<ReturnType<typeof fetchFinnhubEarningsCalendar>> = [];
    try {
      calendar = await fetchFinnhubEarningsCalendar(symbol);
    } catch (e) {
      console.warn(`[backfill-timing] calendar fetch threw for ${symbol}: ${e instanceof Error ? e.message : e}`);
    }
    if (calendar.length === 0) calendarEmptySymbols.push(symbol);
    const byDate = new Map(calendar.map((c) => [c.announcementDate, c]));

    for (const row of symRows) {
      const entry = byDate.get(row.earnings_date);
      if (!entry) {
        noCalendarCoverageRow += 1;
        continue;
      }
      const heuristicHour = entry.hour as "bmo" | "amc";

      if (row.price_before === null || row.price_after === null) {
        // Nothing stored to conflict with — safe to write directly,
        // nothing to reconcile against.
        if (!dryRun) {
          const up = await writeEarningsHistory({
            id: row.id,
            attemptedBy: "manual_repair_script",
            dataSource: "manual_repair_script",
            tier: ELIGIBLE_TIER,
            timing: heuristicHour,
            fields: { timing_source: "yahoo_timestamp_heuristic" },
          });
          if (up.outcome === "error") {
            writeFailures.push({ symbol, earnings_date: row.earnings_date, error: up.message });
            continue;
          }
          if (up.outcome === "rejected") {
            writeFailures.push({
              symbol,
              earnings_date: row.earnings_date,
              error: `precedence_rejected: stored tier ${up.rejection.storedTier}`,
            });
            continue;
          }
        }
        writtenNoReconciliation += 1;
        continue;
      }

      const [bmoCalc, amcCalc] = await Promise.all([
        fetchYahooPriceActionTimed(symbol, row.earnings_date, "bmo"),
        fetchYahooPriceActionTimed(symbol, row.earnings_date, "amc"),
      ]);
      await sleep(120);
      const matchesBmo =
        pricesMatch(row.price_before, bmoCalc.price_before) && pricesMatch(row.price_after, bmoCalc.price_after);
      const matchesAmc =
        pricesMatch(row.price_before, amcCalc.price_before) && pricesMatch(row.price_after, amcCalc.price_after);

      let impliedTiming: "bmo" | "amc" | "ambiguous" | "no_match";
      if (matchesBmo && matchesAmc) impliedTiming = "ambiguous";
      else if (matchesBmo) impliedTiming = "bmo";
      else if (matchesAmc) impliedTiming = "amc";
      else impliedTiming = "no_match";

      if (impliedTiming === "no_match") {
        unverifiable.push({ symbol, earnings_date: row.earnings_date });
        continue;
      }
      if (impliedTiming !== "ambiguous" && impliedTiming !== heuristicHour) {
        inconsistent.push({
          symbol,
          earnings_date: row.earnings_date,
          heuristic: heuristicHour,
          impliedFromPrices: impliedTiming,
        });
        continue;
      }

      if (!dryRun) {
        const up = await writeEarningsHistory({
          id: row.id,
          attemptedBy: "manual_repair_script",
          dataSource: "manual_repair_script",
          tier: ELIGIBLE_TIER,
          timing: heuristicHour,
          fields: { timing_source: "yahoo_timestamp_heuristic" },
        });
        if (up.outcome === "error") {
          writeFailures.push({ symbol, earnings_date: row.earnings_date, error: up.message });
          continue;
        }
        if (up.outcome === "rejected") {
          writeFailures.push({
            symbol,
            earnings_date: row.earnings_date,
            error: `precedence_rejected: stored tier ${up.rejection.storedTier}`,
          });
          continue;
        }
      }
      if (impliedTiming === "ambiguous") writtenAmbiguousMatch += 1;
      else writtenConsistent += 1;
    }

    await sleep(150);
    if (symIdx % 50 === 0) {
      console.log(`  ... ${symIdx}/${bySymbol.size} symbols processed`);
    }
  }

  const written = writtenConsistent + writtenNoReconciliation + writtenAmbiguousMatch;
  const report = {
    dryRun,
    candidateRows: rows.length,
    lowConfidenceSkipped: lowConfidence.length,
    confirmedEligible: confirmed.length,
    distinctSymbols: bySymbol.size,
    written,
    writtenConsistent,
    writtenNoReconciliation,
    writtenAmbiguousMatch,
    noCalendarCoverageRow,
    calendarEmptySymbolsCount: calendarEmptySymbols.length,
    calendarEmptySymbols,
    inconsistentCount: inconsistent.length,
    inconsistent,
    unverifiableCount: unverifiable.length,
    unverifiable,
    writeFailuresCount: writeFailures.length,
    writeFailures,
  };
  console.log("\n==== backfill-earnings-timing report ====");
  console.log(JSON.stringify(report, null, 2));

  const outPath = resolve(process.cwd(), "backfill-earnings-timing-report.json");
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`\nfull report written to ${outPath}`);
}

main().catch((e) => {
  console.error("[backfill-earnings-timing] fatal:", e);
  process.exit(1);
});

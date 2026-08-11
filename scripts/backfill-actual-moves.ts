// Backfill actual_move_pct for earnings_history rows that have an
// earnings_date but no actual move. The dates are already stored, so
// fetchYahooPriceAction (same helper the fetch-em-history seed path
// uses) computes the reaction from Yahoo daily bars and we update the
// row in place. Idempotent — only touches rows with actual_move_pct
// IS NULL. Rows within the last 3 days are deferred (the post-earnings
// close may not be final yet); the T1 capture or a rerun picks them up.
//
// Runs on manual rows too (implied_move_source='manual'). The
// 2026-08-05 CDNS/GLW/DUOL corruption (fetchYahooPriceAction's
// report-window gap scan picking a larger unrelated move weeks out
// when the true reaction was small) was fixed at the source in commit
// a0dfb13 for quarter-end dates, then again at 2026-08-12 for confirmed
// dates: the near-window magnitude scan was ALSO still a guess (picked
// unrelated volatility over a real but smaller reaction, and couldn't
// even reach a Monday BMO report's true prior close, three calendar
// days back). A confirmed date now picks its pair DETERMINISTICALLY
// from the row's own `timing` column (BMO/AMC), anchored by trading-day
// position, and returns null rather than guessing when timing is
// unknown. That protects every caller, including this one, so excluding
// manual rows here was redundant with the .is("actual_move_pct", null)
// filter above — the only guard actually needed against overwriting a
// populated value (audit: 2026-08-11). Rows whose earnings_date is a
// literal quarter-end (isQuarterEndDate) still take the wide
// report-window path, untouched by the 2026-08-12 fix; flagged below
// for visibility, not excluded.
//
// Writes the same field set as every other price-based write path
// (updateEncyclopedia in lib/encyclopedia.ts): price_before/price_after/
// price_at_expiry/actual_move_pct AND move_ratio/two_x_em_strike/
// breached_two_x_em/recovered_by_expiry via calculateBreachAnalysis —
// never just the first four. A row missing the breach fields looks
// complete in the UI (actual_move_pct populated) while silently sitting
// out of avg_move_ratio and grading, which read move_ratio, not
// actual_move_pct (audit: 2026-08-11). Also calls recalculateStats per
// touched symbol at the end, matching updateEncyclopedia's own last step.
//
// Defaults to a dry run — reports what it WOULD write without writing.
// --date scopes to one earnings_date; --symbol alone scopes by ticker
// only and can still touch multiple rows for that symbol. --skip excludes
// specific rows from an otherwise-broad run — e.g. rows flagged
// placeholder-date-suspect (fabricated announcement date; see the
// 2026-08-11 audit) that must not get an actual move computed against
// the wrong week's bars until the date itself is corrected.
// Usage: npx tsx scripts/backfill-actual-moves.ts [--write] [--symbol=SMCI] [--date=2026-05-05] [--skip=path/to/skiplist.txt]
// skiplist format: one "SYMBOL@YYYY-MM-DD" per line, blank lines and
// lines starting with # ignored.
import { readFileSync } from "node:fs";
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function addDaysIso(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function main() {
  loadEnvLocal();
  const { createServerClient } = await import("../lib/supabase");
  const { fetchYahooPriceAction, isQuarterEndDate, calculateBreachAnalysis, recalculateStats } = await import("../lib/encyclopedia");
  const sb = createServerClient();

  const WRITE = process.argv.includes("--write");
  const symbolArg = process.argv.find((a) => a.startsWith("--symbol="));
  const symbolFilter = symbolArg ? symbolArg.slice("--symbol=".length).toUpperCase() : null;
  const dateArg = process.argv.find((a) => a.startsWith("--date="));
  const dateFilter = dateArg ? dateArg.slice("--date=".length) : null;
  if (dateFilter && !/^\d{4}-\d{2}-\d{2}$/.test(dateFilter)) {
    console.error(`--date must be YYYY-MM-DD, got "${dateFilter}"`);
    process.exit(1);
  }
  const skipArg = process.argv.find((a) => a.startsWith("--skip="));
  const skipSet = new Set<string>();
  if (skipArg) {
    const skipPath = skipArg.slice("--skip=".length);
    const lines = readFileSync(resolve(skipPath), "utf8").split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      if (!/^[A-Z.]+@\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
        console.error(`--skip file has a malformed line (expected SYMBOL@YYYY-MM-DD): "${trimmed}"`);
        process.exit(1);
      }
      skipSet.add(trimmed);
    }
    console.log(`loaded ${skipSet.size} row(s) to skip from ${skipPath}`);
  }

  const todayIso = new Date().toISOString().slice(0, 10);
  const cutoff = addDaysIso(todayIso, -3);

  let query = sb
    .from("earnings_history")
    .select("symbol,earnings_date,implied_move_pct,implied_move_source,timing")
    .is("actual_move_pct", null)
    .lte("earnings_date", todayIso)
    .order("earnings_date", { ascending: true });
  if (symbolFilter) query = query.eq("symbol", symbolFilter);
  if (dateFilter) query = query.eq("earnings_date", dateFilter);
  const res = await query;
  if (res.error) {
    console.error("candidate read failed:", res.error.message);
    process.exit(1);
  }
  const all = (res.data ?? []) as Array<{
    symbol: string;
    earnings_date: string;
    implied_move_pct: number | null;
    implied_move_source: string | null;
    timing: "bmo" | "amc" | "dmh" | null;
  }>;
  const deferred = all.filter((r) => r.earnings_date > cutoff);
  const beforeSkip = all.filter((r) => r.earnings_date <= cutoff);
  const skipped = skipSet.size > 0 ? beforeSkip.filter((r) => skipSet.has(`${r.symbol}@${r.earnings_date}`)) : [];
  const rows = beforeSkip.filter((r) => !skipSet.has(`${r.symbol}@${r.earnings_date}`));
  const manualRows = rows.filter((r) => r.implied_move_source === "manual");
  const quarterEndRows = rows.filter((r) => isQuarterEndDate(r.earnings_date));
  console.log(
    `${WRITE ? "WRITE" : "DRY RUN"} candidates=${all.length} runnable=${rows.length} deferred(too recent, > ${cutoff})=${deferred.length} skipped=${skipped.length}` +
      (symbolFilter ? ` symbol=${symbolFilter}` : "") +
      (dateFilter ? ` date=${dateFilter}` : ""),
  );
  if (skipSet.size > 0 && skipped.length !== skipSet.size) {
    console.log(
      `⚠ skip list had ${skipSet.size} entries but only ${skipped.length} matched a runnable candidate — ` +
        `the rest are either already filled, deferred, or don't exist as written (check for typos).`,
    );
  }
  if (manualRows.length > 0) {
    console.log(
      `manual rows now eligible (${manualRows.length}): ` +
        manualRows.map((r) => `${r.symbol}@${r.earnings_date}`).join(", "),
    );
  }
  if (quarterEndRows.length > 0) {
    console.log(
      `⚠ quarter-end earnings_date, still takes the wide report-window path (${quarterEndRows.length}): ` +
        quarterEndRows.map((r) => `${r.symbol}@${r.earnings_date}`).join(", "),
    );
  }

  let filled = 0;
  let noData = 0;
  let updateErrors = 0;
  const failures: string[] = [];
  const touchedSymbols = new Set<string>();

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const sym = row.symbol.toUpperCase();
    try {
      const price = await fetchYahooPriceAction(sym, row.earnings_date, row.timing);
      if (price.actual_move_pct === null) {
        noData += 1;
        const reason =
          !isQuarterEndDate(row.earnings_date) && row.timing !== "bmo" && row.timing !== "amc"
            ? `timing unknown (${row.timing ?? "null"}) — refusing to guess a pair`
            : "no usable Yahoo bars";
        failures.push(`${sym}@${row.earnings_date}: ${reason}`);
      } else {
        const breach = calculateBreachAnalysis({
          price_before: price.price_before,
          price_after: price.price_after,
          price_at_expiry: price.price_at_expiry,
          implied_move_pct: row.implied_move_pct,
          actual_move_pct: price.actual_move_pct,
        });
        console.log(
          `  ${sym}@${row.earnings_date} (${row.implied_move_source ?? "unknown"}, timing=${row.timing ?? "null"}${isQuarterEndDate(row.earnings_date) ? ", quarter-end" : ""}): ` +
            `actual=${(price.actual_move_pct * 100).toFixed(2)}% before=${price.price_before} after=${price.price_after} ` +
            `ratio=${breach.move_ratio !== null ? breach.move_ratio.toFixed(3) : "null"}`,
        );
        if (WRITE) {
          const upd = await sb
            .from("earnings_history")
            .update({
              price_before: price.price_before,
              price_after: price.price_after,
              price_at_expiry: price.price_at_expiry,
              actual_move_pct: price.actual_move_pct,
              move_ratio: breach.move_ratio,
              two_x_em_strike: breach.two_x_em_strike,
              breached_two_x_em: breach.breached_two_x_em,
              recovered_by_expiry: breach.recovered_by_expiry,
              is_complete:
                price.price_before !== null && price.price_after !== null,
            })
            .eq("symbol", row.symbol)
            .eq("earnings_date", row.earnings_date);
          if (upd.error) {
            updateErrors += 1;
            failures.push(`${sym}@${row.earnings_date}: db ${upd.error.message}`);
          } else {
            filled += 1;
            touchedSymbols.add(sym);
          }
        } else {
          filled += 1;
        }
      }
    } catch (e) {
      noData += 1;
      failures.push(
        `${sym}@${row.earnings_date}: ${e instanceof Error ? e.message : e}`,
      );
    }
    if ((i + 1) % 25 === 0) {
      console.log(
        `progress ${i + 1}/${rows.length} — filled=${filled} noData=${noData} dbErr=${updateErrors}`,
      );
    }
    await sleep(350);
  }

  if (WRITE && touchedSymbols.size > 0) {
    console.log(`\nrecalculating stock_encyclopedia stats for ${touchedSymbols.size} touched symbol(s)...`);
    for (const sym of Array.from(touchedSymbols)) {
      await recalculateStats(sym);
    }
  }

  console.log(`\n==== actual-move backfill done (${WRITE ? "WRITE" : "DRY RUN — pass --write to apply"}) ====`);
  console.log(
    `runnable=${rows.length} filled=${filled} noData=${noData} dbErrors=${updateErrors} deferred=${deferred.length}`,
  );
  if (failures.length > 0) {
    console.log("\nfailures:");
    for (const f of failures) console.log("  " + f);
  }
  if (deferred.length > 0) {
    console.log("\ndeferred (earnings too recent for a settled T+1 close):");
    for (const d of deferred) console.log(`  ${d.symbol}@${d.earnings_date}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

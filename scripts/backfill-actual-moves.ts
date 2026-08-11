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
// a0dfb13: a confirmed real announcement date now uses the near-window
// only and returns null on a data gap instead of guessing from a wider
// window. That protects every caller, including this one, so excluding
// manual rows here was redundant with the .is("actual_move_pct", null)
// filter above — the only guard actually needed against overwriting a
// populated value (audit: 2026-08-11). Rows whose earnings_date is a
// literal quarter-end (isQuarterEndDate) still take the wide
// report-window path; flagged below for visibility, not excluded.
//
// Defaults to a dry run — reports what it WOULD write without writing.
// Usage: npx tsx scripts/backfill-actual-moves.ts [--write] [--symbol=SMCI]
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
  const { fetchYahooPriceAction, isQuarterEndDate } = await import("../lib/encyclopedia");
  const sb = createServerClient();

  const WRITE = process.argv.includes("--write");
  const symbolArg = process.argv.find((a) => a.startsWith("--symbol="));
  const symbolFilter = symbolArg ? symbolArg.slice("--symbol=".length).toUpperCase() : null;

  const todayIso = new Date().toISOString().slice(0, 10);
  const cutoff = addDaysIso(todayIso, -3);

  let query = sb
    .from("earnings_history")
    .select("symbol,earnings_date,implied_move_pct,implied_move_source")
    .is("actual_move_pct", null)
    .lte("earnings_date", todayIso)
    .order("earnings_date", { ascending: true });
  if (symbolFilter) query = query.eq("symbol", symbolFilter);
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
  }>;
  const deferred = all.filter((r) => r.earnings_date > cutoff);
  const rows = all.filter((r) => r.earnings_date <= cutoff);
  const manualRows = rows.filter((r) => r.implied_move_source === "manual");
  const quarterEndRows = rows.filter((r) => isQuarterEndDate(r.earnings_date));
  console.log(
    `${WRITE ? "WRITE" : "DRY RUN"} candidates=${all.length} runnable=${rows.length} deferred(too recent, > ${cutoff})=${deferred.length}` +
      (symbolFilter ? ` symbol=${symbolFilter}` : ""),
  );
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

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const sym = row.symbol.toUpperCase();
    try {
      const price = await fetchYahooPriceAction(sym, row.earnings_date);
      if (price.actual_move_pct === null) {
        noData += 1;
        failures.push(`${sym}@${row.earnings_date}: no usable Yahoo bars`);
      } else {
        console.log(
          `  ${sym}@${row.earnings_date} (${row.implied_move_source ?? "unknown"}${isQuarterEndDate(row.earnings_date) ? ", quarter-end" : ""}): ` +
            `actual=${(price.actual_move_pct * 100).toFixed(2)}% before=${price.price_before} after=${price.price_after}`,
        );
        if (WRITE) {
          const upd = await sb
            .from("earnings_history")
            .update({
              price_before: price.price_before,
              price_after: price.price_after,
              price_at_expiry: price.price_at_expiry,
              actual_move_pct: price.actual_move_pct,
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

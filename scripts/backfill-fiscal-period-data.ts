// Backfills fiscal_quarter / fiscal_year / period_end on existing
// earnings_history rows, and fiscal_year_end_month on existing
// stock_encyclopedia rows — both columns added by
// migrations/2026-08-06-add-fiscal-period-fields.sql after these rows
// were already written, so ingest-time population (lib/encyclopedia.ts)
// never touched them.
//
// Re-derives from the SAME two sources the live ingest paths use
// (Finnhub /stock/earnings, the Yahoo-backed calendar), matched to each
// row's EXISTING earnings_date — never guessed or inferred from the
// report date. Where both sources return fiscal data for the same row
// and DISAGREE, neither is written — the conflict is reported instead
// of silently picking one.
//
//   npx tsx scripts/backfill-fiscal-period-data.ts            → dry run
//   npx tsx scripts/backfill-fiscal-period-data.ts --apply    → persists
//   npx tsx scripts/backfill-fiscal-period-data.ts --symbol ELF [--apply]
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

type HistoryRow = {
  id: string;
  symbol: string;
  earnings_date: string;
  fiscal_quarter: number | null;
  fiscal_year: number | null;
  period_end: string | null;
};

type FiscalTriple = { quarter: number; year: number; period: string | null };

type Conflict = {
  symbol: string;
  earnings_date: string;
  finnhub: FiscalTriple;
  yahoo: FiscalTriple;
};

async function main() {
  loadEnvLocal();
  const apply = process.argv.includes("--apply");
  const symArgIdx = process.argv.indexOf("--symbol");
  const onlySymbol = symArgIdx !== -1 ? process.argv[symArgIdx + 1]?.toUpperCase() : null;

  const { createServerClient } = await import("../lib/supabase");
  const { fetchFinnhubEarnings, fetchFinnhubEarningsCalendar } = await import(
    "../lib/encyclopedia"
  );
  const { getFiscalYearEndMonth } = await import("../lib/sec-edgar");

  const sb = createServerClient();

  // ---------- earnings_history: fiscal_quarter / fiscal_year / period_end ----------

  // Cursor-paginate past the custom Supabase wrapper's ~1000-row cap.
  const rows: HistoryRow[] = [];
  let lastId = "00000000-0000-0000-0000-000000000000";
  for (;;) {
    let q = sb
      .from("earnings_history")
      .select("id,symbol,earnings_date,fiscal_quarter,fiscal_year,period_end")
      .order("id", { ascending: true })
      .gt("id", lastId)
      .limit(1000);
    if (onlySymbol) q = q.eq("symbol", onlySymbol);
    const res = await q;
    const batch = (res.data ?? []) as HistoryRow[];
    if (batch.length === 0) break;
    rows.push(...batch);
    lastId = batch[batch.length - 1].id;
    if (batch.length < 1000) break;
  }
  const missing = rows.filter(
    (r) => r.fiscal_quarter === null || r.fiscal_year === null || r.period_end === null,
  );
  console.log(
    `[${new Date().toISOString()}] earnings_history: ${rows.length} rows scanned, ${missing.length} missing fiscal data${apply ? "" : " [DRY RUN]"}`,
  );

  const bySymbol = new Map<string, HistoryRow[]>();
  for (const r of missing) {
    if (!bySymbol.has(r.symbol)) bySymbol.set(r.symbol, []);
    bySymbol.get(r.symbol)!.push(r);
  }
  const symbols = Array.from(bySymbol.keys()).sort();
  console.log(`  ${symbols.length} symbols to process\n`);

  let backfilled = 0;
  let leftNull = 0;
  const conflicts: Conflict[] = [];
  const todayIso = new Date().toISOString().slice(0, 10);

  for (let i = 0; i < symbols.length; i += 1) {
    const sym = symbols[i];
    const symRows = bySymbol.get(sym)!;

    let finnhubRows: Array<{ period: string; quarter: number; year: number }> = [];
    let calendar: Array<{
      announcementDate: string;
      year: number | null;
      quarter: number | null;
      fiscalYear: number | null;
      fiscalQuarter: number | null;
      periodEnd: string | null;
    }> = [];
    try {
      finnhubRows = await fetchFinnhubEarnings(sym, "2015-01-01", todayIso);
    } catch {
      /* best-effort */
    }
    try {
      calendar = await fetchFinnhubEarningsCalendar(sym);
    } catch {
      /* best-effort */
    }

    // Yahoo: direct match by announcement date — genuine fiscal fields only.
    const yahooByDate = new Map<string, FiscalTriple>();
    for (const c of calendar) {
      if (c.fiscalQuarter !== null && c.fiscalYear !== null) {
        yahooByDate.set(c.announcementDate, {
          quarter: c.fiscalQuarter,
          year: c.fiscalYear,
          period: c.periodEnd,
        });
      }
    }

    // Finnhub rows are keyed by fiscal quarter-end, not announcement
    // date — re-map via the same Yahoo (year,quarter)->announcementDate
    // match key updateEncyclopedia uses, so a Finnhub row lands on the
    // same earnings_history row its own ingest would have written to.
    const calendarByQuarter = new Map<string, string>(); // "year|quarter" -> announcementDate
    for (const c of calendar) {
      if (c.year !== null && c.quarter !== null) {
        calendarByQuarter.set(`${c.year}|${c.quarter}`, c.announcementDate);
      }
    }
    const finnhubByDate = new Map<string, FiscalTriple>();
    for (const r of finnhubRows) {
      const annDate = calendarByQuarter.get(`${r.year}|${r.quarter}`);
      if (annDate) {
        finnhubByDate.set(annDate, { quarter: r.quarter, year: r.year, period: r.period });
      }
    }

    let symBackfilled = 0;
    let symNull = 0;
    let symConflict = 0;
    for (const row of symRows) {
      const fh = finnhubByDate.get(row.earnings_date) ?? null;
      const yh = yahooByDate.get(row.earnings_date) ?? null;

      let chosen: FiscalTriple | null = null;
      if (fh && yh) {
        const quarterYearDisagree = fh.quarter !== yh.quarter || fh.year !== yh.year;
        if (quarterYearDisagree) {
          // Genuine fiscal-identifier conflict — don't write any of the
          // three fields, report it.
          conflicts.push({ symbol: sym, earnings_date: row.earnings_date, finnhub: fh, yahoo: yh });
          symConflict += 1;
          continue;
        }
        // Quarter/year agree — Finnhub's `period` and Yahoo's
        // `periodEndDate` are each their own month-end-rounded
        // approximation of the real fiscal close (confirmed live: e.g.
        // NVDA FQ2 2026 reads period_end 2025-09-30 from Finnhub vs
        // 2025-07-31 from Yahoo, ~2 months apart, despite both correctly
        // agreeing it's FQ2 2026). That's source imprecision, not a
        // fiscal-identifier disagreement — write the agreed
        // quarter/year, leave period_end null rather than guess which
        // source's rounding is closer to the real close date.
        const periodsDiffer = fh.period !== null && yh.period !== null && fh.period !== yh.period;
        chosen = {
          quarter: fh.quarter,
          year: fh.year,
          period: periodsDiffer ? null : (fh.period ?? yh.period),
        };
      } else if (fh) {
        chosen = fh;
      } else if (yh) {
        chosen = yh;
      }

      if (!chosen) {
        symNull += 1;
        continue;
      }
      if (apply) {
        const up = await sb
          .from("earnings_history")
          .update({
            fiscal_quarter: chosen.quarter,
            fiscal_year: chosen.year,
            period_end: chosen.period,
          })
          .eq("id", row.id);
        if (up.error) {
          console.warn(`  update failed for ${sym} ${row.earnings_date}: ${up.error.message}`);
          symNull += 1;
          continue;
        }
      }
      symBackfilled += 1;
    }
    backfilled += symBackfilled;
    leftNull += symNull;
    console.log(
      `[${i + 1}/${symbols.length}] ${sym}: backfilled=${symBackfilled} null=${symNull} conflict=${symConflict}`,
    );
    // Light courtesy delay on top of fetchFinnhubEarnings' own 200ms.
    await new Promise((res) => setTimeout(res, 100));
  }

  console.log(`\n=== earnings_history fiscal backfill${apply ? "" : " (DRY RUN)"} ===`);
  console.log(`rows scanned: ${rows.length}`);
  console.log(`missing fiscal data (candidates): ${missing.length}`);
  console.log(`backfilled: ${backfilled}`);
  console.log(`left null (no source match): ${leftNull}`);
  console.log(`conflicts (Finnhub vs Yahoo disagree — NOT written): ${conflicts.length}`);
  for (const c of conflicts) {
    console.log(
      `  ${c.symbol} ${c.earnings_date}: finnhub=FQ${c.finnhub.quarter} ${c.finnhub.year} (period_end ${c.finnhub.period ?? "—"}) ` +
        `vs yahoo=FQ${c.yahoo.quarter} ${c.yahoo.year} (period_end ${c.yahoo.period ?? "—"})`,
    );
  }

  // ---------- stock_encyclopedia: fiscal_year_end_month ----------

  const encRows: Array<{ id: string; symbol: string }> = [];
  lastId = "00000000-0000-0000-0000-000000000000";
  for (;;) {
    let q = sb
      .from("stock_encyclopedia")
      .select("id,symbol")
      .is("fiscal_year_end_month", null)
      .order("id", { ascending: true })
      .gt("id", lastId)
      .limit(1000);
    if (onlySymbol) q = q.eq("symbol", onlySymbol);
    const res = await q;
    const batch = (res.data ?? []) as Array<{ id: string; symbol: string }>;
    if (batch.length === 0) break;
    encRows.push(...batch);
    lastId = batch[batch.length - 1].id;
    if (batch.length < 1000) break;
  }
  console.log(
    `\n[${new Date().toISOString()}] stock_encyclopedia: ${encRows.length} rows missing fiscal_year_end_month${apply ? "" : " [DRY RUN]"}`,
  );

  let fyeBackfilled = 0;
  let fyeNull = 0;
  for (let i = 0; i < encRows.length; i += 1) {
    const row = encRows[i];
    try {
      const month = await getFiscalYearEndMonth(row.symbol);
      if (month === null) {
        fyeNull += 1;
      } else {
        if (apply) {
          const up = await sb
            .from("stock_encyclopedia")
            .update({ fiscal_year_end_month: month })
            .eq("id", row.id);
          if (up.error) {
            console.warn(`  update failed for ${row.symbol}: ${up.error.message}`);
            fyeNull += 1;
            continue;
          }
        }
        fyeBackfilled += 1;
      }
    } catch (e) {
      console.warn(`  lookup failed for ${row.symbol}: ${e instanceof Error ? e.message : e}`);
      fyeNull += 1;
    }
    if ((i + 1) % 25 === 0 || i === encRows.length - 1) {
      console.log(`  [${i + 1}/${encRows.length}] fye backfilled=${fyeBackfilled} null=${fyeNull}`);
    }
    // SEC EDGAR courtesy rate limit — well under their ~10 req/s guidance.
    await new Promise((res) => setTimeout(res, 120));
  }

  console.log(`\n=== stock_encyclopedia fiscal_year_end_month backfill${apply ? "" : " (DRY RUN)"} ===`);
  console.log(`examined: ${encRows.length}`);
  console.log(`backfilled: ${fyeBackfilled}`);
  console.log(`left null (SEC EDGAR has no CIK/fiscalYearEnd for this symbol): ${fyeNull}`);

  if (!apply) {
    console.log("\nDRY RUN — rerun with --apply to persist");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

// Additive-only extension of earnings_price_paths from +20 to +25.
// Existing offsets -5..+20 are NEVER rewritten — only offsets +21..+25
// are computed and upserted. This matters because Yahoo's adjClose can
// drift retroactively (new dividends since the original pull), so a
// blind re-pull-and-upsert of the whole window risks silently changing
// already-analyzed history; this script never builds a payload row for
// any offset <= 20, so that risk doesn't apply here regardless.
//
// Anchoring: identical method to backfill-earnings-price-paths.ts —
// anchorIdx = first trading day on/after earnings_date, offsets are
// array-position offsets from that anchor, not calendar arithmetic.
// Before writing, each row's freshly-computed offset-20 close is
// compared against the ALREADY-STORED offset-20 close as a consistency
// check (anchor drift / post-hoc stock split would show up here); a
// mismatch beyond tolerance blocks the write for that row rather than
// risking misaligned new offsets next to unchanged old ones.
//
// Usage: npx tsx scripts/extend-earnings-price-paths-25.ts [--dry] [--max N] [--concurrency N]
import { readFileSync, writeFileSync } from "node:fs";
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

const PROJECT_REF = "zoqrxhdpthyxxqapcjgz";
async function sql(query: string): Promise<any[]> {
  const token = readFileSync(resolve(process.env.HOME ?? "", ".supabase/access-token"), "utf8").trim();
  const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const json = await res.json();
  if (!Array.isArray(json)) throw new Error(`SQL failed: ${JSON.stringify(json)}\nQuery: ${query.slice(0, 300)}`);
  return json;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Known-delisted symbols that already failed the original -5..+20
// backfill (no post-delisting Yahoo coverage). Skipped proactively —
// same failure mode would just recur.
const DELISTED = new Set(["HOLX", "K", "JNPR", "HES", "CTRA", "WBA", "DFS", "ANSS", "BK", "DAY", "IPG"]);

const MIN_OFFSET = -5;
const NEW_MAX_OFFSET = 25;
const OLD_MAX_OFFSET = 20;

type Candidate = {
  earnings_history_id: string;
  symbol: string;
  earnings_date: string;
  offset20_close: number;
};
type Bar = { iso: string; close: number; adjClose: number | null; volume: number | null };

function addDaysIso(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function relDiff(a: number, b: number): number {
  return Math.abs(a / b - 1);
}

async function runPool<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next;
      next += 1;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return out;
}

async function main() {
  loadEnvLocal();
  const dry = process.argv.includes("--dry");
  const maxArg = process.argv.indexOf("--max");
  const concArg = process.argv.indexOf("--concurrency");
  const concurrency = concArg !== -1 ? Number(process.argv[concArg + 1]) : 4;

  const YahooFinanceMod = (await import("yahoo-finance2")).default;
  const yf = new (YahooFinanceMod as unknown as new () => {
    historical: (
      symbol: string,
      opts: { period1: Date; period2: Date; interval: "1d" },
      moduleOpts: { validateResult: boolean },
    ) => Promise<Array<{ date: Date; close: number; adjClose?: number; volume: number }>>;
    suppressNotices?: (keys: string[]) => void;
  })();
  try {
    yf.suppressNotices?.(["yahooSurvey"]);
  } catch {
    // cosmetic only
  }
  const MODULE_OPTS = { validateResult: false } as const;

  const { createServerClient } = await import("../lib/supabase");
  const sb = createServerClient();

  console.log("finding candidates: vendor_derived-date events with offset +20 but missing offset +25 ...");
  const rows = await sql(`
    select eh.id as earnings_history_id, eh.symbol, eh.earnings_date::text as earnings_date,
           p20.close as offset20_close
    from earnings_history eh
    join earnings_price_paths p20
      on p20.earnings_history_id = eh.id and p20.trading_day_offset = ${OLD_MAX_OFFSET}
    where eh.date_confidence = 'vendor_derived'
      and not exists (
        select 1 from earnings_price_paths p25
        where p25.earnings_history_id = eh.id and p25.trading_day_offset = ${NEW_MAX_OFFSET}
      )
  `);
  const allCandidates = rows as Candidate[];
  const delistedSkipped = allCandidates.filter((r) => DELISTED.has(r.symbol.toUpperCase()));
  let candidates = allCandidates.filter((r) => !DELISTED.has(r.symbol.toUpperCase()));
  const maxN = maxArg !== -1 ? Number(process.argv[maxArg + 1]) : candidates.length;
  candidates = candidates.slice(0, maxN);

  console.log(
    `total needing extension: ${allCandidates.length}, delisted-skipped: ${delistedSkipped.length}, attempting: ${candidates.length}${dry ? " [dry run]" : ""}`,
  );
  if (dry) {
    for (const c of candidates.slice(0, 20)) console.log(`  ${c.symbol}@${c.earnings_date}`);
    return;
  }

  let fullCoverage = 0; // got all 5 new offsets (21-25)
  let partialCoverage = 0; // got 1-4 new offsets (recent event, not all trading days elapsed yet)
  let zeroNewTooRecent = 0; // got 0 new offsets, no error — event too recent
  let failed = 0;
  let anchorMismatch = 0;
  const failures: Array<{ symbol: string; earnings_date: string; reason: string }> = [];
  let done = 0;

  await runPool(candidates, concurrency, async (row) => {
    const sym = row.symbol.toUpperCase();
    try {
      // Same padding philosophy as the original backfill, scaled up for
      // a further +5 trading days beyond the old +20 boundary.
      const period1 = new Date(addDaysIso(row.earnings_date, -15) + "T00:00:00Z");
      const period2 = new Date(addDaysIso(row.earnings_date, 50) + "T00:00:00Z");
      const bars = await yf.historical(sym, { period1, period2, interval: "1d" }, MODULE_OPTS);

      if (!Array.isArray(bars) || bars.length === 0) {
        failed += 1;
        failures.push({ symbol: sym, earnings_date: row.earnings_date, reason: "no_bars_returned" });
        done += 1;
        return;
      }

      const normalized: Bar[] = bars
        .map((b) => ({
          iso: b.date instanceof Date ? b.date.toISOString().slice(0, 10) : String(b.date).slice(0, 10),
          close: Number(b.close),
          adjClose: typeof b.adjClose === "number" && Number.isFinite(b.adjClose) ? b.adjClose : null,
          volume: Number.isFinite(b.volume) ? b.volume : null,
        }))
        .filter((b) => b.iso && Number.isFinite(b.close) && b.close > 0)
        .sort((a, b) => a.iso.localeCompare(b.iso));

      if (normalized.length === 0) {
        failed += 1;
        failures.push({ symbol: sym, earnings_date: row.earnings_date, reason: "no_valid_bars_after_filter" });
        done += 1;
        return;
      }

      const anchorIdx = normalized.findIndex((b) => b.iso >= row.earnings_date);
      if (anchorIdx === -1) {
        failed += 1;
        failures.push({ symbol: sym, earnings_date: row.earnings_date, reason: "no_bar_on_or_after_earnings_date" });
        done += 1;
        return;
      }

      const idx20 = anchorIdx + OLD_MAX_OFFSET;
      if (idx20 < 0 || idx20 >= normalized.length) {
        // Can't re-locate the already-stored offset-20 bar in this
        // fetch to verify alignment — treat conservatively as failed
        // rather than write unverified offsets.
        failed += 1;
        failures.push({ symbol: sym, earnings_date: row.earnings_date, reason: "cannot_relocate_offset20_for_verification" });
        done += 1;
        return;
      }
      const recomputedOffset20Close = normalized[idx20].close;
      if (row.offset20_close > 0 && relDiff(recomputedOffset20Close, row.offset20_close) > 0.01) {
        anchorMismatch += 1;
        failed += 1;
        failures.push({
          symbol: sym,
          earnings_date: row.earnings_date,
          reason: `anchor_mismatch: stored_offset20_close=${row.offset20_close} recomputed=${recomputedOffset20Close}`,
        });
        done += 1;
        return;
      }

      const payload: Array<Record<string, unknown>> = [];
      for (let offset = OLD_MAX_OFFSET + 1; offset <= NEW_MAX_OFFSET; offset += 1) {
        const idx = anchorIdx + offset;
        if (idx < 0 || idx >= normalized.length) continue; // event too recent for this offset yet
        const bar = normalized[idx];
        payload.push({
          earnings_history_id: row.earnings_history_id,
          symbol: sym,
          earnings_date: row.earnings_date,
          trading_day_offset: offset,
          trade_date: bar.iso,
          close: bar.close,
          adj_close: bar.adjClose,
          volume: bar.volume,
          price_source: "yahoo",
        });
      }

      if (payload.length === 0) {
        zeroNewTooRecent += 1;
        done += 1;
        return;
      }

      const up = await sb
        .from("earnings_price_paths")
        .upsert(payload, { onConflict: "symbol,earnings_date,trading_day_offset" });
      if (up.error) {
        failed += 1;
        failures.push({ symbol: sym, earnings_date: row.earnings_date, reason: `db_error: ${up.error.message}` });
        done += 1;
        return;
      }

      if (payload.length === NEW_MAX_OFFSET - OLD_MAX_OFFSET) fullCoverage += 1;
      else partialCoverage += 1;
    } catch (e) {
      failed += 1;
      failures.push({
        symbol: sym,
        earnings_date: row.earnings_date,
        reason: `exception: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
    done += 1;
    if (done % 50 === 0 || done === candidates.length) {
      console.log(
        `progress ${done}/${candidates.length} — full=${fullCoverage} partial=${partialCoverage} zeroNew=${zeroNewTooRecent} failed=${failed}`,
      );
    }
    await sleep(120);
  });

  const report = {
    totalNeedingExtension: allCandidates.length,
    delistedSkipped: delistedSkipped.map((d) => `${d.symbol}@${d.earnings_date}`),
    attempted: candidates.length,
    fullCoverage,
    partialCoverage,
    zeroNewTooRecent,
    failed,
    anchorMismatch,
    failures,
  };
  console.log("\n==== extend-earnings-price-paths-25 done ====");
  console.log(JSON.stringify({ ...report, failures: undefined }, null, 2));
  writeFileSync(resolve(process.cwd(), "extend-earnings-price-paths-report.json"), JSON.stringify(report, null, 2));
  console.log("\nfull report: extend-earnings-price-paths-report.json");
}
main().catch((e) => {
  console.error("[extend-earnings-price-paths-25] fatal:", e);
  process.exit(1);
});

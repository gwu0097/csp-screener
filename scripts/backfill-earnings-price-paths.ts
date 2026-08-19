// Backfills earnings_price_paths: raw daily closes for trading_day_offset
// -5..+20 around every earnings_history event with a trusted date
// (date_confidence='vendor_derived' — the direct successor of the old
// 'confirmed' value this comment originally named). Built to support a
// post-earnings-drift
// study — see PASS_2026-08-03 data-quality audit (chat record) for why
// offset 0 is defined as "first trading day on/after earnings_date"
// rather than a BMO/AMC-aware reaction day: earnings_history.timing is
// null on ~97% of rows, so baking a reaction-day guess into the offset
// would silently encode an unverifiable assumption for nearly the whole
// table. Consumers needing the true reaction bar must re-derive
// BMO/AMC themselves (join earnings_history for whatever timing exists,
// or re-derive from Yahoo the way lib/encyclopedia.ts does).
//
// close     = Yahoo's standard close (split-adjusted only, NOT dividend-adjusted).
// adj_close = split AND dividend adjusted (Yahoo's adjClose).
// Both stored raw; no returns are computed or persisted here.
//
// Usage: npx tsx scripts/backfill-earnings-price-paths.ts <candidates.json> [--max N] [--dry] [--concurrency N]
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Candidate = { earnings_history_id: string; symbol: string; earnings_date: string };

type Bar = { iso: string; close: number; adjClose: number | null; volume: number | null };

const MIN_OFFSET = -5;
const MAX_OFFSET = 25;

// Same concurrency-pool shape as lib/market-snapshot.ts's runPool.
async function runPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
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

function addDaysIso(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function main() {
  loadEnvLocal();
  const YahooFinanceMod = (await import("yahoo-finance2")).default;
  // Same instantiation pattern as lib/yahoo.ts: v3's default export is the
  // class itself, not a pre-instantiated client — `new YahooFinance()`
  // once, reuse the instance for every call.
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

  const fileArg = process.argv[2];
  if (!fileArg || fileArg.startsWith("--")) {
    console.error(
      "usage: npx tsx scripts/backfill-earnings-price-paths.ts <candidates.json> [--max N] [--dry] [--concurrency N]",
    );
    process.exit(1);
  }
  const queueAll = JSON.parse(readFileSync(resolve(fileArg), "utf8")) as Candidate[];
  const maxArg = process.argv.indexOf("--max");
  const max = maxArg !== -1 ? Number(process.argv[maxArg + 1]) : queueAll.length;
  const concArg = process.argv.indexOf("--concurrency");
  const concurrency = concArg !== -1 ? Number(process.argv[concArg + 1]) : 4;
  const dry = process.argv.includes("--dry");
  const queue = queueAll.slice(0, max);

  console.log(
    `queued=${queue.length} concurrency=${concurrency}${dry ? " [dry run]" : ""}`,
  );
  if (dry) {
    for (const q of queue.slice(0, 20)) console.log(`  ${q.symbol}@${q.earnings_date}`);
    return;
  }

  let succeeded = 0;
  let rowsWritten = 0;
  let failed = 0;
  let skippedExisting = 0;
  const failures: Array<{ symbol: string; earnings_date: string; reason: string }> = [];
  let done = 0;

  await runPool(queue, concurrency, async (row) => {
    const sym = row.symbol.toUpperCase();
    try {
      // Idempotent: skip events already fully backfilled (26 possible
      // offsets, -5..+20) so a re-run after a partial failure only
      // retries what's missing.
      const existing = await sb
        .from("earnings_price_paths")
        .select("trading_day_offset")
        .eq("symbol", sym)
        .eq("earnings_date", row.earnings_date);
      const existingCount = (existing.data as unknown[] | null)?.length ?? 0;
      if (existingCount >= MAX_OFFSET - MIN_OFFSET + 1) {
        skippedExisting += 1;
        done += 1;
        return;
      }

      // Pad well beyond the -5..+20 trading-day window to survive
      // weekends/holidays: ~15 calendar days back covers 5 trading
      // days easily, ~35 calendar days forward covers 20 trading days
      // even through a holiday cluster.
      const period1 = new Date(addDaysIso(row.earnings_date, -15) + "T00:00:00Z");
      const period2 = new Date(addDaysIso(row.earnings_date, 35) + "T00:00:00Z");
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

      // Anchor = first trading day on/after earnings_date.
      const anchorIdx = normalized.findIndex((b) => b.iso >= row.earnings_date);
      if (anchorIdx === -1) {
        // Every returned bar is before earnings_date — Yahoo has no
        // coverage on/after the event (e.g. future event with no
        // trading yet, or a delisting).
        failed += 1;
        failures.push({
          symbol: sym,
          earnings_date: row.earnings_date,
          reason: "no_bar_on_or_after_earnings_date",
        });
        done += 1;
        return;
      }

      const payload: Array<Record<string, unknown>> = [];
      for (let offset = MIN_OFFSET; offset <= MAX_OFFSET; offset += 1) {
        const idx = anchorIdx + offset;
        if (idx < 0 || idx >= normalized.length) continue; // out of padded range — logged via coverage %, not per-row
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
        failed += 1;
        failures.push({ symbol: sym, earnings_date: row.earnings_date, reason: "empty_payload_after_windowing" });
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

      succeeded += 1;
      rowsWritten += payload.length;
    } catch (e) {
      failed += 1;
      failures.push({
        symbol: sym,
        earnings_date: row.earnings_date,
        reason: `exception: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
    done += 1;
    if (done % 50 === 0 || done === queue.length) {
      console.log(
        `progress ${done}/${queue.length} — ok=${succeeded} rows=${rowsWritten} skipped=${skippedExisting} failed=${failed}`,
      );
    }
    // Small per-request stagger on top of the concurrency cap so the
    // effective request rate stays polite to Yahoo's undocumented API.
    await sleep(120);
  });

  console.log("\n==== earnings_price_paths backfill done ====");
  console.log(
    `attempted=${queue.length} succeeded=${succeeded} rowsWritten=${rowsWritten} ` +
      `skippedExisting=${skippedExisting} failed=${failed}`,
  );
  const logPath = resolve("scripts/.earnings-price-path-failures.json");
  writeFileSync(logPath, JSON.stringify(failures, null, 2));
  console.log(`failure log written to ${logPath} (${failures.length} entries)`);
  if (failures.length > 0) {
    const byReason = new Map<string, number>();
    for (const f of failures) byReason.set(f.reason.split(":")[0], (byReason.get(f.reason.split(":")[0]) ?? 0) + 1);
    console.log("failure breakdown:", Object.fromEntries(byReason));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

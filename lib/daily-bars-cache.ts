// Shared daily-OHLCV cache backing both screeners' EOD-settling data —
// the swing screener's ATR14 (lib/swing-screener.ts) and the CSP
// screener's Stage 3 realized-vol proxy (lib/screener.ts). Daily bars
// settle once at close, so caching the raw bars (not a derived value)
// lets whichever screener runs first each day warm the cache for the
// other. See migrations/2026-07-20-add-shared-caching-tables.sql.
import { createServerClient } from "@/lib/supabase";
import { getHistoricalPrices } from "@/lib/yahoo";

export type DailyBar = {
  date: string; // YYYY-MM-DD
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;
// Wide enough for the swing screener's ~40-calendar-day ATR window and
// the CSP screener's ~45-calendar-day realized-vol window, with margin
// for weekends/holidays — both callers slice what they need off the
// tail.
const DAILY_BARS_WINDOW_DAYS = 95;

// Hard requirement: a row older than this is treated as unusable and a
// live fetch is always performed instead, REGARDLESS of force-fresh. A
// stop or vol read computed off multi-day-stale bars with no visible
// sign anything's wrong is a real risk, not a theoretical one — this
// check is unconditional, never gated behind the opt-in force-fresh
// flag callers pass for the *normal* cache-bypass path.
export const DAILY_BARS_STALE_MS = 30 * 60 * 60 * 1000; // ~30h

type CachedRow = { bars: DailyBar[]; last_refreshed_at: string };

async function fetchFreshBars(symbol: string): Promise<DailyBar[]> {
  const to = new Date();
  const from = new Date(to.getTime() - DAILY_BARS_WINDOW_DAYS * DAY_MS);
  const rows = await getHistoricalPrices(symbol, from, to);
  return rows
    .filter(
      (b) =>
        typeof b.date !== "undefined" &&
        b.high > 0 &&
        b.low > 0 &&
        b.close > 0,
    )
    .map((b) => ({
      date: new Date(b.date).toISOString().slice(0, 10),
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
      volume: b.volume,
    }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

async function writeCache(symbol: string, bars: DailyBar[]): Promise<void> {
  if (bars.length === 0) return;
  try {
    const sb = createServerClient();
    await sb.from("daily_bars_cache").upsert(
      {
        symbol,
        trading_day: bars[bars.length - 1].date,
        bars,
        last_refreshed_at: new Date().toISOString(),
      },
      { onConflict: "symbol,trading_day" },
    );
  } catch (e) {
    console.warn(
      `[daily-bars-cache] ${symbol}: write failed — ${e instanceof Error ? e.message : e}`,
    );
  }
}

// Returns the most recent cached bars for `symbol`, refreshing from
// Yahoo when there's no usable cache. `forceFresh` skips the cache
// *read* (always fetches live) but the result is still written back,
// so a force-fresh run leaves the cache warm for the next normal run.
// Staleness beyond DAILY_BARS_STALE_MS always triggers a live fetch,
// independent of `forceFresh`.
export async function getOrFetchDailyBars(
  symbol: string,
  opts: { forceFresh?: boolean } = {},
): Promise<DailyBar[]> {
  const sym = symbol.toUpperCase();
  if (!opts.forceFresh) {
    try {
      const sb = createServerClient();
      const r = await sb
        .from("daily_bars_cache")
        .select("bars,last_refreshed_at")
        .eq("symbol", sym)
        .order("trading_day", { ascending: false })
        .limit(1);
      if (!r.error && r.data && r.data.length > 0) {
        const row = r.data[0] as CachedRow;
        const ageMs = Date.now() - new Date(row.last_refreshed_at).getTime();
        if (ageMs < DAILY_BARS_STALE_MS) {
          return row.bars;
        }
        console.warn(
          `[daily-bars-cache] ${sym}: cached row is ${(ageMs / 3_600_000).toFixed(1)}h old ` +
            `(>${DAILY_BARS_STALE_MS / 3_600_000}h) — falling back to a live fetch automatically.`,
        );
      }
    } catch (e) {
      console.warn(
        `[daily-bars-cache] ${sym}: read failed — ${e instanceof Error ? e.message : e}`,
      );
    }
  }
  const bars = await fetchFreshBars(sym);
  await writeCache(sym, bars);
  return bars;
}

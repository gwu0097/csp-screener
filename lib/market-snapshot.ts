// Central per-symbol market snapshot: fetch Yahoo once, compute
// technicals/returns, cache in symbol_market_snapshot. Features read
// through getOrRefreshSnapshot / batchRefreshSnapshots instead of
// hitting Yahoo directly (see DATA-ARCHITECTURE-AUDIT.md).
import { createServerClient } from "@/lib/supabase";
import {
  getQuoteEnrichment,
  getHistoricalPrices,
  getResearchSnapshot,
} from "@/lib/yahoo";
import { computeRSI, computeSMA } from "@/lib/indicators";

export type Price5d = { date: string; close: number; change_pct: number | null };

// Snake_case to mirror the DB columns 1:1 (the row is returned to
// callers as-is and upserted without remapping).
export type SymbolSnapshot = {
  symbol: string;
  company_name: string | null;
  price: number | null;
  change_pct: number | null;
  change_amt: number | null;
  week52_high: number | null;
  week52_low: number | null;
  pct_from_52w_high: number | null;
  sma200: number | null;
  vs_sma200_pct: number | null;
  sma50: number | null;
  vs_sma50_pct: number | null;
  sma20: number | null;
  vs_sma20_pct: number | null;
  rsi14: number | null;
  trailing_pe: number | null;
  forward_pe: number | null;
  peg_ratio: number | null;
  market_cap: number | null;
  analyst_target: number | null;
  upside_to_target: number | null;
  return_3m: number | null;
  return_1y: number | null;
  return_3y: number | null;
  vs_spy_3y: number | null;
  price_history_5d: Price5d[] | null;
  last_refreshed_at: string;
  refresh_source: string;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_CONCURRENT = 10;

function round(n: number | null, dp = 4): number | null {
  if (n === null || !Number.isFinite(n)) return null;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

// Ascending-by-date closes (>0) from a Yahoo historical pull.
function sortedCloses(
  bars: Array<{ date: Date; close: number }>,
): Array<{ date: Date; close: number }> {
  return [...bars]
    .filter((b) => typeof b.close === "number" && b.close > 0 && b.date)
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
}

// 3Y return % from a daily series (earliest close → latest close).
function threeYearReturn(
  bars: Array<{ date: Date; close: number }>,
): number | null {
  const s = sortedCloses(bars);
  if (s.length < 2) return null;
  const first = s[0].close;
  const last = s[s.length - 1].close;
  if (first <= 0) return null;
  return ((last - first) / first) * 100;
}

// SPY 3Y benchmark — fetched once per batch and reused.
async function spyThreeYearReturn(): Promise<number | null> {
  const to = new Date();
  const from = new Date(to.getTime() - 3 * 365 * DAY_MS - 7 * DAY_MS);
  const bars = await getHistoricalPrices("SPY", from, to).catch(() => []);
  return threeYearReturn(bars);
}

type RefreshOpts = {
  // Pre-fetched SPY 3Y return so a batch doesn't re-pull SPY per symbol.
  spy3yReturn?: number | null;
};

export async function refreshSymbolSnapshot(
  symbol: string,
  opts: RefreshOpts = {},
): Promise<SymbolSnapshot | null> {
  const sym = symbol.toUpperCase();
  const now = new Date();
  // 95d window so we reliably get >= 28 trading bars for RSI + the 20d
  // SMA + the ~3-month return anchor.
  const from90 = new Date(now.getTime() - 95 * DAY_MS);
  const from3y = new Date(now.getTime() - 3 * 365 * DAY_MS - 7 * DAY_MS);

  const [quote, bars90, bars3y, spy3y] = await Promise.all([
    getQuoteEnrichment(sym).catch(() => null),
    getHistoricalPrices(sym, from90, now).catch(() => []),
    getHistoricalPrices(sym, from3y, now).catch(() => []),
    opts.spy3yReturn !== undefined
      ? Promise.resolve(opts.spy3yReturn)
      : spyThreeYearReturn(),
  ]);

  // No quote / no price ⇒ the refresh failed; caller falls back to stale.
  if (!quote || quote.regularMarketPrice === null) {
    console.warn(`[snapshot] ${sym}: Yahoo quote unavailable — refresh failed`);
    return null;
  }
  const price = quote.regularMarketPrice;

  // ---- Technicals from the 90d series ----
  const series90 = sortedCloses(bars90);
  const closes90 = series90.map((b) => b.close);
  const rsi14 = round(computeRSI(closes90, 14), 2);
  const sma20 = round(computeSMA(closes90, 20), 4);
  const vs_sma20_pct =
    sma20 !== null && sma20 > 0 ? round(((price - sma20) / sma20) * 100) : null;

  // 3-month return: earliest close in the 90d window → current price.
  const return_3m =
    closes90.length > 0 && closes90[0] > 0
      ? round(((price - closes90[0]) / closes90[0]) * 100)
      : null;

  // Last 5 bars with per-day change% (computed against the prior bar in
  // the full series so the first of the five still has a change).
  const price_history_5d: Price5d[] = [];
  const startIdx = Math.max(1, series90.length - 5);
  for (let i = startIdx; i < series90.length; i += 1) {
    const prev = series90[i - 1].close;
    const cur = series90[i].close;
    price_history_5d.push({
      date: new Date(series90[i].date).toISOString().slice(0, 10),
      close: round(cur, 4) as number,
      change_pct: prev > 0 ? round(((cur - prev) / prev) * 100, 2) : null,
    });
  }

  // ---- Returns from the 3Y series ----
  const series3y = sortedCloses(bars3y);
  const return_3y =
    series3y.length >= 2 && series3y[0].close > 0
      ? round(((price - series3y[0].close) / series3y[0].close) * 100)
      : null;
  // 1Y return: close nearest to one year ago within the 3Y series.
  let return_1y: number | null = null;
  if (series3y.length >= 2) {
    const target = now.getTime() - 365 * DAY_MS;
    let best = series3y[0];
    let bestDiff = Infinity;
    for (const b of series3y) {
      const diff = Math.abs(new Date(b.date).getTime() - target);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = b;
      }
    }
    if (best.close > 0) return_1y = round(((price - best.close) / best.close) * 100);
  }
  const vs_spy_3y =
    return_3y !== null && spy3y !== null && spy3y !== undefined
      ? round(return_3y - spy3y)
      : null;

  // ---- Quote-derived fields ----
  const sma200 = quote.twoHundredDayAverage;
  const vs_sma200_pct =
    sma200 !== null && sma200 > 0 ? round(((price - sma200) / sma200) * 100) : null;
  // 50-day SMA + analyst target are already in the quote payload — just
  // not stored until now. No extra Yahoo call.
  const sma50 = quote.fiftyDayAverage;
  const vs_sma50_pct =
    sma50 !== null && sma50 > 0 ? round(((price - sma50) / sma50) * 100) : null;
  // Yahoo's lightweight /quote payload stopped carrying targetMeanPrice
  // and pegRatio (late 2025) — when they're missing, one quoteSummary
  // call (financialData + defaultKeyStatistics) backfills both.
  let analystTarget = quote.targetMeanPrice;
  let pegRatio = quote.pegRatio;
  if (analystTarget === null || pegRatio === null) {
    const research = await getResearchSnapshot(sym).catch(() => null);
    if (research) {
      analystTarget = analystTarget ?? research.targetMeanPrice;
      pegRatio = pegRatio ?? research.pegRatio;
    }
  }
  const upsideToTarget =
    analystTarget !== null && price > 0
      ? round(((analystTarget - price) / price) * 100)
      : null;
  const change_pct = quote.regularMarketChangePercent;
  // Yahoo's light quote doesn't carry the $ change, derive it from %.
  const change_amt =
    change_pct !== null
      ? round(price - price / (1 + change_pct / 100))
      : null;
  const pct_from_52w_high =
    quote.fiftyTwoWeekHigh !== null && quote.fiftyTwoWeekHigh > 0
      ? round(((price - quote.fiftyTwoWeekHigh) / quote.fiftyTwoWeekHigh) * 100)
      : null;

  const snapshot: SymbolSnapshot = {
    symbol: sym,
    company_name: quote.companyName,
    price: round(price),
    change_pct: round(change_pct, 2),
    change_amt,
    week52_high: round(quote.fiftyTwoWeekHigh),
    week52_low: round(quote.fiftyTwoWeekLow),
    pct_from_52w_high,
    sma200: round(sma200),
    vs_sma200_pct,
    sma50: round(sma50),
    vs_sma50_pct,
    sma20,
    vs_sma20_pct,
    rsi14,
    trailing_pe: round(quote.trailingPE),
    forward_pe: round(quote.forwardPE),
    peg_ratio: round(pegRatio),
    market_cap: quote.marketCap,
    analyst_target: round(analystTarget),
    upside_to_target: upsideToTarget,
    return_3m,
    return_1y,
    return_3y,
    vs_spy_3y,
    price_history_5d,
    last_refreshed_at: now.toISOString(),
    refresh_source: "yahoo",
  };

  // Upsert is best-effort — if the table is missing or Supabase errors,
  // still return the computed snapshot so callers degrade gracefully.
  try {
    const sb = createServerClient();
    // Tolerate newer columns not being migrated yet (company_name,
    // sma50, analyst_target, …): on a "column not found" error, strip
    // the column the error names and retry, so the cache still persists
    // everything else before the ALTER runs.
    let payload: Record<string, unknown> = { ...snapshot };
    let error: { message: string } | null = null;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const res = await sb
        .from("symbol_market_snapshot")
        .upsert(payload, { onConflict: "symbol" });
      error = res.error;
      if (!error) break;
      const m = error.message.match(
        /'([a-z_]+)' column|column "?([a-z_]+)"? does not exist/i,
      );
      const col = m?.[1] ?? m?.[2];
      if (!col || !(col in payload) || col === "symbol") break;
      const { [col]: _drop, ...rest } = payload;
      void _drop;
      payload = rest;
    }
    if (error) {
      console.warn(`[snapshot] ${sym}: upsert failed — ${error.message}`);
    }
  } catch (e) {
    console.warn(
      `[snapshot] ${sym}: upsert threw — ${e instanceof Error ? e.message : e}`,
    );
  }

  return snapshot;
}

function isFresh(row: { last_refreshed_at?: string | null }, maxAgeMinutes: number): boolean {
  if (!row.last_refreshed_at) return false;
  const ts = new Date(row.last_refreshed_at).getTime();
  return Number.isFinite(ts) && Date.now() - ts < maxAgeMinutes * 60 * 1000;
}

export async function getOrRefreshSnapshot(
  symbol: string,
  maxAgeMinutes = 15,
): Promise<SymbolSnapshot | null> {
  const sym = symbol.toUpperCase();
  let cached: SymbolSnapshot | null = null;
  try {
    const sb = createServerClient();
    const r = await sb
      .from("symbol_market_snapshot")
      .select("*")
      .eq("symbol", sym)
      .limit(1);
    if (!r.error && r.data && r.data.length > 0) {
      cached = r.data[0] as SymbolSnapshot;
      if (isFresh(cached, maxAgeMinutes)) return cached;
    }
  } catch (e) {
    console.warn(
      `[snapshot] ${sym}: cache read failed — ${e instanceof Error ? e.message : e}`,
    );
  }
  const fresh = await refreshSymbolSnapshot(sym);
  // Yahoo failed: serve stale data if we have any, else null.
  return fresh ?? cached;
}

// Run `fn` over items with a concurrency cap.
async function runPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next;
      next += 1;
      out[i] = await fn(items[i]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
  return out;
}

export async function batchRefreshSnapshots(
  symbols: string[],
  maxAgeMinutes = 15,
): Promise<SymbolSnapshot[]> {
  const uniq = Array.from(new Set(symbols.map((s) => s.toUpperCase()))).filter(Boolean);
  if (uniq.length === 0) return [];

  // Existing rows in one query.
  const bySymbol = new Map<string, SymbolSnapshot>();
  try {
    const sb = createServerClient();
    const r = await sb
      .from("symbol_market_snapshot")
      .select("*")
      .in("symbol", uniq);
    if (!r.error) {
      for (const row of (r.data ?? []) as SymbolSnapshot[]) {
        bySymbol.set(row.symbol.toUpperCase(), row);
      }
    }
  } catch (e) {
    console.warn(
      `[snapshot] batch cache read failed — ${e instanceof Error ? e.message : e}`,
    );
  }

  const stale = uniq.filter((s) => {
    const row = bySymbol.get(s);
    return !row || !isFresh(row, maxAgeMinutes);
  });

  // SPY 3Y fetched ONCE, reused across every stale refresh.
  const spy3yReturn = stale.length > 0 ? await spyThreeYearReturn() : null;

  const refreshed = await runPool(stale, MAX_CONCURRENT, async (s) => {
    const snap = await refreshSymbolSnapshot(s, { spy3yReturn });
    return { sym: s, snap };
  });
  for (const { sym, snap } of refreshed) {
    if (snap) bySymbol.set(sym, snap);
  }

  // Return in input order; drop symbols we have nothing for (Yahoo failed
  // and no stale row existed).
  return uniq
    .map((s) => bySymbol.get(s) ?? null)
    .filter((x): x is SymbolSnapshot => x !== null);
}

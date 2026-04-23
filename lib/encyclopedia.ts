// Stock Encyclopedia — Phase 1.
//
// For each symbol we ingest historical earnings events into earnings_history
// and roll them up into one stock_encyclopedia row. Read paths on the page
// hit the encyclopedia row only; detail views pull the history rows for
// that one symbol. Aggregates are precomputed on write, not SELECT.
//
// Data sources this phase:
//   - Finnhub /stock/earnings for EPS + revenue estimates/actuals
//   - Yahoo Finance for price_before / price_after / price_at_expiry
//   - Schwab options chain for implied_move_pct when connected + chain
//     still available (only useful for recent events). Past events get
//     null implied move — breach/recovery fields then stay null too.
//
// Deliberately null on historical backfill (no data source):
//   - iv_before / iv_after / iv_crushed / iv_crush_magnitude
//     These get populated prospectively from position_snapshots once the
//     screener has actually watched a position through earnings.
//   - sector_performance_pct, analyst_sentiment, news_summary (Phase 2).
import { createServerClient } from "@/lib/supabase";
import { finnhubGet } from "@/lib/earnings";
import { getHistoricalPrices } from "@/lib/yahoo";
import {
  getOptionsChain,
  isSchwabConnected,
  type SchwabOptionsChain,
} from "@/lib/schwab";

const FINNHUB_RATE_DELAY_MS = 200;

export type StockEncyclopedia = {
  id: string;
  symbol: string;
  last_historical_pull_date: string | null;
  total_earnings_records: number;
  crush_rate: number | null;
  avg_move_ratio: number | null;
  beat_rate: number | null;
  recovery_rate_after_breach: number | null;
  avg_iv_crush_magnitude: number | null;
  created_at: string;
  updated_at: string;
};

export type EarningsHistory = {
  id: string;
  symbol: string;
  earnings_date: string;
  eps_estimate: number | null;
  eps_actual: number | null;
  eps_surprise_pct: number | null;
  revenue_estimate: number | null;
  revenue_actual: number | null;
  revenue_surprise_pct: number | null;
  price_before: number | null;
  price_after: number | null;
  actual_move_pct: number | null;
  implied_move_pct: number | null;
  move_ratio: number | null;
  iv_before: number | null;
  iv_after: number | null;
  iv_crushed: boolean | null;
  iv_crush_magnitude: number | null;
  two_x_em_strike: number | null;
  breached_two_x_em: boolean | null;
  recovered_by_expiry: boolean | null;
  price_at_expiry: number | null;
  sector_performance_pct: number | null;
  analyst_sentiment: string | null;
  news_summary: string | null;
  perplexity_pulled_at: string | null;
  data_source: string;
  is_complete: boolean;
  created_at: string;
};

type FinnhubEarningsRow = {
  actual: number | null;
  estimate: number | null;
  period: string; // YYYY-MM-DD
  quarter: number;
  surprise: number | null;
  surprisePercent: number | null;
  symbol: string;
  year: number;
};

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function addDaysIso(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// First Friday on or after the given date. Used to locate the post-earnings
// expiry for recovery analysis. Mirrors lib/screener.ts::nextFridayOnOrAfter.
function nextFridayOnOrAfterIso(iso: string): string {
  const d = new Date(iso + "T00:00:00Z");
  const day = d.getUTCDay();
  const delta = (5 - day + 7) % 7;
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

// ---------- Encyclopedia row lifecycle ----------

export async function getOrCreateEncyclopediaEntry(
  symbol: string,
): Promise<StockEncyclopedia> {
  const sb = createServerClient();
  const sym = symbol.toUpperCase();
  const existing = await sb
    .from("stock_encyclopedia")
    .select("*")
    .eq("symbol", sym)
    .limit(1);
  const rows = (existing.data ?? []) as StockEncyclopedia[];
  if (rows.length > 0) return rows[0];

  const inserted = await sb
    .from("stock_encyclopedia")
    .insert({ symbol: sym, total_earnings_records: 0 })
    .select()
    .single();
  if (inserted.error || !inserted.data) {
    throw new Error(
      `encyclopedia create failed for ${sym}: ${inserted.error?.message ?? "no row"}`,
    );
  }
  return inserted.data as StockEncyclopedia;
}

// Returns the date window we still need to fetch — from the last pull
// forward to today. Callers feed this to Finnhub /stock/earnings.
export async function getMissingEarningsDates(
  symbol: string,
): Promise<{ from: string; to: string }> {
  const entry = await getOrCreateEncyclopediaEntry(symbol);
  const from = entry.last_historical_pull_date ?? "2020-01-01";
  return { from, to: todayIso() };
}

// ---------- Finnhub earnings ingestion ----------

export async function fetchFinnhubEarnings(
  symbol: string,
  from: string,
  to: string,
): Promise<FinnhubEarningsRow[]> {
  const sym = symbol.toUpperCase();
  try {
    // Finnhub free-tier /stock/earnings returns the 4 most recent quarters
    // by default, and date-filters are best-effort — we still filter
    // client-side to the requested window so we don't upsert stale rows
    // outside the user-specified backfill period.
    const rows = await finnhubGet<FinnhubEarningsRow[]>("/stock/earnings", {
      symbol: sym,
      from,
      to,
    });
    await sleep(FINNHUB_RATE_DELAY_MS);
    return Array.isArray(rows)
      ? rows.filter((r) => typeof r.period === "string" && r.period >= from && r.period <= to)
      : [];
  } catch (e) {
    console.warn(
      `[encyclopedia] Finnhub /stock/earnings(${sym}, ${from}..${to}) failed: ${e instanceof Error ? e.message : e}`,
    );
    return [];
  }
}

// ---------- Yahoo price action ----------

export type PriceAction = {
  price_before: number | null;
  price_after: number | null;
  price_at_expiry: number | null;
  actual_move_pct: number | null;
};

// Fetches Yahoo daily closes around the earnings date and returns the
// nearest-close-on-or-before (price_before), nearest-close-on-or-after
// (price_after), and the close on the following Friday (price_at_expiry).
// Null-safe — if Yahoo has no bar for the window, returns nulls.
export async function fetchYahooPriceAction(
  symbol: string,
  earningsDate: string,
): Promise<PriceAction> {
  // Widen the window a few days on each side so we survive holidays /
  // weekends (e.g. Monday earnings with no Sunday close).
  const fromDate = new Date(addDaysIso(earningsDate, -5) + "T00:00:00Z");
  const expiryIso = nextFridayOnOrAfterIso(addDaysIso(earningsDate, 1));
  const toDate = new Date(addDaysIso(expiryIso, 3) + "T00:00:00Z");
  const bars = await getHistoricalPrices(symbol, fromDate, toDate);
  if (bars.length === 0) {
    return {
      price_before: null,
      price_after: null,
      price_at_expiry: null,
      actual_move_pct: null,
    };
  }
  const toIso = (d: unknown): string => {
    if (d instanceof Date) return d.toISOString().slice(0, 10);
    if (typeof d === "string") return d.slice(0, 10);
    return "";
  };
  const normalized = bars
    .map((b) => ({
      iso: toIso((b as { date?: unknown }).date),
      close: Number((b as { close?: unknown }).close ?? 0),
    }))
    .filter((b) => b.iso && Number.isFinite(b.close) && b.close > 0)
    .sort((a, b) => a.iso.localeCompare(b.iso));

  const lastOnOrBefore = (target: string): number | null => {
    let best: number | null = null;
    for (const b of normalized) {
      if (b.iso <= target) best = b.close;
      else break;
    }
    return best;
  };
  const firstOnOrAfter = (target: string): number | null => {
    for (const b of normalized) if (b.iso >= target) return b.close;
    return null;
  };

  const price_before = lastOnOrBefore(earningsDate);
  const price_after = firstOnOrAfter(addDaysIso(earningsDate, 1));
  const price_at_expiry = lastOnOrBefore(expiryIso);
  const actual_move_pct =
    price_before !== null && price_after !== null && price_before > 0
      ? (price_after - price_before) / price_before
      : null;
  return { price_before, price_after, price_at_expiry, actual_move_pct };
}

// Best-effort implied move from the nearest weekly put chain, if Schwab is
// connected and the chain is still retrievable. Returns null for anything
// in the past where the chain has rolled off — which is almost always.
export async function fetchImpliedMove(
  symbol: string,
  earningsDate: string,
): Promise<number | null> {
  try {
    const connected = await isSchwabConnected().then((r) => r.connected).catch(() => false);
    if (!connected) return null;
    const expiry = nextFridayOnOrAfterIso(addDaysIso(earningsDate, 1));
    const chain = await getOptionsChain(symbol, expiry);
    return atmStraddlePct(chain, expiry);
  } catch {
    return null;
  }
}

function atmStraddlePct(chain: SchwabOptionsChain, expiry: string): number | null {
  const spot =
    chain.underlying?.mark ??
    chain.underlying?.last ??
    chain.underlyingPrice ??
    null;
  if (!spot || spot <= 0) return null;
  const putKeys = Object.keys(chain.putExpDateMap ?? {});
  const callKeys = Object.keys(chain.callExpDateMap ?? {});
  const putKey = putKeys.find((k) => k.startsWith(expiry));
  const callKey = callKeys.find((k) => k.startsWith(expiry));
  if (!putKey || !callKey) return null;
  const puts = chain.putExpDateMap[putKey];
  const calls = chain.callExpDateMap[callKey];
  const strikes = Object.keys(puts)
    .map((k) => Number(k))
    .filter((n) => Number.isFinite(n));
  if (strikes.length === 0) return null;
  const atm = strikes.reduce((best, k) =>
    Math.abs(k - spot) < Math.abs(best - spot) ? k : best,
  );
  const putArr = puts[String(atm)] ?? puts[atm.toFixed(1)] ?? [];
  const callArr = calls[String(atm)] ?? calls[atm.toFixed(1)] ?? [];
  const putMark = putArr[0]?.mark ?? null;
  const callMark = callArr[0]?.mark ?? null;
  if (putMark === null || callMark === null) return null;
  return (putMark + callMark) / spot;
}

// ---------- Breach / recovery analysis ----------

export type BreachResult = {
  two_x_em_strike: number | null;
  breached_two_x_em: boolean | null;
  recovered_by_expiry: boolean | null;
  move_ratio: number | null;
};

// 2x-EM strike is the downside strike the user's CSP strategy targets —
// two expected moves below the pre-earnings close. The breach/recovery
// pair captures "did price go below that strike post-print, and if so did
// it climb back above by expiry". All fields null when implied_move is
// missing (can't compute the strike without it).
export function calculateBreachAnalysis(input: {
  price_before: number | null;
  price_after: number | null;
  price_at_expiry: number | null;
  implied_move_pct: number | null;
  actual_move_pct: number | null;
}): BreachResult {
  const { price_before, price_after, price_at_expiry, implied_move_pct, actual_move_pct } = input;
  if (
    price_before === null ||
    implied_move_pct === null ||
    implied_move_pct <= 0
  ) {
    return {
      two_x_em_strike: null,
      breached_two_x_em: null,
      recovered_by_expiry: null,
      move_ratio:
        actual_move_pct !== null && implied_move_pct && implied_move_pct > 0
          ? Math.abs(actual_move_pct) / implied_move_pct
          : null,
    };
  }
  const two_x_em_strike = price_before * (1 - 2 * implied_move_pct);
  const breached_two_x_em =
    price_after !== null ? price_after < two_x_em_strike : null;
  const recovered_by_expiry =
    breached_two_x_em === true && price_at_expiry !== null
      ? price_at_expiry > two_x_em_strike
      : breached_two_x_em === false
        ? null // not breached → recovery irrelevant
        : null;
  const move_ratio =
    actual_move_pct !== null ? Math.abs(actual_move_pct) / implied_move_pct : null;
  return { two_x_em_strike, breached_two_x_em, recovered_by_expiry, move_ratio };
}

// ---------- Encyclopedia rollup stats ----------

// Null-aware aggregates — we compute each rate over the rows where the
// numerator/denominator are actually present, rather than treating null
// as 0 or false. That keeps early encyclopedia entries (where only EPS is
// populated) from having their crush_rate permanently pinned to 0.
export async function recalculateStats(symbol: string): Promise<StockEncyclopedia | null> {
  const sb = createServerClient();
  const sym = symbol.toUpperCase();
  const res = await sb
    .from("earnings_history")
    .select(
      "iv_crushed,move_ratio,eps_actual,eps_estimate,breached_two_x_em,recovered_by_expiry,iv_crush_magnitude,is_complete",
    )
    .eq("symbol", sym)
    .eq("is_complete", true);
  const rows = (res.data ?? []) as Array<
    Pick<
      EarningsHistory,
      | "iv_crushed"
      | "move_ratio"
      | "eps_actual"
      | "eps_estimate"
      | "breached_two_x_em"
      | "recovered_by_expiry"
      | "iv_crush_magnitude"
      | "is_complete"
    >
  >;

  const total = rows.length;
  const avgOf = (vals: number[]): number | null =>
    vals.length === 0 ? null : vals.reduce((s, v) => s + v, 0) / vals.length;

  const crushSamples = rows
    .map((r) => r.iv_crushed)
    .filter((v): v is boolean => v !== null);
  const crush_rate =
    crushSamples.length === 0
      ? null
      : crushSamples.filter((v) => v === true).length / crushSamples.length;

  const moveRatios = rows
    .map((r) => r.move_ratio)
    .filter((v): v is number => v !== null && Number.isFinite(v));
  const avg_move_ratio = avgOf(moveRatios);

  const beatSamples = rows.filter(
    (r) => r.eps_actual !== null && r.eps_estimate !== null,
  );
  const beat_rate =
    beatSamples.length === 0
      ? null
      : beatSamples.filter(
          (r) => (r.eps_actual as number) > (r.eps_estimate as number),
        ).length / beatSamples.length;

  const breachSamples = rows.filter((r) => r.breached_two_x_em === true);
  const recovery_rate_after_breach =
    breachSamples.length === 0
      ? null
      : breachSamples.filter((r) => r.recovered_by_expiry === true).length /
        breachSamples.length;

  const ivCrushMagnitudes = rows
    .map((r) => r.iv_crush_magnitude)
    .filter((v): v is number => v !== null && Number.isFinite(v));
  const avg_iv_crush_magnitude = avgOf(ivCrushMagnitudes);

  const update = await sb
    .from("stock_encyclopedia")
    .update({
      total_earnings_records: total,
      crush_rate,
      avg_move_ratio,
      beat_rate,
      recovery_rate_after_breach,
      avg_iv_crush_magnitude,
      last_historical_pull_date: todayIso(),
      updated_at: new Date().toISOString(),
    })
    .eq("symbol", sym)
    .select()
    .single();
  if (update.error) {
    console.warn(
      `[encyclopedia] recalculateStats update(${sym}) failed: ${update.error.message}`,
    );
    return null;
  }
  return (update.data as StockEncyclopedia) ?? null;
}

// ---------- Main entry point ----------

export type UpdateSummary = {
  symbol: string;
  newRecords: number;
  updatedRecords: number;
  isComplete: boolean;
};

function pctChange(actual: number | null, estimate: number | null): number | null {
  if (actual === null || estimate === null || estimate === 0) return null;
  return (actual - estimate) / Math.abs(estimate);
}

export async function updateEncyclopedia(symbol: string): Promise<UpdateSummary> {
  const sb = createServerClient();
  const sym = symbol.toUpperCase();
  await getOrCreateEncyclopediaEntry(sym);
  const { from, to } = await getMissingEarningsDates(sym);
  const rows = await fetchFinnhubEarnings(sym, from, to);

  // Pull existing rows for this symbol in one query to decide insert-vs-update
  // and skip already-complete rows.
  const existingRes = await sb
    .from("earnings_history")
    .select("earnings_date,is_complete")
    .eq("symbol", sym);
  const existing = new Map<string, boolean>();
  for (const r of (existingRes.data ?? []) as Array<{
    earnings_date: string;
    is_complete: boolean;
  }>) {
    existing.set(r.earnings_date, r.is_complete);
  }

  let newRecords = 0;
  let updatedRecords = 0;
  for (const r of rows) {
    const earnings_date = r.period;
    const already = existing.get(earnings_date);
    if (already === true) continue; // complete — skip

    const price = await fetchYahooPriceAction(sym, earnings_date);
    const implied_move_pct = await fetchImpliedMove(sym, earnings_date);
    const breach = calculateBreachAnalysis({
      price_before: price.price_before,
      price_after: price.price_after,
      price_at_expiry: price.price_at_expiry,
      implied_move_pct,
      actual_move_pct: price.actual_move_pct,
    });

    // A row is "complete" when the core quantitative fields are present;
    // narrative/IV fields are Phase-2 concerns.
    const is_complete =
      r.actual !== null &&
      r.estimate !== null &&
      price.price_before !== null &&
      price.price_after !== null;

    const payload = {
      symbol: sym,
      earnings_date,
      eps_estimate: r.estimate,
      eps_actual: r.actual,
      // Always compute from (actual, estimate) — Finnhub's surprisePercent
      // field mixes units across rows (sometimes 11.8, sometimes 0.118),
      // so using it directly produced wildly wrong values in the UI. Our
      // pctChange is a consistent fraction, matching every other *_pct
      // column convention.
      eps_surprise_pct: pctChange(r.actual, r.estimate),
      revenue_estimate: null,
      revenue_actual: null,
      revenue_surprise_pct: null,
      price_before: price.price_before,
      price_after: price.price_after,
      actual_move_pct: price.actual_move_pct,
      implied_move_pct,
      move_ratio: breach.move_ratio,
      iv_before: null,
      iv_after: null,
      iv_crushed: null,
      iv_crush_magnitude: null,
      two_x_em_strike: breach.two_x_em_strike,
      breached_two_x_em: breach.breached_two_x_em,
      recovered_by_expiry: breach.recovered_by_expiry,
      price_at_expiry: price.price_at_expiry,
      sector_performance_pct: null,
      analyst_sentiment: null,
      news_summary: null,
      perplexity_pulled_at: null,
      data_source: "finnhub",
      is_complete,
    };
    const up = await sb
      .from("earnings_history")
      .upsert(payload, { onConflict: "symbol,earnings_date" });
    if (up.error) {
      console.warn(
        `[encyclopedia] upsert(${sym}, ${earnings_date}) failed: ${up.error.message}`,
      );
      continue;
    }
    if (already === undefined) newRecords += 1;
    else updatedRecords += 1;
  }

  const recalculated = await recalculateStats(sym);
  return {
    symbol: sym,
    newRecords,
    updatedRecords,
    isComplete: (recalculated?.total_earnings_records ?? 0) > 0,
  };
}

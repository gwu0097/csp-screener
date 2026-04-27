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
import { finnhubGet, getTodayEarnings } from "@/lib/earnings";
import { getHistoricalPrices } from "@/lib/yahoo";
import {
  getOptionsChain,
  isSchwabConnected,
  type SchwabOptionContract,
  type SchwabOptionsChain,
} from "@/lib/schwab";
import YahooFinance from "yahoo-finance2";

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

// Fetches Yahoo daily closes around the earnings date and locates the
// real earnings reaction. The Finnhub /stock/earnings endpoint returns
// `period` (fiscal quarter end, e.g. 2025-03-31) — NOT the announcement
// date (e.g. 2025-04-29 for SPOT Q1) — so a naive lastOnOrBefore /
// firstOnOrAfter pairing on the stored earnings_date returns
// month-of-March drift (~0.3%) instead of the real ~8% earnings gap.
//
// Strategy: scan a ±35-day window for the largest |close-to-close|
// adjacent move. That's the earnings reaction. Auto-handles BMO/AMC
// (whichever pairing produces the biggest gap wins) and stale-date
// rows in earnings_history alike. The chosen pair's earlier bar
// becomes price_before, the later bar becomes price_after.
export async function fetchYahooPriceAction(
  symbol: string,
  earningsDate: string,
): Promise<PriceAction> {
  // ±35-day window so we cover companies that report up to ~5 weeks
  // after quarter end. Plus expiry-week padding on the back end.
  const fromDate = new Date(addDaysIso(earningsDate, -35) + "T00:00:00Z");
  const expiryIso = nextFridayOnOrAfterIso(addDaysIso(earningsDate, 35));
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

  // The earnings_date stored on the row might be either:
  //   (a) the actual announcement date (manual entry / phase-2 path), or
  //   (b) the fiscal quarter end (Finnhub /stock/earnings.period) which
  //       is typically 2–6 weeks before the actual report.
  // Try (a) first by scanning a narrow ±2-day window. If we don't find
  // a real reaction (≥ 1% move) in there, scan the conventional report
  // window [+14d, +42d] for case (b). If still nothing meaningful,
  // fall back to a wide [-7d, +42d] sweep so we always return
  // something reasonable rather than null.
  type Bar = (typeof normalized)[number];
  function biggestGap(window: Bar[]): { prior: number; post: number; move: number } | null {
    let best: { prior: number; post: number; move: number } | null = null;
    for (let i = 1; i < window.length; i += 1) {
      const prior = window[i - 1];
      const post = window[i];
      if (prior.close <= 0) continue;
      const move = (post.close - prior.close) / prior.close;
      if (best === null || Math.abs(move) > Math.abs(best.move)) {
        best = { prior: prior.close, post: post.close, move };
      }
    }
    return best;
  }
  const earnIso = earningsDate;
  const inWindow = (lo: string, hi: string): Bar[] =>
    normalized.filter((b) => b.iso >= lo && b.iso <= hi);

  const nearGap = biggestGap(inWindow(addDaysIso(earnIso, -2), addDaysIso(earnIso, 2)));
  const reportGap = biggestGap(
    inWindow(addDaysIso(earnIso, 14), addDaysIso(earnIso, 42)),
  );
  const wideGap = biggestGap(
    inWindow(addDaysIso(earnIso, -7), addDaysIso(earnIso, 42)),
  );

  // Prefer the report-window gap because that's the principled choice
  // — US earnings land 14–42 days after the fiscal quarter end. Only
  // override with the near-window gap when it's SIGNIFICANTLY bigger
  // (≥ 1.5× reportGap), which is the signature of "earnings_date is
  // already the actual announcement date" rather than a quarter end.
  let chosen: ReturnType<typeof biggestGap> = null;
  if (reportGap && Math.abs(reportGap.move) >= 0.005) {
    chosen = reportGap;
    if (
      nearGap &&
      Math.abs(nearGap.move) >= Math.abs(reportGap.move) * 1.5 &&
      Math.abs(nearGap.move) >= 0.01
    ) {
      chosen = nearGap;
    }
  } else if (nearGap && Math.abs(nearGap.move) >= 0.01) {
    chosen = nearGap;
  } else {
    chosen = wideGap;
  }

  const bestPriorClose = chosen?.prior ?? null;
  const bestPostClose = chosen?.post ?? null;

  // price_at_expiry stays anchored on the earnings_date's expiry — it's
  // the close on the Friday after earnings_date+1 — even when the
  // chosen reaction pair is offset by a few weeks. The expiry-day
  // analysis depends on the option position's expiry, which is keyed
  // off earnings_date in the screener flow.
  const lastOnOrBefore = (target: string): number | null => {
    let best: number | null = null;
    for (const b of normalized) {
      if (b.iso <= target) best = b.close;
      else break;
    }
    return best;
  };
  const price_at_expiry = lastOnOrBefore(expiryIso);

  return {
    price_before: bestPriorClose,
    price_after: bestPostClose,
    price_at_expiry,
    actual_move_pct:
      bestPriorClose !== null && bestPostClose !== null && bestPriorClose > 0
        ? (bestPostClose - bestPriorClose) / bestPriorClose
        : null,
  };
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
  // Pull Yahoo's earnings calendar so each Finnhub /stock/earnings row
  // (keyed by fiscal-quarter end) can be re-mapped to its real
  // announcement date + BMO/AMC hour. The calendar covers ~4 recent
  // quarters; older rows fall back to period date and the wider
  // gap-scan in fetchYahooPriceAction.
  let calendar: CalendarEntry[] = [];
  try {
    calendar = await fetchFinnhubEarningsCalendar(sym);
  } catch (e) {
    console.warn(
      `[encyclopedia] calendar fetch failed for ${sym}: ${e instanceof Error ? e.message : e}`,
    );
  }
  const calendarByQuarter = new Map<string, CalendarEntry>();
  for (const c of calendar) {
    if (c.year !== null && c.quarter !== null) {
      calendarByQuarter.set(`${c.year}|${c.quarter}`, c);
    }
  }

  // Pull existing rows for this symbol in one query to decide insert-vs-update
  // and skip already-complete rows. We also pull actual_move_pct so we can
  // re-run rows whose stored move is implausibly small (almost certainly a
  // pre-fix row computed against the fiscal-quarter-end date instead of the
  // real announcement date — see fetchYahooPriceAction).
  const existingRes = await sb
    .from("earnings_history")
    .select("earnings_date,is_complete,actual_move_pct")
    .eq("symbol", sym);
  const existing = new Map<string, { is_complete: boolean; actual_move_pct: number | null }>();
  for (const r of (existingRes.data ?? []) as Array<{
    earnings_date: string;
    is_complete: boolean;
    actual_move_pct: number | null;
  }>) {
    existing.set(r.earnings_date, {
      is_complete: r.is_complete,
      actual_move_pct: r.actual_move_pct,
    });
  }

  let newRecords = 0;
  let updatedRecords = 0;
  for (const r of rows) {
    // Prefer the calendar's actual announcement date over the
    // fiscal-quarter-end period. Falls back when calendar coverage
    // doesn't reach this quarter (Yahoo only ships ~4 recent).
    const calMatch = calendarByQuarter.get(`${r.year}|${r.quarter}`);
    const earnings_date = calMatch?.announcementDate ?? r.period;
    const hour = calMatch?.hour ?? null;
    const already = existing.get(earnings_date);
    if (already?.is_complete === true) {
      const m = already.actual_move_pct;
      // Earnings reactions under 1% are almost always wrong (computed
      // against the fiscal quarter end before the price-action fix
      // landed). Re-run those rows so the new logic picks up the real
      // announcement reaction.
      if (m !== null && Math.abs(m) >= 0.01) continue;
    }

    const price = hour
      ? await fetchYahooPriceActionTimed(sym, earnings_date, hour)
      : await fetchYahooPriceAction(sym, earnings_date);
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

  // Phase 2C re-key: any historical rows still stamped at their
  // fiscal-quarter end (from older ingests before this fix landed)
  // get re-keyed to their real announcement dates and re-priced via
  // fetchYahooPriceActionTimed. Best-effort — failure here doesn't
  // poison Phase 1's output. Bails early when the symbol is already
  // clean, so the cost is one Yahoo earnings-module call.
  try {
    const rekey = await reingestHistoricalDates(sym);
    if (rekey.reingested > 0 || rekey.merged_with_existing > 0) {
      console.log(
        `[encyclopedia] phase 2C rekeyed=${rekey.reingested} merged=${rekey.merged_with_existing} for ${sym}`,
      );
    }
  } catch (e) {
    console.warn(
      `[encyclopedia] phase 2C failed for ${sym}: ${e instanceof Error ? e.message : e}`,
    );
  }

  const recalculated = await recalculateStats(sym);
  return {
    symbol: sym,
    newRecords,
    updatedRecords,
    isComplete: (recalculated?.total_earnings_records ?? 0) > 0,
  };
}

// ---------- Phase 2C: historical re-key ----------
//
// Phase 1 used Finnhub /stock/earnings which keys rows by fiscal
// quarter end (e.g. 2025-09-30). The actual TSLA Q3 2025 announcement
// was Oct 22. Every downstream calculation that depends on
// earnings_date is wrong on those rows. This section fixes them in
// place: fetches the real calendar, matches quarter→announcement,
// UPDATEs the earnings_date, re-fetches Yahoo prices with correct
// BMO/AMC timing, and preserves any Perplexity narrative that was
// attached to the old row.

export type CalendarEntry = {
  announcementDate: string; // YYYY-MM-DD
  hour: "bmo" | "amc" | "dmh" | null;
  year: number | null;
  quarter: number | null;
  epsEstimate: number | null;
  epsActual: number | null;
  revenueEstimate: number | null;
  revenueActual: number | null;
};

// Fetches historical announcement dates for a symbol. Named for the
// original Finnhub intent but implemented via Yahoo because Finnhub's
// free tier /calendar/earnings only returns the next upcoming entry for
// symbol-filtered queries and zero rows for historical windows without
// a symbol. Yahoo's earningsChart.quarterly gives us the real
// reportedDate (unix timestamp) keyed to (fiscalQuarter, calendarQuarter)
// — exactly what the re-key needs.
//
// Limitations: Yahoo returns ~4 quarters and takes no date range, so
// the function only accepts a symbol. No explicit bmo/amc hour field
// either; we heuristic-infer from reportedDate's time-of-day:
// timestamps >= 20:00 UTC (roughly >= 4pm ET) → AMC, earlier → BMO.
// Imperfect but close enough for price_before/after selection.
export async function fetchFinnhubEarningsCalendar(
  symbol: string,
): Promise<CalendarEntry[]> {
  const sym = symbol.toUpperCase();
  try {
    const yf = new YahooFinance({
      suppressNotices: ["ripHistorical", "yahooSurvey"],
    });
    const res = (await yf.quoteSummary(sym, {
      modules: ["earnings"],
    })) as {
      earnings?: {
        earningsChart?: {
          quarterly?: Array<{
            date?: string | number;
            periodEndDate?: string | number | Date;
            reportedDate?: string | number | Date;
            fiscalQuarter?: string;
            calendarQuarter?: string;
            actual?: number;
            estimate?: number;
          }>;
        };
      };
    };
    const quarterly = res.earnings?.earningsChart?.quarterly ?? [];
    const entries: CalendarEntry[] = [];
    for (const q of quarterly) {
      const reportedMs =
        typeof q.reportedDate === "number"
          ? q.reportedDate * 1000
          : q.reportedDate instanceof Date
            ? q.reportedDate.getTime()
            : typeof q.reportedDate === "string"
              ? new Date(q.reportedDate).getTime()
              : NaN;
      if (!Number.isFinite(reportedMs)) continue;
      const date = new Date(reportedMs);
      const announcementDate = date.toISOString().slice(0, 10);
      const utcHour = date.getUTCHours();
      const hour: CalendarEntry["hour"] = utcHour >= 20 ? "amc" : "bmo";

      // Parse fiscalQuarter like "3Q2025" → { year: 2025, quarter: 3 }.
      let year: number | null = null;
      let quarter: number | null = null;
      const fq = q.fiscalQuarter ?? q.calendarQuarter ?? q.date;
      if (typeof fq === "string") {
        const m = /^(\d)Q(\d{4})$/.exec(fq);
        if (m) {
          quarter = Number(m[1]);
          year = Number(m[2]);
        }
      }

      entries.push({
        announcementDate,
        hour,
        year,
        quarter,
        epsEstimate: q.estimate ?? null,
        epsActual: q.actual ?? null,
        revenueEstimate: null,
        revenueActual: null,
      });
    }
    return entries;
  } catch (e) {
    console.warn(
      `[encyclopedia:calendar] ${sym} failed: ${e instanceof Error ? e.message : e}`,
    );
    return [];
  }
}

// Given a quarter-end date, derive (year, quarter). "2025-09-30" → {2025, 3}.
function quarterFromEndDate(
  iso: string,
): { year: number; quarter: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const qMap: Record<number, number | undefined> = { 3: 1, 6: 2, 9: 3, 12: 4 };
  const quarter = qMap[month];
  if (!quarter) return null;
  return { year, quarter };
}

function diffDays(aIso: string, bIso: string): number {
  const aMs = new Date(aIso + "T00:00:00Z").getTime();
  const bMs = new Date(bIso + "T00:00:00Z").getTime();
  return Math.abs(aMs - bMs) / 86400000;
}

// Map a quarter-end-keyed row to its real announcement date.
// Primary: calendar entry matching (year, quarter). Fallback: calendar
// entry within ±60 days of the quarter-end date (handles entries where
// Finnhub didn't populate year/quarter).
export function matchQuarterToAnnouncement(
  quarterEndIso: string,
  entries: CalendarEntry[],
): CalendarEntry | null {
  const q = quarterFromEndDate(quarterEndIso);
  if (q) {
    const byQuarter = entries.filter(
      (e) => e.year === q.year && e.quarter === q.quarter,
    );
    if (byQuarter.length > 0) {
      // Most common: one hit. If multiple (rare), pick the one closest
      // in time to the quarter-end.
      byQuarter.sort(
        (a, b) =>
          diffDays(a.announcementDate, quarterEndIso) -
          diffDays(b.announcementDate, quarterEndIso),
      );
      return byQuarter[0];
    }
  }
  let best: CalendarEntry | null = null;
  let bestDiff = Infinity;
  for (const e of entries) {
    const d = diffDays(e.announcementDate, quarterEndIso);
    if (d <= 60 && d < bestDiff) {
      best = e;
      bestDiff = d;
    }
  }
  return best;
}

// Timing-aware price action fetch.
//   BMO announcement on date D → market hasn't opened, so D-1 close is
//     the pre-earnings baseline and D close is the post-reaction.
//   AMC announcement on date D → D close is pre-announcement baseline
//     (market closed before the 4pm print), D+1 close is the reaction.
// Falls back to AMC semantics when timing is unknown — same as what
// fetchYahooPriceAction did in Phase 1.
export async function fetchYahooPriceActionTimed(
  symbol: string,
  announcementDate: string,
  hour: CalendarEntry["hour"],
): Promise<PriceAction> {
  const fromDate = new Date(addDaysIso(announcementDate, -7) + "T00:00:00Z");
  const expiryIso = nextFridayOnOrAfterIso(addDaysIso(announcementDate, 1));
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

  let price_before: number | null;
  let price_after: number | null;
  if (hour === "bmo") {
    price_before = lastOnOrBefore(addDaysIso(announcementDate, -1));
    price_after = lastOnOrBefore(announcementDate);
  } else {
    // AMC or unknown — treat as after-close.
    price_before = lastOnOrBefore(announcementDate);
    price_after = firstOnOrAfter(addDaysIso(announcementDate, 1));
  }
  const price_at_expiry = lastOnOrBefore(expiryIso);
  const actual_move_pct =
    price_before !== null && price_after !== null && price_before > 0
      ? (price_after - price_before) / price_before
      : null;
  return { price_before, price_after, price_at_expiry, actual_move_pct };
}

export type ReingestChange = {
  oldDate: string;
  newDate: string;
  action: "update" | "merge" | "unmatched";
  hour: CalendarEntry["hour"];
};

export type ReingestReport = {
  symbol: string;
  reingested: number;
  merged_with_existing: number;
  unmatched_rows: Array<{ oldDate: string; reason: string }>;
  already_clean: boolean;
  dryRun: boolean;
  changes: ReingestChange[];
};

type ExistingHistoryRowPartial = HistoryRow & {
  id: string;
  eps_estimate: number | null;
  eps_actual: number | null;
  eps_surprise_pct: number | null;
  revenue_estimate: number | null;
  revenue_actual: number | null;
  revenue_surprise_pct: number | null;
};

async function fetchHistoryRowsForSymbol(
  symbol: string,
): Promise<ExistingHistoryRowPartial[]> {
  const sb = createServerClient();
  const r = await sb
    .from("earnings_history")
    .select("*")
    .eq("symbol", symbol.toUpperCase());
  return (r.data ?? []) as ExistingHistoryRowPartial[];
}

export async function reingestHistoricalDates(
  symbol: string,
  opts: { dryRun?: boolean } = {},
): Promise<ReingestReport> {
  const dryRun = opts.dryRun === true;
  const sym = symbol.toUpperCase();
  const report: ReingestReport = {
    symbol: sym,
    reingested: 0,
    merged_with_existing: 0,
    unmatched_rows: [],
    already_clean: false,
    dryRun,
    changes: [],
  };

  const allRows = await fetchHistoryRowsForSymbol(sym);
  const quarterEndRows = allRows.filter((r) => isQuarterEndDate(r.earnings_date));
  if (quarterEndRows.length === 0) {
    report.already_clean = true;
    return report;
  }

  const calendar = await fetchFinnhubEarningsCalendar(sym);
  if (calendar.length === 0) {
    for (const r of quarterEndRows) {
      report.unmatched_rows.push({
        oldDate: r.earnings_date,
        reason: "calendar_empty",
      });
    }
    return report;
  }

  const sb = createServerClient();
  const existingByDate = new Map(allRows.map((r) => [r.earnings_date, r]));

  for (const row of quarterEndRows) {
    const match = matchQuarterToAnnouncement(row.earnings_date, calendar);
    if (!match) {
      report.unmatched_rows.push({
        oldDate: row.earnings_date,
        reason: "no_calendar_match",
      });
      continue;
    }
    const announcementDate = match.announcementDate;
    if (announcementDate === row.earnings_date) {
      // Already correct (not really a quarter-end then — defensive).
      continue;
    }

    const existingAtAnnouncement = existingByDate.get(announcementDate);

    if (dryRun) {
      report.changes.push({
        oldDate: row.earnings_date,
        newDate: announcementDate,
        action: existingAtAnnouncement ? "merge" : "update",
        hour: match.hour,
      });
      continue;
    }

    // Re-fetch Yahoo prices against the correct date + timing.
    const price = await fetchYahooPriceActionTimed(
      sym,
      announcementDate,
      match.hour,
    );

    // Use calendar EPS/revenue if available; fall back to what the old
    // row already had. The /calendar endpoint is more authoritative per
    // spec notes.
    const merged = {
      eps_estimate: match.epsEstimate ?? row.eps_estimate,
      eps_actual: match.epsActual ?? row.eps_actual,
      revenue_estimate: match.revenueEstimate ?? row.revenue_estimate,
      revenue_actual: match.revenueActual ?? row.revenue_actual,
    };
    const eps_surprise_pct =
      merged.eps_actual !== null &&
      merged.eps_estimate !== null &&
      merged.eps_estimate !== 0
        ? (merged.eps_actual - merged.eps_estimate) / Math.abs(merged.eps_estimate)
        : row.eps_surprise_pct;
    const revenue_surprise_pct =
      merged.revenue_actual !== null &&
      merged.revenue_estimate !== null &&
      merged.revenue_estimate !== 0
        ? (merged.revenue_actual - merged.revenue_estimate) / Math.abs(merged.revenue_estimate)
        : row.revenue_surprise_pct;

    if (existingAtAnnouncement) {
      // MERGE: the T0-inserted row at the announcement date keeps its
      // live-captured implied_move_pct / iv_before / etc. We copy in
      // EPS and revenue from the old row where the newer row has null,
      // but we deliberately CLEAR Perplexity fields — any narrative
      // previously attached to either row was generated against the
      // pre-rekey actual_move_pct (wrong) and is now stale. Clearing
      // forces ensurePerplexityData to re-pull on the next maintenance
      // run, where it'll read the corrected actual_move_pct.
      const newerRow = existingAtAnnouncement;
      const updatePayload = {
        eps_estimate: newerRow.eps_estimate ?? merged.eps_estimate,
        eps_actual: newerRow.eps_actual ?? merged.eps_actual,
        eps_surprise_pct: newerRow.eps_surprise_pct ?? eps_surprise_pct,
        revenue_estimate: newerRow.revenue_estimate ?? merged.revenue_estimate,
        revenue_actual: newerRow.revenue_actual ?? merged.revenue_actual,
        revenue_surprise_pct: newerRow.revenue_surprise_pct ?? revenue_surprise_pct,
        analyst_sentiment: null,
        news_summary: null,
        perplexity_pulled_at: null,
        price_before: price.price_before,
        price_after: price.price_after,
        actual_move_pct: price.actual_move_pct,
        // Only recompute move_ratio when we have both legs in hand; a
        // newer row with implied_move_pct and a freshly-recomputed
        // actual_move_pct yields the correct ratio.
        move_ratio:
          price.actual_move_pct !== null &&
          newerRow.implied_move_pct !== null &&
          newerRow.implied_move_pct > 0
            ? Math.abs(price.actual_move_pct) / newerRow.implied_move_pct
            : newerRow.move_ratio,
        data_source: "finnhub+calendar-rekey",
      };
      const u = await sb
        .from("earnings_history")
        .update(updatePayload)
        .eq("id", newerRow.id);
      if (u.error) {
        report.unmatched_rows.push({
          oldDate: row.earnings_date,
          reason: `merge_update_failed: ${u.error.message}`,
        });
        continue;
      }
      const d = await sb.from("earnings_history").delete().eq("id", row.id);
      if (d.error) {
        report.unmatched_rows.push({
          oldDate: row.earnings_date,
          reason: `merge_delete_failed: ${d.error.message}`,
        });
        continue;
      }
      report.merged_with_existing += 1;
      report.changes.push({
        oldDate: row.earnings_date,
        newDate: announcementDate,
        action: "merge",
        hour: match.hour,
      });
      await ensurePriceAtExpiry(sym, announcementDate);
      continue;
    }

    // No existing row at the announcement date — simply UPDATE in place.
    // Clear Perplexity fields too: any narrative on this row was
    // generated against the wrong earnings_date / actual_move_pct and
    // is now stale. ensurePerplexityData will re-pull on the next
    // maintenance run using the corrected values.
    const updatePayload = {
      earnings_date: announcementDate,
      eps_estimate: merged.eps_estimate,
      eps_actual: merged.eps_actual,
      eps_surprise_pct,
      revenue_estimate: merged.revenue_estimate,
      revenue_actual: merged.revenue_actual,
      revenue_surprise_pct,
      price_before: price.price_before,
      price_after: price.price_after,
      actual_move_pct: price.actual_move_pct,
      price_at_expiry: null, // cleared — ensurePriceAtExpiry refills below
      recovered_by_expiry: null,
      analyst_sentiment: null,
      news_summary: null,
      perplexity_pulled_at: null,
      data_source: "finnhub+calendar-rekey",
    };
    const u = await sb
      .from("earnings_history")
      .update(updatePayload)
      .eq("id", row.id);
    if (u.error) {
      report.unmatched_rows.push({
        oldDate: row.earnings_date,
        reason: `update_failed: ${u.error.message}`,
      });
      continue;
    }
    report.reingested += 1;
    report.changes.push({
      oldDate: row.earnings_date,
      newDate: announcementDate,
      action: "update",
      hour: match.hour,
    });
    existingByDate.set(announcementDate, {
      ...row,
      earnings_date: announcementDate,
      price_before: price.price_before,
      price_after: price.price_after,
      actual_move_pct: price.actual_move_pct,
    });
    existingByDate.delete(row.earnings_date);
    await ensurePriceAtExpiry(sym, announcementDate);
  }

  if (!dryRun) {
    await recalculateStats(sym);
  }
  return report;
}

// ---------- Phase 2A: live capture + backfill ----------
//
// Design principle: every capture function is idempotent. Callers can
// safely invoke them every Run Analysis — they gate on the relevant
// column being NULL and bail out if data already exists. Nothing
// overwrites. Partial writes are forbidden — either we have all the
// fields for a given stage or we skip the row entirely.

type HistoryRow = {
  symbol: string;
  earnings_date: string;
  price_before: number | null;
  price_after: number | null;
  implied_move_pct: number | null;
  two_x_em_strike: number | null;
  iv_before: number | null;
  iv_after: number | null;
  actual_move_pct: number | null;
  move_ratio: number | null;
  iv_crushed: boolean | null;
  iv_crush_magnitude: number | null;
  breached_two_x_em: boolean | null;
  price_at_expiry: number | null;
  recovered_by_expiry: boolean | null;
  perplexity_pulled_at: string | null;
  analyst_sentiment: string | null;
  news_summary: string | null;
  eps_estimate: number | null;
  eps_actual: number | null;
  eps_surprise_pct: number | null;
  revenue_estimate: number | null;
  revenue_actual: number | null;
  revenue_surprise_pct: number | null;
};

async function readHistoryRow(
  symbol: string,
  earningsDate: string,
): Promise<HistoryRow | null> {
  const sb = createServerClient();
  const r = await sb
    .from("earnings_history")
    .select("*")
    .eq("symbol", symbol.toUpperCase())
    .eq("earnings_date", earningsDate)
    .limit(1);
  if (r.error) return null;
  const rows = (r.data ?? []) as HistoryRow[];
  return rows[0] ?? null;
}

async function upsertHistoryStub(
  symbol: string,
  earningsDate: string,
): Promise<void> {
  const sb = createServerClient();
  const existing = await readHistoryRow(symbol, earningsDate);
  if (existing) return;
  await sb
    .from("earnings_history")
    .upsert(
      {
        symbol: symbol.toUpperCase(),
        earnings_date: earningsDate,
        data_source: "encyclopedia-live",
        is_complete: false,
      },
      { onConflict: "symbol,earnings_date" },
    );
}

// Picks the strike closest to spot and returns the ATM call + ATM put
// contract objects for a given expiry key match. Returns null if either
// leg is missing. Shares the strike-lookup pattern used by lib/snapshots.ts.
function atmLegs(
  chain: SchwabOptionsChain,
  expiryIso: string,
): { call: SchwabOptionContract; put: SchwabOptionContract; strike: number; spot: number } | null {
  const spot =
    chain.underlying?.mark ??
    chain.underlying?.last ??
    chain.underlyingPrice ??
    null;
  if (!spot || spot <= 0) return null;
  const putKeys = Object.keys(chain.putExpDateMap ?? {});
  const callKeys = Object.keys(chain.callExpDateMap ?? {});
  const putKey = putKeys.find((k) => k.startsWith(expiryIso));
  const callKey = callKeys.find((k) => k.startsWith(expiryIso));
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
  const putArr = puts[String(atm)] ?? puts[atm.toFixed(1)] ?? puts[atm.toFixed(2)] ?? [];
  const callArr = calls[String(atm)] ?? calls[atm.toFixed(1)] ?? calls[atm.toFixed(2)] ?? [];
  const put = putArr[0];
  const call = callArr[0];
  if (!put || !call) return null;
  return { call, put, strike: atm, spot };
}

// ---------- T0: pre-earnings capture ----------

export type T0Result =
  | {
      captured: true;
      implied_move_pct: number;
      iv_before: number;
      price_before: number;
      two_x_em_strike: number;
    }
  | { captured: false; skipped: true; reason: string };

export async function captureEarningsT0(
  symbol: string,
  earningsDate: string,
): Promise<T0Result> {
  const sym = symbol.toUpperCase();
  await upsertHistoryStub(sym, earningsDate);
  const row = await readHistoryRow(sym, earningsDate);
  if (!row) return { captured: false, skipped: true, reason: "row_not_found" };
  if (row.implied_move_pct !== null) {
    return { captured: false, skipped: true, reason: "already_captured" };
  }

  const connected = await isSchwabConnected()
    .then((r) => r.connected)
    .catch(() => false);
  if (!connected) {
    return { captured: false, skipped: true, reason: "schwab_disconnected" };
  }

  // Nearest weekly expiry on or after earningsDate+1. For an AMC today,
  // that lands on the same-week Friday; for a pre-weekend announcement,
  // the following Friday.
  const expiryIso = nextFridayOnOrAfterIso(addDaysIso(earningsDate, 1));
  let chain: SchwabOptionsChain;
  try {
    chain = await getOptionsChain(sym, expiryIso);
  } catch (e) {
    console.warn(
      `[encyclopedia:T0] chain(${sym}, ${expiryIso}) failed: ${e instanceof Error ? e.message : e}`,
    );
    return { captured: false, skipped: true, reason: "chain_fetch_failed" };
  }

  const legs = atmLegs(chain, expiryIso);
  if (!legs) {
    return { captured: false, skipped: true, reason: "no_options_data" };
  }
  const callMid = legs.call.mark;
  const putMid = legs.put.mark;
  if (!Number.isFinite(callMid) || !Number.isFinite(putMid)) {
    return { captured: false, skipped: true, reason: "no_options_data" };
  }
  const price_before = legs.spot;
  const straddle = callMid + putMid;
  const implied_move_pct = straddle / price_before;
  // Schwab returns volatility as a percent (e.g. 45.6). Store decimal to
  // match every other *_pct / iv field convention in the project.
  const callIv = Number.isFinite(legs.call.volatility) ? legs.call.volatility / 100 : null;
  const putIv = Number.isFinite(legs.put.volatility) ? legs.put.volatility / 100 : null;
  const iv_before =
    callIv !== null && putIv !== null
      ? (callIv + putIv) / 2
      : callIv ?? putIv ?? null;
  if (iv_before === null) {
    return { captured: false, skipped: true, reason: "no_iv_data" };
  }
  const two_x_em_strike = price_before * (1 - 2 * implied_move_pct);

  const sb = createServerClient();
  const up = await sb
    .from("earnings_history")
    .update({
      price_before,
      implied_move_pct,
      iv_before,
      two_x_em_strike,
    })
    .eq("symbol", sym)
    .eq("earnings_date", earningsDate);
  if (up.error) {
    console.warn(`[encyclopedia:T0] update(${sym}, ${earningsDate}) failed: ${up.error.message}`);
    return { captured: false, skipped: true, reason: `db_error:${up.error.message}` };
  }
  return { captured: true, implied_move_pct, iv_before, price_before, two_x_em_strike };
}

// ---------- T1: post-earnings capture ----------

export type T1Result =
  | {
      captured: true;
      actual_move_pct: number;
      move_ratio: number;
      iv_crushed: boolean;
      iv_crush_magnitude: number;
      breached_two_x_em: boolean;
    }
  | { captured: false; skipped: true; reason: string };

export async function captureEarningsT1(
  symbol: string,
  earningsDate: string,
): Promise<T1Result> {
  const sym = symbol.toUpperCase();
  const row = await readHistoryRow(sym, earningsDate);
  if (!row) return { captured: false, skipped: true, reason: "row_not_found" };
  if (row.iv_after !== null) {
    return { captured: false, skipped: true, reason: "already_captured" };
  }
  if (
    row.price_before === null ||
    row.implied_move_pct === null ||
    row.iv_before === null ||
    row.two_x_em_strike === null
  ) {
    return { captured: false, skipped: true, reason: "no_t0_data" };
  }

  const connected = await isSchwabConnected()
    .then((r) => r.connected)
    .catch(() => false);
  if (!connected) {
    return { captured: false, skipped: true, reason: "schwab_disconnected" };
  }

  const expiryIso = nextFridayOnOrAfterIso(addDaysIso(earningsDate, 1));
  let chain: SchwabOptionsChain;
  try {
    chain = await getOptionsChain(sym, expiryIso);
  } catch (e) {
    console.warn(
      `[encyclopedia:T1] chain(${sym}, ${expiryIso}) failed: ${e instanceof Error ? e.message : e}`,
    );
    return { captured: false, skipped: true, reason: "chain_fetch_failed" };
  }
  const legs = atmLegs(chain, expiryIso);
  if (!legs) {
    return { captured: false, skipped: true, reason: "no_options_data" };
  }
  const price_after = legs.spot;
  const callIv = Number.isFinite(legs.call.volatility) ? legs.call.volatility / 100 : null;
  const putIv = Number.isFinite(legs.put.volatility) ? legs.put.volatility / 100 : null;
  const iv_after =
    callIv !== null && putIv !== null
      ? (callIv + putIv) / 2
      : callIv ?? putIv ?? null;
  if (iv_after === null) {
    return { captured: false, skipped: true, reason: "no_iv_data" };
  }

  const price_before = row.price_before;
  const implied_move_pct = row.implied_move_pct;
  const iv_before = row.iv_before;
  const two_x_em_strike = row.two_x_em_strike;
  const actual_move_pct = (price_after - price_before) / price_before;
  const move_ratio = Math.abs(actual_move_pct) / implied_move_pct;
  const iv_crushed = iv_after < iv_before * 0.7;
  const iv_crush_magnitude = (iv_before - iv_after) / iv_before;
  const breached_two_x_em = price_after < two_x_em_strike;

  const sb = createServerClient();
  const up = await sb
    .from("earnings_history")
    .update({
      price_after,
      iv_after,
      actual_move_pct,
      move_ratio,
      iv_crushed,
      iv_crush_magnitude,
      breached_two_x_em,
      is_complete: true,
    })
    .eq("symbol", sym)
    .eq("earnings_date", earningsDate);
  if (up.error) {
    console.warn(`[encyclopedia:T1] update(${sym}, ${earningsDate}) failed: ${up.error.message}`);
    return { captured: false, skipped: true, reason: `db_error:${up.error.message}` };
  }
  return {
    captured: true,
    actual_move_pct,
    move_ratio,
    iv_crushed,
    iv_crush_magnitude,
    breached_two_x_em,
  };
}

// ---------- Price at expiry backfill ----------

// Quarter-end dates from Phase 1's /stock/earnings ingestion always land
// on the last day of Mar/Jun/Sep/Dec. Those aren't announcement dates, so
// "next Friday after earnings" computes a wildly wrong expiry. Skip them.
function isQuarterEndDate(iso: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return false;
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (![3, 6, 9, 12].includes(month)) return false;
  // Last day of Mar/Jun/Sep/Dec: 31 / 30 / 30 / 31.
  return (month === 3 && day === 31) ||
    (month === 6 && day === 30) ||
    (month === 9 && day === 30) ||
    (month === 12 && day === 31);
}

export type ExpiryResult =
  | {
      captured: true;
      price_at_expiry: number;
      recovered_by_expiry: boolean | null;
    }
  | { captured: false; skipped: true; reason: string };

export async function ensurePriceAtExpiry(
  symbol: string,
  earningsDate: string,
): Promise<ExpiryResult> {
  const sym = symbol.toUpperCase();
  const row = await readHistoryRow(sym, earningsDate);
  if (!row) return { captured: false, skipped: true, reason: "row_not_found" };
  if (row.price_at_expiry !== null) {
    return { captured: false, skipped: true, reason: "already_captured" };
  }
  if (isQuarterEndDate(earningsDate)) {
    // Phase 1 legacy row keyed by fiscal quarter end, not announcement.
    // Computing Friday-after would give a meaningless date. Logged so
    // we can spot rows the re-key pass (Phase 2C) couldn't match.
    console.warn(
      `[encyclopedia:expiry] Skipping price_at_expiry for ${sym} ${earningsDate}: quarter-end date indicates unmatched calendar entry.`,
    );
    return { captured: false, skipped: true, reason: "quarter_end_legacy_row" };
  }

  const expiryIso = nextFridayOnOrAfterIso(earningsDate);
  if (expiryIso > todayIso()) {
    return { captured: false, skipped: true, reason: "not_yet_expired" };
  }

  // Widen window a few days each side so holidays/weekends don't leave us
  // with zero bars to pick from.
  const fromD = new Date(addDaysIso(expiryIso, -5) + "T00:00:00Z");
  const toD = new Date(addDaysIso(expiryIso, 5) + "T00:00:00Z");
  const bars = await getHistoricalPrices(sym, fromD, toD);
  if (bars.length === 0) {
    return { captured: false, skipped: true, reason: "yahoo_no_bars" };
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
  let price_at_expiry: number | null = null;
  for (const b of normalized) {
    if (b.iso <= expiryIso) price_at_expiry = b.close;
    else break;
  }
  if (price_at_expiry === null) {
    return { captured: false, skipped: true, reason: "no_close_on_or_before_expiry" };
  }

  const recovered_by_expiry =
    row.two_x_em_strike !== null ? price_at_expiry > row.two_x_em_strike : null;

  const sb = createServerClient();
  const up = await sb
    .from("earnings_history")
    .update({
      price_at_expiry,
      recovered_by_expiry,
    })
    .eq("symbol", sym)
    .eq("earnings_date", earningsDate);
  if (up.error) {
    console.warn(`[encyclopedia:expiry] update(${sym}, ${earningsDate}) failed: ${up.error.message}`);
    return { captured: false, skipped: true, reason: `db_error:${up.error.message}` };
  }
  return { captured: true, price_at_expiry, recovered_by_expiry };
}

// ---------- Perplexity narrative backfill ----------

export type PerplexityPayload = {
  analyst_sentiment: "positive" | "negative" | "mixed" | "neutral";
  primary_reason_for_move: string;
  sector_context: string;
  guidance_assessment: "positive" | "negative" | "neutral" | "not_mentioned";
  key_risks: string[];
  recovery_likelihood: "high" | "medium" | "low";
  summary: string;
};

export type PerplexityResult =
  | { captured: true; sentiment: string }
  | { captured: false; skipped: true; reason: string };

const PERPLEXITY_URL = "https://api.perplexity.ai/chat/completions";

function buildEncyclopediaPrompt(symbol: string, row: HistoryRow): string {
  // Lead with unambiguous ticker framing. Common-word tickers like "NOW"
  // (ServiceNow) get mistaken for temporal adverbs by Perplexity's sonar
  // model — we saw it answer with TSLA-flavored content when the prompt
  // opened with "NOW reported earnings...". Quoting the symbol and
  // explicitly tagging it as a ticker prevents the misread.
  const lines: string[] = [
    `Research the US publicly-traded company whose stock ticker symbol is "${symbol}".`,
    `This company (ticker ${symbol}) reported earnings on ${row.earnings_date}.`,
  ];
  if (row.eps_actual !== null && row.eps_estimate !== null) {
    const surprisePct =
      row.eps_surprise_pct !== null ? (row.eps_surprise_pct * 100).toFixed(1) : "?";
    lines.push(
      `EPS: ${row.eps_actual} vs ${row.eps_estimate} estimate (${surprisePct}% surprise)`,
    );
  }
  if (row.revenue_actual !== null && row.revenue_estimate !== null) {
    const revSurprise =
      row.revenue_surprise_pct !== null ? (row.revenue_surprise_pct * 100).toFixed(1) : "?";
    lines.push(
      `Revenue: ${row.revenue_actual} vs ${row.revenue_estimate} estimate (${revSurprise}% surprise)`,
    );
  }
  if (row.actual_move_pct !== null) {
    lines.push(`Stock reaction: ${(row.actual_move_pct * 100).toFixed(2)}% overnight`);
  }
  lines.push("");
  lines.push(`Research for ${symbol} only (do not substitute another ticker):`);
  lines.push("1. What did analysts say about these earnings? Upgrades/downgrades/price targets.");
  lines.push("2. Primary reason for the stock's reaction.");
  lines.push("3. Was this company-specific or sector-wide?");
  lines.push("4. Any key risks or positive catalysts mentioned?");
  lines.push("5. Guidance commentary if applicable.");
  lines.push("");
  lines.push("Return ONLY a JSON object, no markdown:");
  lines.push(
    `{"analyst_sentiment":"positive|negative|mixed|neutral","primary_reason_for_move":"one-sentence explanation","sector_context":"one sentence on peers and sector","guidance_assessment":"positive|negative|neutral|not_mentioned","key_risks":["risk1","risk2"],"recovery_likelihood":"high|medium|low","summary":"2-3 sentence analyst digest"}`,
  );
  return lines.join("\n");
}

function unwrapJsonBlock(raw: string): string {
  return raw.replace(/```(?:json)?/gi, "").replace(/```/g, "").trim();
}

// Parse cascade: direct → fence-strip → regex object match. Mirrors the
// approach used by the ToS screenshot parser — Perplexity responses are
// mostly clean but the occasional prose-wrapped response needs extraction.
function extractPerplexityJson(raw: string): unknown | null {
  try {
    return JSON.parse(raw);
  } catch {
    /* fallthrough */
  }
  const unwrapped = unwrapJsonBlock(raw);
  try {
    return JSON.parse(unwrapped);
  } catch {
    /* fallthrough */
  }
  const match = unwrapped.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      return JSON.parse(match[0]);
    } catch {
      /* fallthrough */
    }
  }
  return null;
}

function normalizePerplexityPayload(obj: unknown): PerplexityPayload | null {
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  const sentiment = o.analyst_sentiment;
  const validSentiments = ["positive", "negative", "mixed", "neutral"] as const;
  const validGuidance = ["positive", "negative", "neutral", "not_mentioned"] as const;
  const validRecovery = ["high", "medium", "low"] as const;
  const coerceEnum = <T extends string>(v: unknown, valid: readonly T[], fallback: T): T =>
    typeof v === "string" && (valid as readonly string[]).includes(v) ? (v as T) : fallback;
  const risksRaw = Array.isArray(o.key_risks) ? (o.key_risks as unknown[]) : [];
  const key_risks = risksRaw.filter((x): x is string => typeof x === "string").slice(0, 10);
  const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
  return {
    analyst_sentiment: coerceEnum(sentiment, validSentiments, "neutral"),
    primary_reason_for_move: str(o.primary_reason_for_move),
    sector_context: str(o.sector_context),
    guidance_assessment: coerceEnum(o.guidance_assessment, validGuidance, "not_mentioned"),
    key_risks,
    recovery_likelihood: coerceEnum(o.recovery_likelihood, validRecovery, "medium"),
    summary: str(o.summary),
  };
}

export async function ensurePerplexityData(
  symbol: string,
  earningsDate: string,
): Promise<PerplexityResult> {
  const sym = symbol.toUpperCase();
  const row = await readHistoryRow(sym, earningsDate);
  if (!row) return { captured: false, skipped: true, reason: "row_not_found" };
  if (row.perplexity_pulled_at !== null) {
    return { captured: false, skipped: true, reason: "already_captured" };
  }

  const key = process.env.PERPLEXITY_API_KEY;
  if (!key) return { captured: false, skipped: true, reason: "no_api_key" };

  const prompt = buildEncyclopediaPrompt(sym, row);
  let res: Response;
  try {
    res = await fetch(PERPLEXITY_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "sonar",
        messages: [{ role: "user", content: prompt }],
        temperature: 0,
        max_tokens: 600,
      }),
      cache: "no-store",
    });
  } catch (e) {
    console.warn(
      `[encyclopedia:perplexity] network error ${sym}/${earningsDate}: ${e instanceof Error ? e.message : e}`,
    );
    return { captured: false, skipped: true, reason: "network_error" };
  }
  if (!res.ok) {
    console.warn(
      `[encyclopedia:perplexity] ${sym}/${earningsDate} HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`,
    );
    return { captured: false, skipped: true, reason: `http_${res.status}` };
  }

  let parsed: unknown;
  try {
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = json.choices?.[0]?.message?.content ?? "";
    parsed = extractPerplexityJson(text);
  } catch {
    return { captured: false, skipped: true, reason: "response_parse_failed" };
  }
  const payload = normalizePerplexityPayload(parsed);
  if (!payload) {
    return { captured: false, skipped: true, reason: "payload_invalid" };
  }

  const sb = createServerClient();
  const up = await sb
    .from("earnings_history")
    .update({
      analyst_sentiment: payload.analyst_sentiment,
      // Store the full structured payload as a JSON string so future
      // features can parse out primary_reason / key_risks / etc.
      news_summary: JSON.stringify(payload),
      perplexity_pulled_at: new Date().toISOString(),
    })
    .eq("symbol", sym)
    .eq("earnings_date", earningsDate);
  if (up.error) {
    console.warn(
      `[encyclopedia:perplexity] update(${sym}, ${earningsDate}) failed: ${up.error.message}`,
    );
    return { captured: false, skipped: true, reason: `db_error:${up.error.message}` };
  }
  return { captured: true, sentiment: payload.analyst_sentiment };
}

// ---------- Orchestrator ----------

export type MaintenanceReport = {
  symbolsProcessed: number;
  t0Captured: Array<{ symbol: string; earnings_date: string }>;
  t1Captured: Array<{ symbol: string; earnings_date: string }>;
  expiryBackfilled: Array<{ symbol: string; earnings_date: string }>;
  perplexityBackfilled: Array<{ symbol: string; earnings_date: string }>;
  recommendationsGenerated: Array<{
    symbol: string;
    position_id: string;
    recommendation: string;
    confidence: string;
  }>;
  errors: Array<{ symbol: string; earnings_date: string | null; stage: string; reason: string }>;
};

// Builds the set of symbols relevant to encyclopedia maintenance:
//   - open positions
//   - today's tracked_tickers
//   - every symbol already in the encyclopedia
async function buildRelevantSymbols(): Promise<Set<string>> {
  const sb = createServerClient();
  const result = new Set<string>();
  const [opens, tracked, encs] = await Promise.all([
    sb.from("positions").select("symbol").eq("status", "open"),
    sb.from("tracked_tickers").select("symbol").eq("screened_date", todayIso()),
    sb.from("stock_encyclopedia").select("symbol"),
  ]);
  for (const r of (opens.data ?? []) as Array<{ symbol: string }>) {
    result.add(r.symbol.toUpperCase());
  }
  for (const r of (tracked.data ?? []) as Array<{ symbol: string }>) {
    result.add(r.symbol.toUpperCase());
  }
  for (const r of (encs.data ?? []) as Array<{ symbol: string }>) {
    result.add(r.symbol.toUpperCase());
  }
  return result;
}

const PERPLEXITY_GAP_MS = 1000;
const ENCYCLOPEDIA_STALENESS_DAYS = 7;

export async function runEncyclopediaMaintenance(): Promise<MaintenanceReport> {
  const report: MaintenanceReport = {
    symbolsProcessed: 0,
    t0Captured: [],
    t1Captured: [],
    expiryBackfilled: [],
    perplexityBackfilled: [],
    recommendationsGenerated: [],
    errors: [],
  };

  const relevant = await buildRelevantSymbols();
  report.symbolsProcessed = relevant.size;
  if (relevant.size === 0) return report;

  const sb = createServerClient();
  const todayStr = todayIso();

  // 1. Refresh Phase-1 ingestion for any stale symbols so Perplexity has
  // EPS/revenue context to enrich the prompt. Stale = never pulled or
  // >7d since last pull.
  const encRes = await sb
    .from("stock_encyclopedia")
    .select("symbol,last_historical_pull_date")
    .in("symbol", Array.from(relevant));
  const encMap = new Map(
    ((encRes.data ?? []) as Array<{ symbol: string; last_historical_pull_date: string | null }>).map(
      (r) => [r.symbol, r.last_historical_pull_date],
    ),
  );
  for (const sym of Array.from(relevant)) {
    const lastPull = encMap.get(sym) ?? null;
    const stale =
      !lastPull ||
      (new Date(todayStr + "T00:00:00Z").getTime() -
        new Date(lastPull + "T00:00:00Z").getTime()) /
        86400000 >=
        ENCYCLOPEDIA_STALENESS_DAYS;
    if (stale) {
      try {
        await updateEncyclopedia(sym);
      } catch (e) {
        report.errors.push({
          symbol: sym,
          earnings_date: null,
          stage: "updateEncyclopedia",
          reason: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }

  // 2. T0 pass — fires for today-AMC / tomorrow-BMO announcements in
  // relevant symbols. captureEarningsT0 inserts the stub row if needed.
  let todayAnnouncements: Array<{ symbol: string; date: string }> = [];
  try {
    const list = await getTodayEarnings();
    todayAnnouncements = list.map((e) => ({ symbol: e.symbol.toUpperCase(), date: e.date }));
  } catch (e) {
    report.errors.push({
      symbol: "",
      earnings_date: null,
      stage: "getTodayEarnings",
      reason: e instanceof Error ? e.message : String(e),
    });
  }
  for (const a of todayAnnouncements) {
    if (!relevant.has(a.symbol)) continue;
    try {
      const r = await captureEarningsT0(a.symbol, a.date);
      if (r.captured) report.t0Captured.push({ symbol: a.symbol, earnings_date: a.date });
      else if (
        r.reason &&
        !["already_captured", "schwab_disconnected", "no_options_data", "no_iv_data", "chain_fetch_failed"].includes(
          r.reason,
        )
      ) {
        // Silent skip on the expected after-hours / weekend noise; only
        // real anomalies (db errors, etc.) get logged as errors.
        report.errors.push({
          symbol: a.symbol,
          earnings_date: a.date,
          stage: "T0",
          reason: r.reason,
        });
      }
    } catch (e) {
      report.errors.push({
        symbol: a.symbol,
        earnings_date: a.date,
        stage: "T0",
        reason: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // 3. T1 pass — rows where T0 ran in the last 3 days but T1 hasn't.
  // REST wrapper has no .not() helper, so we fetch the date window +
  // null-iv_after filter and reject missing-implied_move_pct in memory.
  const threeDaysAgo = addDaysIso(todayStr, -3);
  const t1Raw = await sb
    .from("earnings_history")
    .select("symbol,earnings_date,implied_move_pct")
    .in("symbol", Array.from(relevant))
    .gte("earnings_date", threeDaysAgo)
    .lte("earnings_date", todayStr)
    .is("iv_after", null);
  const t1Candidates = ((t1Raw.data ?? []) as Array<{
    symbol: string;
    earnings_date: string;
    implied_move_pct: number | null;
  }>).filter((r) => r.implied_move_pct !== null);
  for (const c of t1Candidates) {
    try {
      const r = await captureEarningsT1(c.symbol, c.earnings_date);
      if (r.captured) report.t1Captured.push(c);
      else if (
        r.reason &&
        !["already_captured", "schwab_disconnected", "no_options_data", "no_iv_data", "chain_fetch_failed"].includes(
          r.reason,
        )
      ) {
        report.errors.push({
          symbol: c.symbol,
          earnings_date: c.earnings_date,
          stage: "T1",
          reason: r.reason,
        });
      }
    } catch (e) {
      report.errors.push({
        symbol: c.symbol,
        earnings_date: c.earnings_date,
        stage: "T1",
        reason: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // 4. Price-at-expiry — every row missing it. ensurePriceAtExpiry
  // internally skips not-yet-expired + quarter-end legacy rows.
  const expiryCandidates = await sb
    .from("earnings_history")
    .select("symbol,earnings_date")
    .in("symbol", Array.from(relevant))
    .is("price_at_expiry", null);
  for (const c of (expiryCandidates.data ?? []) as Array<{ symbol: string; earnings_date: string }>) {
    try {
      const r = await ensurePriceAtExpiry(c.symbol, c.earnings_date);
      if (r.captured) report.expiryBackfilled.push(c);
      else if (
        r.reason &&
        !["already_captured", "not_yet_expired", "quarter_end_legacy_row"].includes(r.reason)
      ) {
        report.errors.push({
          symbol: c.symbol,
          earnings_date: c.earnings_date,
          stage: "expiry",
          reason: r.reason,
        });
      }
    } catch (e) {
      report.errors.push({
        symbol: c.symbol,
        earnings_date: c.earnings_date,
        stage: "expiry",
        reason: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // 5. Perplexity backfill — 1s gap between calls per spec.
  const pplxCandidates = await sb
    .from("earnings_history")
    .select("symbol,earnings_date")
    .in("symbol", Array.from(relevant))
    .is("perplexity_pulled_at", null);
  for (const c of (pplxCandidates.data ?? []) as Array<{ symbol: string; earnings_date: string }>) {
    try {
      const r = await ensurePerplexityData(c.symbol, c.earnings_date);
      if (r.captured) report.perplexityBackfilled.push(c);
      else if (r.reason && r.reason !== "already_captured") {
        report.errors.push({
          symbol: c.symbol,
          earnings_date: c.earnings_date,
          stage: "perplexity",
          reason: r.reason,
        });
      }
    } catch (e) {
      report.errors.push({
        symbol: c.symbol,
        earnings_date: c.earnings_date,
        stage: "perplexity",
        reason: e instanceof Error ? e.message : String(e),
      });
    }
    await sleep(PERPLEXITY_GAP_MS);
  }

  // 5.5. Post-earnings recommendation pass. For each open position
  // whose symbol had an earnings event in the last 48 hours, generate
  // (or refresh) today's recommendation. analyzePositionPostEarnings
  // is idempotent per (position, day) so same-day reruns just overwrite.
  try {
    const { analyzePositionPostEarnings } = await import("@/lib/post-earnings");
    const openRes = await sb
      .from("positions")
      .select("*")
      .eq("status", "open");
    const openPositions = (openRes.data ?? []) as Array<{
      id: string;
      symbol: string;
      strike: number;
      expiry: string;
      broker: string;
      total_contracts: number;
      avg_premium_sold: number | null;
      status: "open" | "closed";
      opened_date: string;
      closed_date: string | null;
      realized_pnl: number | null;
    }>;
    for (const p of openPositions) {
      try {
        const rec = await analyzePositionPostEarnings(p);
        if (rec) {
          report.recommendationsGenerated.push({
            symbol: p.symbol,
            position_id: p.id,
            recommendation: rec.recommendation,
            confidence: rec.confidence,
          });
        }
      } catch (e) {
        report.errors.push({
          symbol: p.symbol,
          earnings_date: null,
          stage: "post-earnings-rec",
          reason: e instanceof Error ? e.message : String(e),
        });
      }
    }
  } catch (e) {
    report.errors.push({
      symbol: "",
      earnings_date: null,
      stage: "post-earnings-rec-pass",
      reason: e instanceof Error ? e.message : String(e),
    });
  }

  // 6. Recompute rollup stats for every touched symbol.
  const touched = new Set<string>();
  for (const x of [
    ...report.t0Captured,
    ...report.t1Captured,
    ...report.expiryBackfilled,
    ...report.perplexityBackfilled,
  ]) {
    touched.add(x.symbol);
  }
  for (const sym of Array.from(touched)) {
    try {
      await recalculateStats(sym);
    } catch (e) {
      report.errors.push({
        symbol: sym,
        earnings_date: null,
        stage: "recalculateStats",
        reason: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return report;
}

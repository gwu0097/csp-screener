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
  getOptionsChainRange,
  isSchwabConnected,
  parseSchwabImpliedVol,
  type SchwabOptionContract,
  type SchwabOptionsChain,
} from "@/lib/schwab";
import { isT1SessionEligible } from "@/lib/session-eligibility";
import { T1_RETRY_CUTOFF_DAYS, recordCaptureAttempt } from "@/lib/earnings-capture-attempts";
import { findNearbyEarningsRow, recordImpliedMoveCapture } from "@/lib/earnings-history-table";
import YahooFinance from "yahoo-finance2";

const FINNHUB_RATE_DELAY_MS = 200;

// Duplicated locally rather than imported from lib/earnings-capture.ts
// (which imports FROM this file) — same established pattern as
// app/api/capture-health/route.ts and lib/expire-positions.ts's own
// local copies. Session-eligibility checks below need Eastern calendar
// "today," not todayIso()'s UTC date — the two disagree for several
// hours a day and a same-session AMC print gets missed exactly then.
function todayEasternIso(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

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
  // SEC EDGAR submissions.fiscalYearEnd (MMDD), reduced to just the
  // month (1-12). Static per company — looked up once, lazily, on
  // first getOrCreateEncyclopediaEntry() for a symbol (see below).
  fiscal_year_end_month: number | null;
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
  // True when T1 measured a different, later-dated contract than T0 did
  // (T0's expiry had already rolled off Schwab's chain by T1 time) --
  // iv_after/iv_crushed/iv_crush_magnitude on a flagged row are a
  // cross-contract comparison, not a clean before/after. price_after/
  // actual_move_pct are unaffected (see migrations/2026-08-12-add-iv-
  // crush-cross-contract.sql). Never delete/null the underlying values --
  // this flag is how callers know to exclude them, not a replacement for
  // having them.
  iv_crush_cross_contract: boolean;
  // True for a phantom too-early T1 capture (see lib/earnings-capture-
  // attempts.ts) — price_after/actual_move_pct predate the real
  // post-earnings settlement. Never delete/null the underlying values,
  // same convention as iv_crush_cross_contract above.
  t1_unrecoverable: boolean;
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

// Cadence guard (PASS_2D) — REMOVED (PASS_2E). Base rate of wrong
// earnings_date values is 27/2438 (1.1%); the guard flagged 11.4% of
// the table at tolerance=12 and 17.7% at tolerance=7 (best-case
// precision ~9%), and at the literal default (12) it missed both
// motivating cases (GD 9-day deviation, XOM 7-day deviation — both
// under the threshold). A false positive here is expensive: it nulls
// price/implied-move data, pulling the row out of
// buildQuarterlyMoveRatio's pool entirely — an 11%+ flag rate would
// have shrunk an already-thin pool (44% of candidates already sit at
// n<=2) for no net detection benefit. The quarter-end guard (still
// active, 8/8 validated, near-deterministic) already handles 23/27 of
// the real bad dates; the remaining single-name drift class (GD/XOM
// style) has no working detector yet — see git history for the prior
// checkCadence implementation if revisiting this.

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

// Lazy, one-time-per-symbol SEC EDGAR lookup for fiscal_year_end_month
// — static per company, so a null value here means "never looked up"
// (or SEC EDGAR had nothing for this symbol), not "known to have no
// fiscal year." Best-effort: a failed lookup leaves it null and the
// next call to getOrCreateEncyclopediaEntry simply retries, same
// pattern as every other best-effort external call in this file.
async function backfillFiscalYearEndMonth(sb: ReturnType<typeof createServerClient>, row: StockEncyclopedia): Promise<StockEncyclopedia> {
  if (row.fiscal_year_end_month !== null) return row;
  try {
    const { getFiscalYearEndMonth } = await import("@/lib/sec-edgar");
    const month = await getFiscalYearEndMonth(row.symbol);
    if (month === null) return row;
    const updated = await sb
      .from("stock_encyclopedia")
      .update({ fiscal_year_end_month: month })
      .eq("id", row.id)
      .select()
      .single();
    if (updated.error || !updated.data) return row;
    return updated.data as StockEncyclopedia;
  } catch (e) {
    console.warn(`[encyclopedia] fiscal_year_end_month lookup failed for ${row.symbol}: ${e instanceof Error ? e.message : e}`);
    return row;
  }
}

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
  if (rows.length > 0) return backfillFiscalYearEndMonth(sb, rows[0]);

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
  return backfillFiscalYearEndMonth(sb, inserted.data as StockEncyclopedia);
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
// Strategy: fetch a ±35-day window of bars. For a confirmed real
// announcement date, the pair is picked DETERMINISTICALLY from timing
// (BMO: prior trading day close -> same day close; AMC: same day close
// -> next trading day close) — no magnitude comparison; see the
// non-quarter-end branch below for why. For a fiscal-quarter-end
// placeholder date (isQuarterEndDate), the real report could land
// anywhere in a 2-6 week lag with no single day to anchor timing
// against, so that path is untouched: still a magnitude-based scan
// across near/report/wide windows.
export async function fetchYahooPriceAction(
  symbol: string,
  earningsDate: string,
  timing: CalendarEntry["hour"] = null,
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

  // The report-window search is only valid for case (b) above — a
  // fiscal quarter-end marker, where the real reaction could land
  // anywhere in the typical 2–6-week reporting lag. isQuarterEndDate
  // is the same, already-established signal the rest of this file
  // uses to distinguish "untrusted date" (dateUntrusted in
  // updateEncyclopedia, the scoping filter in reingestHistoricalDates)
  // from a confirmed real announcement date — so it can decide here
  // too, instead of guessing from gap magnitudes.
  //
  // When earningsDate is NOT a quarter-end date, it's already case
  // (a): a confirmed real announcement date. The reaction is here,
  // full stop — searching weeks out for a bigger unrelated move is
  // exactly the bug that corrupted 8 earnings_history rows (CDNS,
  // GLW, DUOL, COP, MP, GTLB, DOCU, CRH; repaired 2026-08-05): a large
  // unrelated price move weeks later beat a real but modest earnings
  // reaction on gap magnitude alone and got written as if it were the
  // earnings move. Guessing "which window is right" from relative
  // move size doesn't work when the true reaction is genuinely small
  // — exactly the case a magnitude-only heuristic gets most wrong.
  let chosen: ReturnType<typeof biggestGap> = null;
  if (isQuarterEndDate(earningsDate)) {
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
  } else {
    // Confirmed announcement date: pick the pair DETERMINISTICALLY from
    // timing, never by magnitude comparison. nearGap's "biggest move in
    // ±2 calendar days" was still a guess — it silently mispicked
    // BA@2025-01-28, GLW@2025-01-29, and TSEM@2025-02-10 (unrelated
    // volatility in the same window, e.g. the 2025-01-27 DeepSeek
    // selloff, outweighed the real but smaller earnings reaction) and
    // structurally couldn't reach the true pair at all for a Monday BMO
    // report (the prior Friday close sits 3 calendar days back, outside
    // ±2) — that's why SOFI@2025-01-27's window never contained its own
    // prior close (audit: 2026-08-12).
    //
    // Anchored by ARRAY POSITION in the actual trading-day sequence
    // (mirrors fetchYahooPriceActionTimed's own anchor logic exactly —
    // that function's timing rule, inlined here because not every
    // caller of this one has a CalendarEntry to hand), not calendar-day
    // arithmetic — this is what makes the Monday-after-weekend case
    // resolvable: stepping to index-1 always reaches the true prior
    // trading day regardless of how many non-trading days sit between.
    const anchorIdx = normalized.findIndex((b) => b.iso >= earnIso);
    // A real announcement CAN land on a non-trading day (BKR's true
    // 2026-07-26 print was a Sunday, confirmed via its own 8-K —
    // audit: 2026-08-12) — anchorIdx then points to the first trading
    // day AFTER the closure, not a bar matching earnIso itself. On a
    // closed day there's no "before/after the release" distinction to
    // make: the market had the ENTIRE closure to digest it, so the
    // pair is unconditionally the trading day immediately before the
    // closure to the trading day immediately after it, regardless of
    // whatever BMO/AMC label got stored — that label describes when
    // within a trading day the release happened, which doesn't apply
    // when there was no trading that day.
    const earningsDateIsTradingDay = anchorIdx !== -1 && normalized[anchorIdx].iso === earnIso;
    if (anchorIdx === -1) {
      chosen = null;
    } else if (!earningsDateIsTradingDay) {
      if (anchorIdx - 1 >= 0) {
        const prior = normalized[anchorIdx - 1];
        const post = normalized[anchorIdx];
        chosen = { prior: prior.close, post: post.close, move: (post.close - prior.close) / prior.close };
      } else {
        chosen = null;
      }
    } else if (timing === "bmo" && anchorIdx - 1 >= 0) {
      const prior = normalized[anchorIdx - 1];
      const post = normalized[anchorIdx];
      chosen = { prior: prior.close, post: post.close, move: (post.close - prior.close) / prior.close };
    } else if (timing === "amc" && anchorIdx + 1 < normalized.length) {
      const prior = normalized[anchorIdx];
      const post = normalized[anchorIdx + 1];
      chosen = { prior: prior.close, post: post.close, move: (post.close - prior.close) / prior.close };
    } else {
      // timing is null/unknown/dmh, or the needed neighbor bar is
      // missing from the fetched window — no rule to anchor on. A
      // wrong attribution is worse than a gap; return null and let the
      // row stay incomplete rather than guess.
      chosen = null;
    }
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
      "iv_crushed,move_ratio,eps_actual,eps_estimate,breached_two_x_em,recovered_by_expiry,iv_crush_magnitude,iv_crush_cross_contract,t1_unrecoverable,is_complete",
    )
    .eq("symbol", sym)
    .eq("is_complete", true);
  // A transient read error must NOT recompute aggregates from an empty
  // set — that would zero out crush_rate/avg_move_ratio for everyone.
  if (res.error) {
    console.warn(`[encyclopedia] recalculateStats(${sym}) read failed: ${res.error.message}`);
    return null;
  }
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
      | "iv_crush_cross_contract"
      | "t1_unrecoverable"
      | "is_complete"
    >
  >;

  const total = rows.length;
  const avgOf = (vals: number[]): number | null =>
    vals.length === 0 ? null : vals.reduce((s, v) => s + v, 0) / vals.length;

  // Cross-contract rows are excluded from both IV-derived aggregates
  // below (crush_rate, avg_iv_crush_magnitude) — their iv_crushed/
  // iv_crush_magnitude compare T0's contract against a different one
  // T1 measured later, not a clean before/after. move_ratio is
  // price-based (not IV) and unaffected, so avg_move_ratio still uses
  // every row. See migrations/2026-08-12-add-iv-crush-cross-contract.sql.
  const ivTrustworthy = rows.filter((r) => r.iv_crush_cross_contract !== true);

  // t1_unrecoverable rows are phantom too-early captures — price_after
  // (and therefore actual_move_pct, move_ratio, breached_two_x_em,
  // recovered_by_expiry, all derived from it) was taken before the real
  // post-earnings settlement. EPS beat/miss comes from the earnings
  // report itself, not the T1 capture, so beat_rate is unaffected and
  // stays on the full row set (audit: 2026-08-11).
  const priceTrustworthy = rows.filter((r) => r.t1_unrecoverable !== true);

  const crushSamples = ivTrustworthy
    .map((r) => r.iv_crushed)
    .filter((v): v is boolean => v !== null);
  const crush_rate =
    crushSamples.length === 0
      ? null
      : crushSamples.filter((v) => v === true).length / crushSamples.length;

  const moveRatios = priceTrustworthy
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

  const breachSamples = priceTrustworthy.filter((r) => r.breached_two_x_em === true);
  const recovery_rate_after_breach =
    breachSamples.length === 0
      ? null
      : breachSamples.filter((r) => r.recovered_by_expiry === true).length /
        breachSamples.length;

  const ivCrushMagnitudes = ivTrustworthy
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

export function pctChange(actual: number | null, estimate: number | null): number | null {
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
    .select("earnings_date,is_complete,actual_move_pct,implied_move_source,timing,timing_source")
    .eq("symbol", sym);
  const existing = new Map<
    string,
    {
      is_complete: boolean;
      actual_move_pct: number | null;
      implied_move_source: string | null;
      timing: string | null;
      timing_source: string | null;
    }
  >();
  for (const r of (existingRes.data ?? []) as Array<{
    earnings_date: string;
    is_complete: boolean;
    actual_move_pct: number | null;
    implied_move_source: string | null;
    timing: string | null;
    timing_source: string | null;
  }>) {
    existing.set(r.earnings_date, {
      is_complete: r.is_complete,
      actual_move_pct: r.actual_move_pct,
      implied_move_source: r.implied_move_source,
      timing: r.timing,
      timing_source: r.timing_source,
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
    // This upsert's timing source (the Yahoo reportedDate heuristic) is
    // the weakest of the three: 'manual' is human-verified, 'finnhub_hour'
    // comes from Finnhub's real calendar (the T0 capture path). An
    // upsert here must never downgrade a stronger existing source —
    // this loop re-runs on incomplete/implausible rows, and a row can
    // have picked up finnhub_hour from T0 capture before Phase 1 gets
    // back around to it.
    const preserveExistingTiming =
      already?.timing_source === "manual" || already?.timing_source === "finnhub_hour";
    // Hand-entered rows (from the earnings-history table's inline EM/
    // Actual editor) are never touched by the automated feed — that
    // feed is exactly what left the row blank in the first place, and
    // manual values come from a cleaner source (TOS implied-move).
    // Unconditional skip, ahead of the is_complete re-run heuristic
    // below, since a manual row should never be re-fetched for any
    // reason.
    if (already?.implied_move_source === "manual") continue;
    if (already?.is_complete === true) {
      const m = already.actual_move_pct;
      // Earnings reactions under 1% are almost always wrong (computed
      // against the fiscal quarter end before the price-action fix
      // landed). Re-run those rows so the new logic picks up the real
      // announcement reaction.
      if (m !== null && Math.abs(m) >= 0.01) continue;
    }

    // Write-time quarter-end guard (PASS_2D): calMatch failing means
    // earnings_date fell back to r.period, the raw FISCAL QUARTER END —
    // never a real announcement date. Never write move data computed
    // against an untrusted date, even if fetchYahooPriceAction's
    // largest-gap scan happens to find a plausible-looking move; that
    // scan can only be trusted when it's anchored to a date we know is
    // real. Skip the price/implied-move fetch entirely (no point
    // spending the calls) and tag the row low-confidence instead of
    // writing it as trusted. Same principle for a defensive isQuarterEndDate
    // check in case a future calMatch source ever resolves to one directly.
    const dateUntrusted = !calMatch || isQuarterEndDate(earnings_date);
    // Session gate: this loop reads Finnhub's completed /stock/earnings
    // history, which in practice shouldn't surface a same-day,
    // not-yet-reported quarter — Finnhub doesn't publish actual EPS
    // until after the print. But that's an assumption about a
    // third-party API's behavior, not a guarantee this code checks for
    // itself, and an unchecked assumption exactly like it is what let
    // T1 write a same-session AMC phantom (fixed 2026-08-05 — see
    // isT1SessionEligible). Checking costs nothing on the (overwhelming)
    // majority of rows here, which are historical, and closes the
    // loophole if Finnhub ever does surface an in-flight quarter.
    const sessionIneligible =
      !dateUntrusted && !isT1SessionEligible({ earnings_date, timing: hour }, todayEasternIso());
    const skipWrite = dateUntrusted || sessionIneligible;
    const price = skipWrite
      ? { price_before: null, price_after: null, actual_move_pct: null, price_at_expiry: null }
      : hour
        ? await fetchYahooPriceActionTimed(sym, earnings_date, hour)
        : await fetchYahooPriceAction(sym, earnings_date);
    const implied_move_pct = skipWrite ? null : await fetchImpliedMove(sym, earnings_date);
    const breach = skipWrite
      ? { move_ratio: null, two_x_em_strike: null, breached_two_x_em: null, recovered_by_expiry: null }
      : calculateBreachAnalysis({
          price_before: price.price_before,
          price_after: price.price_after,
          price_at_expiry: price.price_at_expiry,
          implied_move_pct,
          actual_move_pct: price.actual_move_pct,
        });

    if (dateUntrusted) {
      console.warn(
        `[encyclopedia] ${sym} ${earnings_date}: no calendar re-map (Yahoo calendar doesn't cover this quarter) — ` +
          `withholding move data, tagging date_confidence=low instead of writing against an unverified quarter-end date.`,
      );
    } else if (sessionIneligible) {
      console.warn(
        `[encyclopedia] ${sym} ${earnings_date}: same-session capture blocked — the print hasn't happened yet ` +
          `this session (timing=${hour ?? "unknown"}). Withholding move data; will retry once eligible.`,
      );
    }

    // A row is "complete" when the core quantitative fields are present;
    // narrative/IV fields are Phase-2 concerns. An untrusted-date or
    // session-ineligible row is never complete — its core fields are
    // deliberately null.
    const is_complete =
      !skipWrite &&
      r.actual !== null &&
      r.estimate !== null &&
      price.price_before !== null &&
      price.price_after !== null;

    const payload = {
      symbol: sym,
      earnings_date,
      // Fiscal identifiers from Finnhub's own /stock/earnings row —
      // r.year/r.quarter are exactly what calMatch was looked up by
      // (calendarByQuarter.get(`${r.year}|${r.quarter}`)), so there's
      // no possibility of disagreement with calMatch's own year/quarter
      // here. Written unconditionally (not gated on dateUntrusted) —
      // these are valid fiscal identifiers independent of whether the
      // resolved earnings_date is trusted; only the move DATA depends
      // on that trust.
      fiscal_quarter: r.quarter,
      fiscal_year: r.year,
      period_end: r.period,
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
      // hour is exactly what fetchYahooPriceActionTimed above used to
      // pick price_before/price_after — persisting it, not just using
      // it in memory, is the actual fix here. Never overwrite a
      // stronger existing source (see preserveExistingTiming above).
      timing: preserveExistingTiming ? already!.timing : hour,
      timing_source: preserveExistingTiming
        ? already!.timing_source
        : hour
          ? "yahoo_timestamp_heuristic"
          : null,
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
      date_confidence: dateUntrusted ? "low" : "confirmed",
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
  // year/quarter: the MATCH key against Finnhub's r.year/r.quarter —
  // falls back through calendarQuarter/date when Yahoo's fiscalQuarter
  // is absent (unchanged, pre-existing behavior; matching robustness
  // is a separate concern from what's safe to persist as "fiscal").
  year: number | null;
  quarter: number | null;
  // fiscalYear/fiscalQuarter: set ONLY from a genuine q.fiscalQuarter
  // string, never the calendarQuarter/date fallback — these are what
  // get written to earnings_history.fiscal_year/fiscal_quarter. A
  // company where Yahoo only supplies calendarQuarter (no
  // fiscalQuarter) correctly yields null here, not a mislabeled
  // calendar-derived value passed off as fiscal.
  fiscalYear: number | null;
  fiscalQuarter: number | null;
  periodEnd: string | null; // YYYY-MM-DD, from periodEndDate
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
      // Separately: the genuinely-fiscal pair, ONLY from q.fiscalQuarter
      // itself (no calendarQuarter/date fallback) — this is what's
      // safe to persist as fiscal_year/fiscal_quarter.
      let fiscalYear: number | null = null;
      let fiscalQuarter: number | null = null;
      if (typeof q.fiscalQuarter === "string") {
        const fm = /^(\d)Q(\d{4})$/.exec(q.fiscalQuarter);
        if (fm) {
          fiscalQuarter = Number(fm[1]);
          fiscalYear = Number(fm[2]);
        }
      }
      const periodEndMs =
        typeof q.periodEndDate === "number"
          ? q.periodEndDate * 1000
          : q.periodEndDate instanceof Date
            ? q.periodEndDate.getTime()
            : typeof q.periodEndDate === "string"
              ? new Date(q.periodEndDate).getTime()
              : NaN;
      const periodEnd = Number.isFinite(periodEndMs)
        ? new Date(periodEndMs).toISOString().slice(0, 10)
        : null;

      entries.push({
        announcementDate,
        hour,
        year,
        quarter,
        fiscalYear,
        fiscalQuarter,
        periodEnd,
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
  // Anchor to the nearest REAL trading day on/after announcementDate,
  // then step by array position — not by addDaysIso(announcementDate,
  // ±1) calendar-day math. That calendar-day version had a real bug:
  // when announcementDate itself falls on a weekend/holiday (confirmed
  // live: BRK-B 2025-08-02, a Saturday), lastOnOrBefore(D-1) and
  // lastOnOrBefore(D) both resolve to the same prior trading day's
  // bar — Friday's close — producing an artificial exact-zero move
  // that has nothing to do with the real reaction. Mirrors the anchor
  // logic in scripts/backfill-earnings-price-paths.ts, which never had
  // this bug for the same reason.
  const anchorIdx = normalized.findIndex((b) => b.iso >= announcementDate);
  let price_before: number | null;
  let price_after: number | null;
  if (anchorIdx === -1) {
    // No bar on or after announcementDate in the fetched window.
    price_before = null;
    price_after = null;
  } else if (hour === "bmo") {
    price_before = anchorIdx - 1 >= 0 ? normalized[anchorIdx - 1].close : null;
    price_after = normalized[anchorIdx].close;
  } else {
    // AMC or unknown — treat as after-close.
    price_before = normalized[anchorIdx].close;
    price_after = anchorIdx + 1 < normalized.length ? normalized[anchorIdx + 1].close : null;
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

  // Yahoo's earnings module only ships ~4 recent quarters, so a
  // quarter-end row older than that window can never be matched to an
  // announcement date — retrying it costs a Yahoo calendar call per
  // symbol on EVERY maintenance sweep, forever. Treat old rows as
  // permanently unmatched and only fetch the calendar when a recent
  // row might actually match.
  const reingestCutoff = addDaysIso(todayIso(), -REINGEST_CALENDAR_WINDOW_DAYS);
  const attemptable: typeof quarterEndRows = [];
  for (const r of quarterEndRows) {
    if (r.earnings_date >= reingestCutoff) attemptable.push(r);
    else
      report.unmatched_rows.push({
        oldDate: r.earnings_date,
        reason: "calendar_window_exceeded",
      });
  }
  if (attemptable.length === 0) return report;

  const calendar = await fetchFinnhubEarningsCalendar(sym);
  if (calendar.length === 0) {
    for (const r of attemptable) {
      report.unmatched_rows.push({
        oldDate: r.earnings_date,
        reason: "calendar_empty",
      });
    }
    return report;
  }

  const sb = createServerClient();
  const existingByDate = new Map(allRows.map((r) => [r.earnings_date, r]));

  for (const row of attemptable) {
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
      // Same precedence as Phase 1: don't let this re-key's Yahoo-
      // heuristic timing clobber a stronger source (manual, or
      // finnhub_hour from the T0-inserted row we're merging into).
      const preserveNewerTiming =
        newerRow.timing_source === "manual" || newerRow.timing_source === "finnhub_hour";
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
        // match.hour is exactly what fetchYahooPriceActionTimed above
        // used to compute price.price_before/price_after.
        timing: preserveNewerTiming ? newerRow.timing : match.hour,
        timing_source: preserveNewerTiming ? newerRow.timing_source : "yahoo_timestamp_heuristic",
        data_source: "finnhub+calendar-rekey",
        // match.fiscalYear/fiscalQuarter/periodEnd are null unless
        // Yahoo's own fiscalQuarter string was present (never the
        // calendarQuarter fallback — see CalendarEntry's doc comment).
        // Included only when non-null — newerRow may already carry
        // fiscal data from a different source (Finnhub ingest, T0
        // capture, or the fiscal backfill), and a null match here must
        // never clobber it.
        ...(match.fiscalQuarter !== null ? { fiscal_quarter: match.fiscalQuarter } : {}),
        ...(match.fiscalYear !== null ? { fiscal_year: match.fiscalYear } : {}),
        ...(match.periodEnd !== null ? { period_end: match.periodEnd } : {}),
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
    const preserveRowTiming =
      row.timing_source === "manual" || row.timing_source === "finnhub_hour";
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
      // match.hour is exactly what fetchYahooPriceActionTimed above
      // used to compute price.price_before/price_after.
      timing: preserveRowTiming ? row.timing : match.hour,
      timing_source: preserveRowTiming ? row.timing_source : "yahoo_timestamp_heuristic",
      data_source: "finnhub+calendar-rekey",
      // Same non-null-only guard as the merge branch above — row may
      // already have fiscal data from another source.
      ...(match.fiscalQuarter !== null ? { fiscal_quarter: match.fiscalQuarter } : {}),
      ...(match.fiscalYear !== null ? { fiscal_year: match.fiscalYear } : {}),
      ...(match.periodEnd !== null ? { period_end: match.periodEnd } : {}),
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

export type HistoryRow = {
  symbol: string;
  earnings_date: string;
  timing: "amc" | "bmo" | "unknown" | null;
  timing_source: string | null;
  date_confidence: "confirmed" | "low" | null;
  price_before: number | null;
  price_after: number | null;
  implied_move_pct: number | null;
  implied_move_source: string | null;
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
  fiscal_quarter: number | null;
  fiscal_year: number | null;
  period_end: string | null;
};

export async function readHistoryRow(
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

// Drift guard (2026-08-11): the calendar-sourced earningsDate passed in
// here can be a day or more off a row a prior write already established
// for this same event (Finnhub calendar drift — same mechanism the
// 2026-08-11 audit traced for RKLB/CMS/MNST/SMCI). readHistoryRow only
// checks the exact date, so a range check first catches the near-miss
// and merges onto the existing row's date instead of stubbing a
// duplicate.
export async function upsertHistoryStub(
  symbol: string,
  earningsDate: string,
  timing: "amc" | "bmo" | "unknown" = "unknown",
): Promise<void> {
  const sb = createServerClient();
  const existing = await readHistoryRow(symbol, earningsDate);
  if (existing) return;
  const nearby = await findNearbyEarningsRow(symbol, earningsDate);
  const writeDate = nearby?.earnings_date ?? earningsDate;
  if (nearby) {
    console.warn(
      `[encyclopedia] upsertHistoryStub ${symbol}: date drift — ` +
        `${earningsDate} requested but an existing row at ${nearby.earnings_date} is within 10 days; ` +
        `merging onto it instead of inserting a duplicate stub.`,
    );
    return;
  }
  await sb
    .from("earnings_history")
    .upsert(
      {
        symbol: symbol.toUpperCase(),
        earnings_date: writeDate,
        data_source: "encyclopedia-live",
        is_complete: false,
        timing,
        // "unknown" isn't a real determination — nothing to attribute.
        timing_source: timing === "unknown" ? null : "finnhub_hour",
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

// Earliest expiry actually LISTED in the chain on/after minIso. Weekly
// symbols resolve to the same-week Friday (what the old
// nextFridayOnOrAfterIso computation assumed); monthly-only symbols
// (e.g. GWRE) resolve to the next listed monthly instead of skipping on
// a nonexistent weekly. Chain keys look like "2026-07-10:4". Both T0
// and T1 apply this same deterministic rule over the same minIso, but
// that does NOT guarantee the same contract — corrected 2026-08-12:
// if T1 runs late enough that the expiry T0 selected has since expired
// and rolled off the chain, this returns a later one instead. Price
// data is unaffected either way; see iv_crush_cross_contract on the
// T1 write path for how that case is flagged.
// Schwab's chains endpoint 400s on weekend fromDate values (see the
// debug-schwab-400 incident scripts). Expiries never land on weekends,
// so rolling Sat/Sun forward to Monday is semantics-preserving.
function nextWeekdayOnOrAfterIso(iso: string): string {
  const d = new Date(iso + "T00:00:00Z");
  const day = d.getUTCDay();
  if (day === 6) d.setUTCDate(d.getUTCDate() + 2);
  else if (day === 0) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function earliestChainExpiryOnOrAfter(
  chain: SchwabOptionsChain,
  minIso: string,
): string | null {
  const keys = [
    ...Object.keys(chain.putExpDateMap ?? {}),
    ...Object.keys(chain.callExpDateMap ?? {}),
  ];
  const dates = keys
    .map((k) => k.slice(0, 10))
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && d >= minIso)
    .sort();
  return dates[0] ?? null;
}

// parseSchwabImpliedVol moved to lib/schwab.ts (2026-08-13) — shared
// across this file's T0/T1 capture, lib/screener.ts's ivPercent(), and
// lib/entry-context.ts's contractIv stamping, so all three reject the
// same -999 sentinel the same way instead of each carrying its own copy
// (or, as ivPercent() did, no rejection at all). See its definition
// there for the full sentinel/bounds rationale.

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
  opts?: { dryRun?: boolean; timing?: "amc" | "bmo" | "unknown" },
): Promise<T0Result> {
  const sym = symbol.toUpperCase();
  const dryRun = opts?.dryRun === true;
  const timing = opts?.timing ?? "unknown";
  if (!dryRun) await upsertHistoryStub(sym, earningsDate, timing);
  const row = await readHistoryRow(sym, earningsDate);
  if (!row && !dryRun) {
    return { captured: false, skipped: true, reason: "row_not_found" };
  }
  // Hand-entered rows (earnings-history table's inline EM/Actual editor)
  // are never touched by the automated capture cron — same rule as
  // FETCH EM HISTORY's seed paths. This is the HIGHER-risk gap of the
  // two: T0 targets the current day's reporters, exactly the quarter a
  // user is most likely to have just hand-entered. iv_before is still
  // null on a manual-only row (the editor never touches it), so the
  // already_captured gate below does NOT catch this case on its own —
  // this check has to come first, not rely on that one.
  if (row && row.implied_move_source === "manual") {
    return { captured: false, skipped: true, reason: "manual_row" };
  }
  // Gate on iv_before, NOT implied_move_pct: the live-EM tracker
  // (lib/earnings-history-table) pre-stamps implied_move_pct on
  // upcoming events days before the print, and gating on it silently
  // blocked IV capture forever. iv_before is the true T0 marker; the
  // T0 straddle re-measures implied_move_pct at the canonical moment
  // (15:45 ET on report day) and overwrites the earlier estimate.
  if (row && row.iv_before !== null) {
    return { captured: false, skipped: true, reason: "already_captured" };
  }

  const connected = await isSchwabConnected()
    .then((r) => r.connected)
    .catch(() => false);
  if (!connected) {
    return { captured: false, skipped: true, reason: "schwab_disconnected" };
  }

  // Earliest LISTED expiry on or after earningsDate+1. Weekly symbols:
  // the same-week Friday. Monthly-only symbols: the next monthly. A
  // 16-day range window covers both without assuming weeklies exist.
  const minExpiryIso = nextWeekdayOnOrAfterIso(addDaysIso(earningsDate, 1));
  // Schwab's chains endpoint 400s ("Invalid Paramter/Value") when
  // fromDate is in the past, even though toDate is still current/future
  // and the endpoint would happily return those listed expiries on
  // their own. minExpiryIso falls behind "today" whenever this capture
  // runs more than a day or two after earningsDate — confirmed live
  // 2026-08-11: identical requests with fromDate clamped to today
  // succeeded for symbols that 400'd with fromDate=minExpiryIso.
  // earliestChainExpiryOnOrAfter() below still floors the *selected*
  // expiry at the true minExpiryIso, so clamping only the request
  // window can't select an earlier contract than intended.
  const fromDateIso = minExpiryIso > todayEasternIso() ? minExpiryIso : todayEasternIso();
  let chain: SchwabOptionsChain;
  try {
    chain = await getOptionsChainRange(sym, fromDateIso, addDaysIso(fromDateIso, 15), "ALL");
  } catch (e) {
    console.warn(
      `[encyclopedia:T0] chain(${sym}, ≥${minExpiryIso}) failed: ${e instanceof Error ? e.message : e}`,
    );
    return { captured: false, skipped: true, reason: "chain_fetch_failed" };
  }
  const expiryIso = earliestChainExpiryOnOrAfter(chain, minExpiryIso);
  if (!expiryIso) {
    return { captured: false, skipped: true, reason: "no_options_data" };
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
  // parseSchwabImpliedVol also rejects the -999 "not computable"
  // sentinel and any other implausible value — see its own comment.
  const callIvRaw = legs.call.volatility;
  const putIvRaw = legs.put.volatility;
  const callIv = parseSchwabImpliedVol(callIvRaw);
  const putIv = parseSchwabImpliedVol(putIvRaw);
  const iv_before =
    callIv !== null && putIv !== null
      ? (callIv + putIv) / 2
      : callIv ?? putIv ?? null;
  if (iv_before === null) {
    // Distinguish "Schwab returned a value but it was rejected as
    // implausible" (a caught sentinel — worth surfacing on its own,
    // since silently lumping it in with ordinary missing data is
    // exactly how a poisoned baseline goes unnoticed) from "Schwab
    // returned nothing at all" (routine, e.g. a contract not yet
    // quoted).
    const sawRejectedValue =
      (Number.isFinite(callIvRaw) && callIv === null) || (Number.isFinite(putIvRaw) && putIv === null);
    return {
      captured: false,
      skipped: true,
      reason: sawRejectedValue ? "invalid_volatility_quote" : "no_iv_data",
    };
  }
  const two_x_em_strike = price_before * (1 - 2 * implied_move_pct);

  if (dryRun) {
    return { captured: true, implied_move_pct, iv_before, price_before, two_x_em_strike };
  }

  // Best-effort fiscal metadata: T0's own data source (Finnhub's live
  // /calendar/earnings, via getTodayEarnings) carries no fiscal
  // quarter/year/period-end fields at all — unlike the historical
  // ingest paths, there's nothing to "un-discard" here. Look it up
  // separately via the Yahoo-backed calendar, matched by date, so a
  // same-day row doesn't have to wait for a later maintenance sweep to
  // pick it up. Skipped if already populated (e.g. a prior sweep beat
  // T0 to this row) or if the lookup finds nothing — never blocks the
  // time-critical IV/price capture above on this being slow or absent.
  let fiscalFields: { fiscal_quarter: number | null; fiscal_year: number | null; period_end: string | null } | null = null;
  if (row?.fiscal_quarter === null || row?.fiscal_quarter === undefined) {
    try {
      const calendar = await fetchFinnhubEarningsCalendar(sym);
      const match = calendar.find((c) => c.announcementDate === earningsDate);
      if (match && (match.fiscalQuarter !== null || match.periodEnd !== null)) {
        fiscalFields = {
          fiscal_quarter: match.fiscalQuarter,
          fiscal_year: match.fiscalYear,
          period_end: match.periodEnd,
        };
      }
    } catch (e) {
      console.warn(`[encyclopedia:T0] fiscal lookup failed for ${sym} ${earningsDate}: ${e instanceof Error ? e.message : e}`);
    }
  }

  const sb = createServerClient();
  const up = await sb
    .from("earnings_history")
    .update({
      price_before,
      implied_move_pct,
      implied_move_source: "schwab_t0",
      iv_before,
      two_x_em_strike,
      // Prefer this call's real calendar-sourced timing; fall back to
      // whatever the row already carried (e.g. a stub seeded by
      // persistLiveImpliedMove, which has no calendar context) rather
      // than clobbering a known value with "unknown".
      timing: timing !== "unknown" ? timing : (row?.timing ?? "unknown"),
      timing_source:
        timing !== "unknown" ? "finnhub_hour" : (row?.timing_source ?? null),
      t0_captured_at: new Date().toISOString(),
      ...(fiscalFields ?? {}),
    })
    .eq("symbol", sym)
    .eq("earnings_date", earningsDate);
  if (up.error) {
    console.warn(`[encyclopedia:T0] update(${sym}, ${earningsDate}) failed: ${up.error.message}`);
    return { captured: false, skipped: true, reason: `db_error:${up.error.message}` };
  }
  // Append to the capture log too — see recordImpliedMoveCapture's
  // comment (lib/earnings-history-table.ts). T0 already self-gates
  // against running twice (the iv_before check above), so this never
  // double-appends for the same row.
  await recordImpliedMoveCapture(sym, earningsDate, implied_move_pct, "schwab_t0", price_before);
  return { captured: true, implied_move_pct, iv_before, price_before, two_x_em_strike };
}

// ---------- T1: post-earnings capture ----------

// Configurable floor for the too-early-capture guard below. Originally
// gated on iv_crush_magnitude<=0 AND |actual_move_pct|<1% — missed all
// 5 same-session AMC phantoms on 2026-08-05 because their IV happened
// to tick down slightly (0.10%-1.44%, ordinary intraday noise between
// two reads minutes apart) rather than sitting flat or rising, so the
// <=0 leg never tripped. A genuine post-print T1 crushes IV by a lot —
// removing event risk from the option's remaining life is what a real
// crush IS, independent of how big the realized move turns out to be
// (real examples: UPS +34.8%, GLW +10.2%). iv_crush_magnitude alone,
// against a floor comfortably below any real observed crush and
// comfortably above same-session noise, is a strictly better signal
// than pairing a magnitude check with a move-size check that a genuine
// quiet quarter can also fail.
export const TOO_EARLY_ACTUAL_FLOOR = 0.05;

export type T1Result =
  | {
      captured: true;
      actual_move_pct: number;
      move_ratio: number;
      iv_crushed: boolean;
      iv_crush_magnitude: number;
      iv_crush_cross_contract: boolean;
      breached_two_x_em: boolean;
    }
  | { captured: false; skipped: true; reason: string };

export async function captureEarningsT1(
  symbol: string,
  earningsDate: string,
  opts?: { dryRun?: boolean },
): Promise<T1Result> {
  const sym = symbol.toUpperCase();
  const row = await readHistoryRow(sym, earningsDate);
  if (!row) return { captured: false, skipped: true, reason: "row_not_found" };
  // Same manual-row protection as T0 above — covers the sequence where
  // T0 ran first (stamping iv_before), the user then hand-edited the
  // row that same day, and T1 would otherwise overwrite it that
  // evening. The existing iv_after/no_t0_data gates below don't check
  // provenance, so this has to run before them.
  if (row.implied_move_source === "manual") {
    return { captured: false, skipped: true, reason: "manual_row" };
  }
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

  // Same deterministic expiry rule as T0 (earliest listed expiry on or
  // after earningsDate+1) so the crush compares the same contract.
  const minExpiryIso = nextWeekdayOnOrAfterIso(addDaysIso(earningsDate, 1));
  // Same fromDate-in-the-past 400 as T0 (see comment there) — T1 hits
  // this far more often in practice: the retry backstop's whole point
  // is capturing rows days after earningsDate, by which point
  // minExpiryIso is routinely in the past. This was the actual cause
  // of "chain_fetch_failed" on every retry for the 9 rows stuck since
  // 2026-08-06 — confirmed live, not a Schwab connectivity or
  // symbol-specific issue (RKLB/HIMS/ASTS/SPG succeeded same morning
  // on the identical connection because their minExpiryIso was still
  // current). Retrying alone could never have fixed this; the request
  // itself was malformed.
  const fromDateIso = minExpiryIso > todayEasternIso() ? minExpiryIso : todayEasternIso();
  let chain: SchwabOptionsChain;
  try {
    chain = await getOptionsChainRange(sym, fromDateIso, addDaysIso(fromDateIso, 15), "ALL");
  } catch (e) {
    console.warn(
      `[encyclopedia:T1] chain(${sym}, ≥${minExpiryIso}) failed: ${e instanceof Error ? e.message : e}`,
    );
    return { captured: false, skipped: true, reason: "chain_fetch_failed" };
  }
  const expiryIso = earliestChainExpiryOnOrAfter(chain, minExpiryIso);
  if (!expiryIso) {
    return { captured: false, skipped: true, reason: "no_options_data" };
  }
  const legs = atmLegs(chain, expiryIso);
  if (!legs) {
    return { captured: false, skipped: true, reason: "no_options_data" };
  }
  const price_after = legs.spot;
  // parseSchwabImpliedVol (lib/schwab.ts) rejects the -999 "not
  // computable" sentinel and any other implausible value.
  const callIvRaw = legs.call.volatility;
  const putIvRaw = legs.put.volatility;
  const callIv = parseSchwabImpliedVol(callIvRaw);
  const putIv = parseSchwabImpliedVol(putIvRaw);
  const iv_after =
    callIv !== null && putIv !== null
      ? (callIv + putIv) / 2
      : callIv ?? putIv ?? null;
  if (iv_after === null) {
    // Same distinction as captureEarningsT0 — a rejected sentinel is
    // worth surfacing on its own, not silently folded into ordinary
    // missing data.
    const sawRejectedValue =
      (Number.isFinite(callIvRaw) && callIv === null) || (Number.isFinite(putIvRaw) && putIv === null);
    return {
      captured: false,
      skipped: true,
      reason: sawRejectedValue ? "invalid_volatility_quote" : "no_iv_data",
    };
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

  // Cross-contract detection (2026-08-12 audit). No stored contract
  // identifier exists for either T0 or T1, and Schwab's chains endpoint
  // 400s on expired-date ranges, so T0's actual selected expiry can't be
  // reconstructed retroactively — this is a proxy, not a direct check.
  // T0 and T1 apply the identical minExpiryIso formula; if T1 completes
  // on or before that date, the chain state can't have moved since T0
  // ran (same listings, same day at worst), so it's virtually certain
  // to be the same contract. Past that date it's uncertain — weeklies
  // for liquid names roll off within days — so this flags conservatively
  // (any T1 after minExpiryIso), matching the audit's explicit
  // direction that a wrong number is worse than a gap. Only iv_after/
  // iv_crushed/iv_crush_magnitude are contaminated by this; price_after/
  // actual_move_pct come from the chain response's underlying quote,
  // which doesn't depend on which expiry was requested.
  const iv_crush_cross_contract = todayEasternIso() > minExpiryIso;

  // Recurrence guard (PASS_2C, revised 2026-08-05): a too-early capture
  // (T1 running before the market has had a chance to react —
  // same-session on an AMC name being the primary case, but this
  // catches any timing miss) shows IV that hasn't really crushed yet.
  // Originally gated on iv_crush_magnitude<=0 AND a small realized
  // move — missed all 5 same-session AMC phantoms on 2026-08-05
  // because their IV ticked down slightly (0.10%-1.44%) rather than
  // sitting flat or rising, so the <=0 leg never tripped even though
  // none of them were real captures. iv_crush_magnitude alone against
  // TOO_EARLY_ACTUAL_FLOOR (comfortably below every real crush this
  // table has ever recorded) is the actual signal; reject and log
  // rather than write a phantom row. The eligibility gates in
  // runT1Capture / runEncyclopediaMaintenance / updateEncyclopedia
  // should already prevent this, but this is a backstop, not a
  // replacement for those fixes. The row stays eligible (iv_after
  // still null) and is retried on the next cron run.
  if (iv_crush_magnitude < TOO_EARLY_ACTUAL_FLOOR) {
    console.warn(
      `[encyclopedia:T1] ${sym} ${earningsDate}: rejected — looks like a too-early capture ` +
        `(iv_crush_magnitude=${iv_crush_magnitude.toFixed(4)} < floor ${TOO_EARLY_ACTUAL_FLOOR}). ` +
        `Not writing — will retry on the next eligible cron run.`,
    );
    return { captured: false, skipped: true, reason: "too_early_capture" };
  }

  if (opts?.dryRun === true) {
    return {
      captured: true,
      actual_move_pct,
      move_ratio,
      iv_crushed,
      iv_crush_magnitude,
      iv_crush_cross_contract,
      breached_two_x_em,
    };
  }

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
      iv_crush_cross_contract,
      breached_two_x_em,
      is_complete: true,
      t1_captured_at: new Date().toISOString(),
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
    iv_crush_cross_contract,
    breached_two_x_em,
  };
}

// ---------- Price at expiry backfill ----------

// Quarter-end dates from Phase 1's /stock/earnings ingestion always land
// on the last day of Mar/Jun/Sep/Dec. Those aren't announcement dates, so
// "next Friday after earnings" computes a wildly wrong expiry. Skip them.
// Exported for direct testing of the write-time guard in updateEncyclopedia.
export function isQuarterEndDate(iso: string): boolean {
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

// Builds the two symbol sets maintenance works from:
//   active   — open positions + today's tracked_tickers. The per-symbol
//              history refresh / re-key (step 1) only runs for these.
//              Running it across the whole encyclopedia table made the
//              sweep scale with table size — at 550 symbols that was a
//              20+ minute crawl of sequential Finnhub/Yahoo calls.
//   relevant — active + every encyclopedia symbol. Used only as a
//              FILTER for the event-driven steps (T0/T1/expiry/
//              Perplexity backfill), which are bounded by actual recent
//              events rather than table size.
export async function buildMaintenanceSymbolSets(): Promise<{
  active: Set<string>;
  relevant: Set<string>;
}> {
  const sb = createServerClient();
  const active = new Set<string>();
  const relevant = new Set<string>();
  const [opens, tracked, encs] = await Promise.all([
    sb.from("positions").select("symbol").eq("status", "open"),
    sb.from("tracked_tickers").select("symbol").eq("screened_date", todayIso()),
    sb.from("stock_encyclopedia").select("symbol"),
  ]);
  for (const r of (opens.data ?? []) as Array<{ symbol: string }>) {
    active.add(r.symbol.toUpperCase());
  }
  for (const r of (tracked.data ?? []) as Array<{ symbol: string }>) {
    active.add(r.symbol.toUpperCase());
  }
  for (const s of Array.from(active)) relevant.add(s);
  for (const r of (encs.data ?? []) as Array<{ symbol: string }>) {
    relevant.add(r.symbol.toUpperCase());
  }
  return { active, relevant };
}

// ---------- T0/T1 candidate selection ----------
//
// Moved here from lib/earnings-capture.ts (2026-08-05) so
// runEncyclopediaMaintenance's T0/T1 passes below can call the SAME
// selection logic runT0Capture/runT1Capture use, instead of each
// maintaining an independent, hand-rolled duplicate. The T1 duplicate
// never got the isT1SessionEligible gate added elsewhere, which is
// exactly what let same-session AMC captures through; the T0 duplicate
// separately dropped Finnhub's real timing on the floor, leaving rows
// (BMO included) tagged timing="unknown". lib/earnings-capture.ts
// re-exports both for its own use and for existing importers.
export type T0Candidate = { symbol: string; earnings_date: string; timing: "amc" | "bmo" | "unknown" };

// Pure selection — no Schwab calls, safe to call from anywhere (including
// a local read-only chain-detail capture) without burning API budget.
export async function selectT0Candidates(): Promise<T0Candidate[]> {
  const todayEt = todayEasternIso();
  const tomorrowEt = addDaysIso(todayEt, 1);
  const byKey = new Map<string, T0Candidate>();

  // Source 1: live earnings calendar ∩ app-known symbols. Carries real
  // AMC/BMO timing straight from Finnhub.
  const [{ relevant }, calendar] = await Promise.all([
    buildMaintenanceSymbolSets(),
    getTodayEarnings().catch(() => []),
  ]);
  for (const e of calendar) {
    const sym = e.symbol.toUpperCase();
    if (!relevant.has(sym)) continue;
    const timing: "amc" | "bmo" | "unknown" = e.timing === "AMC" ? "amc" : e.timing === "BMO" ? "bmo" : "unknown";
    byKey.set(`${sym}|${e.date}`, { symbol: sym, earnings_date: e.date, timing });
  }

  // Source 2: pre-ingested earnings_history rows for the window. No real
  // timing available here — "unknown" is deliberately conservative.
  const sb = createServerClient();
  const pre = await sb
    .from("earnings_history")
    .select("symbol,earnings_date,iv_before")
    .gte("earnings_date", todayEt)
    .lte("earnings_date", tomorrowEt)
    .is("iv_before", null);
  for (const r of (pre.data ?? []) as Array<{ symbol: string; earnings_date: string }>) {
    const sym = r.symbol.toUpperCase();
    const key = `${sym}|${r.earnings_date}`;
    if (byKey.has(key)) continue; // Source 1 already has real timing for this pair
    byKey.set(key, { symbol: sym, earnings_date: r.earnings_date, timing: "unknown" });
  }
  return Array.from(byKey.values());
}

export type T1Candidate = {
  id: string;
  symbol: string;
  earnings_date: string;
  iv_before: number | null;
  implied_move_pct: number | null;
  timing: string | null;
};

// Pure selection — no Schwab calls. Does NOT filter by relevant/active
// symbols — callers that need that scope (runEncyclopediaMaintenance)
// filter the result themselves.
//
// Window widened from a fixed 4 days to T1_RETRY_CUTOFF_DAYS (10) as
// part of the retry backstop (see lib/earnings-capture-attempts.ts) —
// the 4-day window had no retry at all, so one Schwab failure inside it
// (chain_fetch_failed / schwab_disconnected / timeout) orphaned the row
// permanently. t1_unrecoverable=false excludes rows already aged past
// the (now 10-day) cutoff and explicitly marked dead by
// markT1RowsUnrecoverable — a row is either still a candidate or
// explicitly marked unrecoverable, never silently neither.
export async function selectT1Candidates(): Promise<T1Candidate[]> {
  const todayEt = todayEasternIso();
  const sb = createServerClient();
  const raw = await sb
    .from("earnings_history")
    .select("id,symbol,earnings_date,iv_before,implied_move_pct,timing")
    .gte("earnings_date", addDaysIso(todayEt, -T1_RETRY_CUTOFF_DAYS))
    .lte("earnings_date", todayEt)
    .is("iv_after", null)
    .eq("t1_unrecoverable", false);
  if (raw.error) return [];
  return ((raw.data ?? []) as T1Candidate[])
    .filter((r) => r.iv_before !== null && r.implied_move_pct !== null)
    .filter((r) => isT1SessionEligible(r, todayEt));
}

const PERPLEXITY_GAP_MS = 1000;
const ENCYCLOPEDIA_STALENESS_DAYS = 7;
// Quarter-end rows older than this can never be re-keyed (Yahoo only
// ships ~4 recent quarters) — see reingestHistoricalDates.
const REINGEST_CALENDAR_WINDOW_DAYS = 450;
// Perplexity backfill bounds: only rows recent enough for the news
// context to still matter, hard-capped per sweep. The unbounded version
// once walked a ~2,000-row backlog = hours of sequential API calls in
// what is supposed to be a quick background tidy-up.
const PERPLEXITY_BACKFILL_MAX_AGE_DAYS = 120;
const PERPLEXITY_BACKFILL_CAP = 8;
// Hard wall-clock budget for one sweep. Maintenance is best-effort
// upkeep — every Run Analysis fires another sweep, so anything that
// doesn't fit simply defers. Also keeps the post-actions route inside
// Vercel's 60s Hobby ceiling.
const MAINTENANCE_BUDGET_MS = 45_000;

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

  const { active, relevant } = await buildMaintenanceSymbolSets();
  report.symbolsProcessed = active.size;
  if (relevant.size === 0) return report;

  const sb = createServerClient();
  const todayStr = todayIso();
  const startedAt = Date.now();
  const overBudget = (stage: string): boolean => {
    if (Date.now() - startedAt < MAINTENANCE_BUDGET_MS) return false;
    console.warn(
      `[encyclopedia] maintenance budget exhausted at ${stage} after ${Date.now() - startedAt}ms — remaining work defers to the next sweep`,
    );
    return true;
  };

  // 1. Refresh Phase-1 ingestion for stale ACTIVE symbols (open
  // positions + today's tracked) so Perplexity has EPS/revenue context
  // to enrich the prompt. Stale = never pulled or >7d since last pull.
  // Deliberately NOT the whole encyclopedia table — broad refresh is a
  // per-symbol concern (/api/encyclopedia/update), not something every
  // analysis run should crawl 550 symbols for.
  if (active.size > 0) {
    const encRes = await sb
      .from("stock_encyclopedia")
      .select("symbol,last_historical_pull_date")
      .in("symbol", Array.from(active));
    const encMap = new Map(
      ((encRes.data ?? []) as Array<{ symbol: string; last_historical_pull_date: string | null }>).map(
        (r) => [r.symbol, r.last_historical_pull_date],
      ),
    );
    for (const sym of Array.from(active)) {
      if (overBudget("phase1-refresh")) break;
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
      } else {
        // Non-stale symbols still need a Phase 2C sweep to clean up any
        // legacy quarter-end-keyed rows. reingestHistoricalDates bails
        // early on clean symbols and on rows too old for Yahoo's
        // calendar window, so running it here is cheap.
        try {
          await reingestHistoricalDates(sym);
        } catch (e) {
          report.errors.push({
            symbol: sym,
            earnings_date: null,
            stage: "reingestHistoricalDates",
            reason: e instanceof Error ? e.message : String(e),
          });
        }
      }
    }
  }

  // 2. T0 pass — fires for today-AMC / tomorrow-BMO announcements in
  // relevant symbols. captureEarningsT0 inserts the stub row if needed.
  // Calls selectT0Candidates() directly — the same selection
  // runT0Capture uses — instead of a hand-rolled duplicate. That
  // duplicate dropped getTodayEarnings()'s own timing field, leaving
  // rows (BMO included) tagged timing="unknown" and vulnerable to the
  // T1 same-session-AMC bug below once isT1SessionEligible reads it
  // back (fixed 2026-08-05).
  let t0Candidates: T0Candidate[] = [];
  try {
    t0Candidates = (await selectT0Candidates()).filter((c) => relevant.has(c.symbol));
  } catch (e) {
    report.errors.push({
      symbol: "",
      earnings_date: null,
      stage: "selectT0Candidates",
      reason: e instanceof Error ? e.message : String(e),
    });
  }
  for (const a of t0Candidates) {
    if (overBudget("t0-capture")) break;
    try {
      const r = await captureEarningsT0(a.symbol, a.earnings_date, { timing: a.timing });
      await recordCaptureAttempt({
        earningsHistoryId: null,
        symbol: a.symbol,
        earningsDate: a.earnings_date,
        phase: "t0",
        outcome: r.captured ? "captured" : (r.reason ?? "unknown"),
      });
      if (r.captured) report.t0Captured.push({ symbol: a.symbol, earnings_date: a.earnings_date });
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
          earnings_date: a.earnings_date,
          stage: "T0",
          reason: r.reason,
        });
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await recordCaptureAttempt({
        earningsHistoryId: null,
        symbol: a.symbol,
        earningsDate: a.earnings_date,
        phase: "t0",
        outcome: message,
        errorMessage: message,
      }).catch(() => {});
      report.errors.push({
        symbol: a.symbol,
        earnings_date: a.earnings_date,
        stage: "T0",
        reason: message,
      });
    }
  }

  // 3. T1 pass — rows where T0 ran in the last 3 days but T1 hasn't.
  // Calls selectT1Candidates() directly — the single, gated
  // implementation runT1Capture uses (isT1SessionEligible applied
  // inside it) — instead of a hand-rolled duplicate query. That
  // duplicate never had the session gate, which is exactly what let
  // same-session AMC captures through on 2026-08-05 despite the gate
  // existing elsewhere. selectT1Candidates() doesn't scope by
  // relevant/active symbols by design (the cron path doesn't need
  // that scope); filtered here to preserve this sweep's existing
  // "only symbols this app already knows about" intent.
  const t1Candidates = (await selectT1Candidates()).filter((c) => relevant.has(c.symbol));
  for (const c of t1Candidates) {
    if (overBudget("t1-capture")) break;
    try {
      const r = await captureEarningsT1(c.symbol, c.earnings_date);
      await recordCaptureAttempt({
        earningsHistoryId: c.id,
        symbol: c.symbol,
        earningsDate: c.earnings_date,
        phase: "t1",
        outcome: r.captured ? "captured" : (r.reason ?? "unknown"),
      });
      if (r.captured) report.t1Captured.push({ symbol: c.symbol, earnings_date: c.earnings_date });
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
      const message = e instanceof Error ? e.message : String(e);
      await recordCaptureAttempt({
        earningsHistoryId: c.id,
        symbol: c.symbol,
        earningsDate: c.earnings_date,
        phase: "t1",
        outcome: message,
        errorMessage: message,
      }).catch(() => {});
      report.errors.push({
        symbol: c.symbol,
        earnings_date: c.earnings_date,
        stage: "T1",
        reason: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // 4. Price-at-expiry — every row missing it. Quarter-end legacy rows
  // are filtered here in memory (Friday-after a fiscal quarter end is
  // meaningless) — ensurePriceAtExpiry would skip them anyway, but only
  // after a per-row DB read and a warn line repeated every sweep.
  const expiryCandidates = await sb
    .from("earnings_history")
    .select("symbol,earnings_date")
    .in("symbol", Array.from(relevant))
    .is("price_at_expiry", null);
  for (const c of (expiryCandidates.data ?? []) as Array<{ symbol: string; earnings_date: string }>) {
    if (isQuarterEndDate(c.earnings_date)) continue;
    if (overBudget("price-at-expiry")) break;
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

  // 5. Perplexity backfill — 1s gap between calls per spec. The gap is
  // rate-limit protection between actual API calls, so rows that bail
  // before reaching Perplexity (already captured, row gone, no key)
  // must not pay it — with a large backlog of skipped rows the
  // unconditional sleep alone added minutes to the sweep.
  //
  // Bounded: newest rows first (their news context is what the grading
  // UI actually reads), only rows recent enough to still matter, and a
  // hard per-sweep cap. Quarter-end legacy keys are excluded — they're
  // pending re-key and a call against them is wasted on a row that may
  // merge away.
  const PPLX_NO_CALL_REASONS = new Set([
    "row_not_found",
    "already_captured",
    "no_api_key",
  ]);
  const pplxRes = await sb
    .from("earnings_history")
    .select("symbol,earnings_date")
    .in("symbol", Array.from(relevant))
    .is("perplexity_pulled_at", null)
    .gte("earnings_date", addDaysIso(todayStr, -PERPLEXITY_BACKFILL_MAX_AGE_DAYS))
    .order("earnings_date", { ascending: false })
    .limit(PERPLEXITY_BACKFILL_CAP * 3);
  const pplxCandidates = ((pplxRes.data ?? []) as Array<{ symbol: string; earnings_date: string }>)
    .filter((c) => !isQuarterEndDate(c.earnings_date))
    .slice(0, PERPLEXITY_BACKFILL_CAP);
  for (const c of pplxCandidates) {
    if (overBudget("perplexity-backfill")) break;
    let apiCallAttempted = true;
    try {
      const r = await ensurePerplexityData(c.symbol, c.earnings_date);
      apiCallAttempted = r.captured || !PPLX_NO_CALL_REASONS.has(r.reason ?? "");
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
    if (apiCallAttempted) await sleep(PERPLEXITY_GAP_MS);
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
      if (overBudget("post-earnings-rec")) break;
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

  console.log(
    `[encyclopedia] maintenance done in ${Date.now() - startedAt}ms · active=${active.size} ` +
      `t0=${report.t0Captured.length} t1=${report.t1Captured.length} ` +
      `expiry=${report.expiryBackfilled.length} perplexity=${report.perplexityBackfilled.length} ` +
      `recs=${report.recommendationsGenerated.length} errors=${report.errors.length}`,
  );

  return report;
}

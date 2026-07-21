// Two-pass swing setup screener.
//
// Pass 1: Yahoo quote (fast) → technical filter (price/MA/52w-range/R-R)
//         → Yahoo quoteSummary on survivors → analyst + growth + short
//         disqualifiers.
// Pass 2: Finnhub insider transactions + Finnhub earnings calendar +
//         Schwab call options chain (best-effort) → Tier 1 signal filter.
//         Score + rank.
//
// No AI. No Perplexity. Every signal is backed by a verifiable number on
// the candidate object.

import {
  getFinnhubInsiderTransactions,
  getFinnhubNextEarningsDate,
  type FinnhubInsiderTx,
  type NextEarningsAnnouncement,
} from "./earnings";
import {
  getCallOptionsChainRange,
  isSchwabConnected,
  type SchwabOptionContract,
  type SchwabOptionsChain,
} from "./schwab";
import { getResearchSnapshot } from "./yahoo";
import {
  batchRefreshSnapshots,
  type SymbolSnapshot,
} from "./market-snapshot";
import { computeATR } from "./indicators";
import { createServerClient } from "./supabase";
import { getOrFetchDailyBars } from "./daily-bars-cache";
import YahooFinance from "yahoo-finance2";

// Reuse the same yahoo-finance2 instance pattern as lib/yahoo.ts.
const yahooFinance = new (
  YahooFinance as unknown as new () => Record<string, unknown>
)();
try {
  (yahooFinance as unknown as {
    suppressNotices?: (keys: string[]) => void;
  }).suppressNotices?.(["yahooSurvey"]);
} catch {
  /* non-fatal */
}
const MODULE_OPTS = { validateResult: false } as const;
type YFClient = {
  quote: (
    s: string,
    q?: Record<string, unknown>,
    m?: { validateResult?: boolean },
  ) => Promise<unknown>;
};
const yf = yahooFinance as unknown as YFClient;

// ---------- Types ----------

// Keeps the older labels (fda_decision, contract_award, rate_decision,
// analyst_upgrade, restructuring) so historical candidates render
// correctly while the new prompt asks Perplexity for the shorter
// per-spec set (fda, contract, management, macro, squeeze, activist).
export type CatalystType =
  | "product_launch"
  | "fda"
  | "fda_decision"
  | "contract"
  | "contract_award"
  | "rate_decision"
  | "partnership"
  | "regulatory"
  | "management"
  | "macro"
  | "squeeze"
  | "activist"
  | "analyst_upgrade"
  | "restructuring"
  | "other"
  | "none";

// The four setup-type tabs. A candidate can qualify for several
// (confluence) — setupTabs lists every tab it belongs to and
// tabScores carries the per-tab ranking score (0-10).
export type SetupTab = "capitulation" | "pullback" | "insider" | "options_flow";

// Snapshot-derived stats for the technical tabs. Computed in pass 1
// from symbol_market_snapshot (rsi14 + price_history_5d + sma20 +
// return_3m/1y) for symbols that pass the cheap quote-only pre-gate.
export type TabStats = {
  redDayCount: number;
  move5dPct: number; // decimal, e.g. -0.14 = -14% over ~5 trading days
  rsi14: number | null;
  sma20: number | null;
  return3m: number | null; // percent (snapshot.return_3m)
  return1y: number | null; // percent
  // Of the last 5 daily closes, how many sat within 2% of the 50d MA —
  // the closest thing to a "tested support" signal the 5-day window
  // affords. 1 means a single touch (untested); 2+ means the level has
  // actually been revisited, not just brushed once.
  daysNearMA50: number;
};

// ---------- Scoring: named, explainable components ----------
//
// Every tab scorer returns a list of these instead of a bare number.
// The displayed score is the sum of `points` (clamped 0-10) — the same
// list is what the expanded row's breakdown renders and what the
// narrative is built from, so score and explanation cannot diverge.
export type ScoreComponent = {
  key: string;
  label: string;
  // Human-readable value at scoring time, e.g. "+21.4% above the 200d MA".
  value: string;
  // One sentence on the threshold/judgment behind the points.
  detail: string;
  points: number;
  // Ceiling for this component, for a progress-bar-style render. 0 for
  // pure-penalty/adjustment rows that have no positive ceiling.
  maxPoints: number;
  direction: "positive" | "negative" | "neutral";
};

// Sums component points, clamps to the 0-10 range every tab score lives
// in, and — if clamping or rounding changed the total — appends a
// transparent adjustment row so the components displayed always sum to
// exactly the score displayed. No silent divergence between the badge
// and the breakdown.
export function finalizeScore(components: ScoreComponent[]): {
  score: number;
  components: ScoreComponent[];
} {
  const raw = components.reduce((s, c) => s + c.points, 0);
  const score = Math.max(0, Math.min(10, Math.round(raw)));
  const delta = Number((score - raw).toFixed(1));
  if (Math.abs(delta) < 0.05) return { score, components };
  const label = raw < 0 ? "Floored at 0" : raw > 10 ? "Capped at 10" : "Rounding";
  const detail =
    raw < 0
      ? "Scores don't go below 0 — the components above net negative."
      : raw > 10
        ? "Scores cap at 10 even when components add up to more."
        : "Rounded to a whole number for display.";
  return {
    score,
    components: [
      ...components,
      {
        key: "adjust",
        label,
        value: `${raw >= 0 ? "+" : ""}${raw.toFixed(1)} raw total`,
        detail,
        points: delta,
        maxPoints: 0,
        direction: "neutral",
      },
    ],
  };
}

export type InsiderTransaction = {
  name: string;
  // Finnhub free tier doesn't expose officer titles, so we surface the
  // transaction code's human label instead — it tells the user whether
  // an "acquisition" was a real open-market purchase (P) or just an RSU
  // grant (A) / option exercise (M), which is what actually matters for
  // signal quality.
  action: string;
  transactionCode: string;
  shares: number;
  price: number;
  date: string;
  type: "buy" | "sell";
  dollarValue: number;
};

export type SwingCandidate = {
  symbol: string;
  companyName: string;

  // Yahoo data
  currentPrice: number;
  priceChange1d: number;
  ma50: number;
  ma200: number;
  week52Low: number;
  week52High: number;
  analystTarget: number | null;
  numAnalysts: number;
  avgVolume10d: number;
  todayVolume: number;
  marketCap: number;
  shortPercentFloat: number | null;
  revenueGrowth: number | null;

  // Computed
  pctFromHigh: number;
  pctFrom52wLow: number;
  vsMA50: number;
  vsMA200: number;
  volumeRatio: number;
  rr: number | null;
  entryPrice: number;
  targetPrice: number;
  stopPrice: number;

  // Pass 2
  nextEarningsDate: string | null;
  daysToEarnings: number | null;
  insiderTransactions: InsiderTransaction[];
  insiderSignal: "strong_bullish" | "bullish" | "neutral" | "bearish";
  executiveBuys: InsiderTransaction[];
  // Open-market (code P) purchase breakdown — the raw numbers
  // scoreInsiderComponents ranks on, surfaced so the Insider tab's row
  // can show them directly instead of just the derived score.
  insiderBuyDollars: number;
  insiderBuyerCount: number;
  insiderLastBuyDaysAgo: number | null;

  unusualOptionsActivity: boolean;
  callVolumeOiRatio: number | null;
  optionsSignal: "bullish" | "neutral" | "bearish";
  topOptionsStrike: number | null;
  topOptionsExpiry: string | null;

  // Pass 3 — Perplexity catalyst discovery. Earnings are NO LONGER a
  // tier-1 signal (regular quarterly results aren't a catalyst), they're
  // a risk flag only. The catalyst here is something specific and
  // near-term: drug approval, contract award, product launch, etc.
  catalystFound: boolean;
  catalystType: CatalystType;
  catalystDate: string | null;
  catalystDescription: string | null;
  catalystConfidence: "high" | "medium" | "low" | "none";
  // When Perplexity can't find a specific near-term catalyst but
  // insiders are buying anyway, this captures the likely thesis ("why
  // might insiders know something the market doesn't?"). Surfaced in
  // the expanded row when catalystFound === false.
  catalystInsiderAngle: string | null;
  catalystRawResponse: string | null;

  // Display
  tier1Signals: string[];
  tier2Signals: string[];
  redFlags: string[];

  signalCount: number;
  setupScore: number;

  // Setup-type tabs (see SetupTab). Older persisted rows lack these —
  // the client backfills insider/options membership from tier1Signals.
  setupTabs: SetupTab[];
  tabScores: Partial<Record<SetupTab, number>>;
  // The named components each tabScores[tab] is the sum of — this is
  // what the expanded row's breakdown renders, so the number and the
  // explanation come from the same place and cannot diverge.
  tabScoreComponents: Partial<Record<SetupTab, ScoreComponent[]>>;
  // Analyst-style prose built from those same components, one per
  // qualifying tab.
  tabNarrative: Partial<Record<SetupTab, string>>;
  tabStats: TabStats | null;
  // Kept separate (unlike tabStats, which collapses to one of the two)
  // so a confluence candidate shown from either tab gets that tab's own
  // stats, not whichever qualified first.
  capitulationStats: TabStats | null;
  pullbackStats: TabStats | null;

  // 14-day Average True Range — the volatility basis for entry/target/
  // stop (see computeStructuralLevels). Null when Yahoo's daily history
  // didn't return enough bars (e.g. a recent IPO).
  atr14: number | null;
};

// ---------- Pass 1 helpers ----------

export type Pass1Quote = {
  symbol: string;
  companyName: string;
  currentPrice: number;
  priceChange1d: number;
  ma50: number;
  ma200: number;
  week52Low: number;
  week52High: number;
  analystTarget: number | null;
  avgVolume10d: number;
  todayVolume: number;
  marketCap: number;
  // populated by deep summary call on survivors
  numAnalysts: number;
  shortPercentFloat: number | null;
  revenueGrowth: number | null;
};

function pickNumber(obj: Record<string, unknown>, key: string): number | null {
  const v = obj[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function pickString(obj: Record<string, unknown>, key: string): string | null {
  const v = obj[key];
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

function fmtMarketCapValue(n: number): string {
  if (n >= 1e12) return `$${(n / 1e12).toFixed(1)}T`;
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(0)}M`;
  return `$${n.toFixed(0)}`;
}

async function fetchYahooQuote(symbol: string): Promise<Pass1Quote | null> {
  try {
    // Yahoo's regular /quote endpoint omits analyst target +
    // numberOfAnalystOpinions + revenueGrowth + shortPercentOfFloat as of
    // late 2025, so fetch the summary modules in parallel and merge. Both
    // calls hit yahoo's CDN so doing them in parallel is essentially free.
    const [quoteRes, snap] = await Promise.all([
      yf.quote(symbol, {}, MODULE_OPTS).catch((e) => {
        console.warn(
          `[swing-screener] yahoo quote(${symbol}) failed: ${e instanceof Error ? e.message : e}`,
        );
        return null;
      }),
      getResearchSnapshot(symbol).catch(() => null),
    ]);
    if (!quoteRes) return null;
    const r = (Array.isArray(quoteRes) ? quoteRes[0] : quoteRes) as
      | Record<string, unknown>
      | null
      | undefined;
    if (!r) return null;
    const price = pickNumber(r, "regularMarketPrice");
    const ma50 = pickNumber(r, "fiftyDayAverage");
    const ma200 = pickNumber(r, "twoHundredDayAverage");
    const low = pickNumber(r, "fiftyTwoWeekLow");
    const high = pickNumber(r, "fiftyTwoWeekHigh");
    const cap = pickNumber(r, "marketCap");
    const avgVol = pickNumber(r, "averageDailyVolume10Day");
    const todayVol = pickNumber(r, "regularMarketVolume");
    if (
      price === null ||
      ma50 === null ||
      ma200 === null ||
      low === null ||
      high === null ||
      cap === null ||
      avgVol === null ||
      todayVol === null
    ) {
      return null;
    }
    const numAnalysts =
      snap?.numberOfAnalystOpinions !== null && snap?.numberOfAnalystOpinions !== undefined
        ? snap.numberOfAnalystOpinions
        : 0;
    return {
      symbol,
      companyName:
        pickString(r, "shortName") ?? pickString(r, "longName") ?? symbol,
      currentPrice: price,
      priceChange1d: pickNumber(r, "regularMarketChangePercent") ?? 0,
      ma50,
      ma200,
      week52Low: low,
      week52High: high,
      analystTarget: snap?.targetMeanPrice ?? null,
      avgVolume10d: avgVol,
      todayVolume: todayVol,
      marketCap: cap,
      numAnalysts,
      shortPercentFloat: snap?.shortPercentOfFloat ?? null,
      revenueGrowth: snap?.revenueGrowth ?? null,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[swing-screener] yahoo fetch(${symbol}) failed: ${msg}`);
    return null;
  }
}

// Fetched and cached as ONE row per symbol — price is never read
// fresher than the MA/52w-range/analyst-target fields it's judged
// against, or the qualification gates (vsMA50, vsMA200, pctFromHigh)
// go silently incoherent. See migrations/2026-07-20-add-shared-caching-tables.sql.
const QUOTE_CACHE_MAX_AGE_MS = 7 * 60 * 1000; // 5-10 min per the caching audit

type QuoteCacheRow = {
  symbol: string;
  company_name: string | null;
  current_price: number;
  price_change_1d: number;
  ma50: number;
  ma200: number;
  week52_low: number;
  week52_high: number;
  analyst_target: number | null;
  num_analysts: number;
  avg_volume_10d: number;
  today_volume: number;
  market_cap: number;
  short_percent_float: number | null;
  revenue_growth: number | null;
  last_refreshed_at: string;
};

function quoteFromCacheRow(row: QuoteCacheRow): Pass1Quote {
  return {
    symbol: row.symbol,
    companyName: row.company_name ?? row.symbol,
    currentPrice: row.current_price,
    priceChange1d: row.price_change_1d,
    ma50: row.ma50,
    ma200: row.ma200,
    week52Low: row.week52_low,
    week52High: row.week52_high,
    analystTarget: row.analyst_target,
    avgVolume10d: row.avg_volume_10d,
    todayVolume: row.today_volume,
    marketCap: row.market_cap,
    numAnalysts: row.num_analysts,
    shortPercentFloat: row.short_percent_float,
    revenueGrowth: row.revenue_growth,
  };
}

function quoteToCacheRow(q: Pass1Quote): Record<string, unknown> {
  return {
    symbol: q.symbol,
    company_name: q.companyName,
    current_price: q.currentPrice,
    price_change_1d: q.priceChange1d,
    ma50: q.ma50,
    ma200: q.ma200,
    week52_low: q.week52Low,
    week52_high: q.week52High,
    analyst_target: q.analystTarget,
    num_analysts: q.numAnalysts,
    avg_volume_10d: q.avgVolume10d,
    today_volume: q.todayVolume,
    market_cap: q.marketCap,
    short_percent_float: q.shortPercentFloat,
    revenue_growth: q.revenueGrowth,
    last_refreshed_at: new Date().toISOString(),
  };
}

// Bulk cache-check + Yahoo sweep, only for symbols the cache doesn't
// already cover fresh. `forceFresh` skips the read entirely (every
// symbol gets a live fetch) but results are still written back, so a
// force-fresh run leaves the cache warm for the next normal run.
async function batchGetOrFetchQuotes(
  symbols: string[],
  opts: { forceFresh?: boolean } = {},
): Promise<Map<string, Pass1Quote>> {
  const uniq = Array.from(new Set(symbols.map((s) => s.toUpperCase())));
  const quotes = new Map<string, Pass1Quote>();
  let needFetch = uniq;

  if (!opts.forceFresh) {
    try {
      const sb = createServerClient();
      const r = await sb.from("swing_quote_cache").select("*").in("symbol", uniq);
      if (!r.error && r.data) {
        const now = Date.now();
        const seen = new Set<string>();
        const stale: string[] = [];
        for (const row of r.data as QuoteCacheRow[]) {
          seen.add(row.symbol);
          const ageMs = now - new Date(row.last_refreshed_at).getTime();
          if (ageMs < QUOTE_CACHE_MAX_AGE_MS) {
            quotes.set(row.symbol, quoteFromCacheRow(row));
          } else {
            stale.push(row.symbol);
          }
        }
        const missing = uniq.filter((s) => !seen.has(s));
        needFetch = [...stale, ...missing];
      }
    } catch (e) {
      console.warn(
        `[swing-screener] quote-cache batch read failed: ${e instanceof Error ? e.message : e}`,
      );
    }
  }

  // Same batches-of-20/200ms-gap shape pass1Filter always used for the
  // full universe, now only over the cache-miss subset.
  const BATCH = 20;
  const fresh: Pass1Quote[] = [];
  for (let i = 0; i < needFetch.length; i += BATCH) {
    const batch = needFetch.slice(i, i + BATCH);
    const results = await Promise.all(batch.map((s) => fetchYahooQuote(s)));
    for (const q of results) {
      if (q) {
        quotes.set(q.symbol, q);
        fresh.push(q);
      }
    }
    if (i + BATCH < needFetch.length) await sleep(200);
  }

  if (fresh.length > 0) {
    try {
      const sb = createServerClient();
      await sb.from("swing_quote_cache").upsert(fresh.map(quoteToCacheRow), {
        onConflict: "symbol",
      });
    } catch (e) {
      console.warn(
        `[swing-screener] quote-cache batch write failed: ${e instanceof Error ? e.message : e}`,
      );
    }
  }

  return quotes;
}

// Concurrency-limited map. Used everywhere in this file so Yahoo, Finnhub,
// and Schwab don't get hammered (and so a slow symbol doesn't block all).
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let nextIndex = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = nextIndex++;
      if (i >= items.length) return;
      out[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return out;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Geometry: trade levels + R/R for a quote. Returns null if any field is
// non-finite or stop sits at/above entry (degenerate setup).
export type TradeLevels = {
  entryPrice: number;
  targetPrice: number;
  stopPrice: number;
  reward: number;
  risk: number;
  rr: number;
};

// Pass-1-only rough geometry (52w-low based). Used purely as a cheap
// pre-filter before Finnhub/Schwab enrichment (see pass1Filter) — never
// what's shown to the user. Pass 2 replaces it with computeStructuralLevels
// (ATR + real support/resistance) once a symbol has survived to become an
// actual candidate.
function computeTradeLevels(q: Pass1Quote): TradeLevels | null {
  const entryPrice = q.currentPrice;
  const recoveryTarget = q.week52Low + (q.week52High - q.week52Low) * 0.6;
  const targetPrice =
    q.analystTarget !== null
      ? Math.min(q.analystTarget, recoveryTarget)
      : recoveryTarget;
  const stopPrice = q.week52Low * 0.97;
  const reward = targetPrice - entryPrice;
  const risk = entryPrice - stopPrice;
  if (!Number.isFinite(reward) || !Number.isFinite(risk) || risk <= 0) {
    return null;
  }
  const rr = reward / risk;
  return { entryPrice, targetPrice, stopPrice, reward, risk, rr };
}

// Which Tier-2 technical setups are firing on this quote. Used both to
// gate (must have ≥1) and to surface on the candidate for display.
function detectTier2Signals(q: Pass1Quote): string[] {
  const signals: string[] = [];
  const pctFromHigh = (q.currentPrice - q.week52High) / q.week52High;
  const pctFrom52wLow = (q.currentPrice - q.week52Low) / q.week52Low;
  const vsMA50 = (q.currentPrice - q.ma50) / q.ma50;
  const volumeRatio =
    q.avgVolume10d > 0 ? q.todayVolume / q.avgVolume10d : 0;

  if (pctFrom52wLow <= 0.05) signals.push("AT_SUPPORT");
  if (q.currentPrice > q.ma50 && vsMA50 < 0.03 && pctFromHigh < -0.15) {
    signals.push("MA50_RECLAIM");
  }
  if (vsMA50 >= -0.02 && vsMA50 <= 0.02 && pctFromHigh < -0.1) {
    signals.push("PULLBACK_TO_MA");
  }
  if (pctFromHigh < -0.4 && volumeRatio > 1.5 && q.priceChange1d > 0) {
    signals.push("OVERSOLD_BOUNCE");
  }
  return signals;
}

// ---------- Tab qualification (capitulation / pullback) ----------

// Today's date in market time so "today counts intraday" works on a
// UTC server: a snapshot history bar dated today already reflects the
// intraday move; otherwise the live quote change supplies it.
function nyTodayIso(): string {
  return new Date().toLocaleDateString("en-CA", {
    timeZone: "America/New_York",
  });
}

// Builds TabStats for one symbol from its snapshot + live quote.
// Returns null when the snapshot lacks the daily history we need.
export function computeTabStats(
  snap: SymbolSnapshot,
  q: Pass1Quote,
): TabStats | null {
  const bars = snap.price_history_5d ?? [];
  if (bars.length < 4) return null;
  const price = snap.price ?? q.currentPrice;

  // Consecutive red days counted backwards from the latest bar. When
  // the latest bar isn't today's (snapshot refreshed pre-open or the
  // history pull excluded the partial bar), today's live intraday
  // change extends — or breaks — the streak.
  const lastBarIsToday = bars[bars.length - 1]?.date === nyTodayIso();
  let trailingRed = 0;
  for (let i = bars.length - 1; i >= 0; i -= 1) {
    const chg = bars[i].change_pct;
    if (chg !== null && chg < 0) trailingRed += 1;
    else break;
  }
  let redDayCount: number;
  if (lastBarIsToday) {
    redDayCount = trailingRed;
  } else if (q.priceChange1d < 0) {
    redDayCount = trailingRed + 1;
  } else {
    redDayCount = 0; // green today breaks the streak intraday
  }

  // ~5-trading-day cumulative move: live price vs the close BEFORE the
  // oldest bar in the 5-bar window (derived from that bar's change%).
  const first = bars[0];
  const prevClose =
    first.change_pct !== null && first.change_pct > -100
      ? first.close / (1 + first.change_pct / 100)
      : first.close;
  const move5dPct = prevClose > 0 ? price / prevClose - 1 : 0;

  const daysNearMA50 =
    q.ma50 > 0 ? bars.filter((b) => Math.abs(b.close - q.ma50) / q.ma50 <= 0.02).length : 0;

  return {
    redDayCount,
    move5dPct,
    rsi14: snap.rsi14,
    sma20: snap.sma20,
    return3m: snap.return_3m,
    return1y: snap.return_1y,
    daysNearMA50,
  };
}

// TAB 1 — CAPITULATION: 3+ consecutive red days (today counts
// intraday), 5d cumulative worse than -12%, RSI14 < 40. Mirrors the
// manual ThinkorSwim scan (3 red / -15% in 5d) slightly loosened.
// Ceiling: worse than -50% in 5 days is far more likely a binary/
// fundamental event (halt, fraud, guidance blowup) than ordinary
// technical selling a bounce thesis can be built on — excluded rather
// than scored, since no amount of "it's oversold" makes that a swing
// setup.
function qualifiesCapitulation(stats: TabStats): boolean {
  return (
    stats.redDayCount >= 3 &&
    stats.move5dPct <= -0.12 &&
    stats.move5dPct > -0.5 &&
    stats.rsi14 !== null &&
    stats.rsi14 < 40
  );
}

// TAB 2 — PULLBACK TO TREND: uptrend intact (above 200d, positive 3m
// return), price within ~3% of the 50d SMA or sitting between the 20d
// and 50d, and an orderly 5-12% pullback from the recent high. Outer
// ceilings (vs200MA, 3m return) are deliberately generous here — the
// real "extended, not pulled back" judgment happens in the scorer below
// so an extended stock still shows up with an honest low score and
// narrative instead of silently vanishing. These only backstop the
// truly absurd case (triple-digit 3-month runs, 60%+ above the 200d).
export function qualifiesPullback(stats: TabStats, q: Pass1Quote): boolean {
  if (q.currentPrice <= q.ma200) return false;
  const vsMA200 = (q.currentPrice - q.ma200) / q.ma200;
  if (vsMA200 > 0.6) return false;
  if (stats.return3m === null || stats.return3m <= 0 || stats.return3m > 150) return false;
  const vsMA50 = (q.currentPrice - q.ma50) / q.ma50;
  const nearMA50 = Math.abs(vsMA50) <= 0.03;
  const betweenMAs =
    stats.sma20 !== null &&
    q.currentPrice <= stats.sma20 &&
    q.currentPrice >= q.ma50;
  if (!nearMA50 && !betweenMAs) return false;
  const pctFromHigh = (q.currentPrice - q.week52High) / q.week52High;
  return pctFromHigh <= -0.05 && pctFromHigh >= -0.12;
}

// Severity ranking for capitulation: deeper selloff + lower RSI + larger
// cap ranks higher, but each is banded with a ceiling rather than
// scaling forever — beyond a point, "more oversold" stops being a
// stronger bounce signal and starts being evidence something is
// actually broken (see the extreme-move caution below).
function scoreCapitulationComponents(stats: TabStats, q: Pass1Quote): ScoreComponent[] {
  const pct = Math.abs(stats.move5dPct) * 100;
  const depthPts = pct > 35 ? 1 : pct >= 20 ? 4 : pct >= 16 ? 3 : 2;
  const depth: ScoreComponent = {
    key: "depth",
    label: "Selloff depth",
    value: `${(stats.move5dPct * 100).toFixed(1)}% over ~5 trading days`,
    detail:
      pct > 35
        ? "Beyond -35% in a week is more often a fundamental break than technical selling — treated as a caution, not a bigger bounce signal."
        : "Full credit in the -20% to -35% band; tapers below -20% and above -35%.",
    points: depthPts,
    maxPoints: 4,
    direction: depthPts <= 1 ? "negative" : "positive",
  };

  const rsi = stats.rsi14;
  const rsiPts = rsi === null ? 0 : rsi < 15 ? 1 : rsi < 25 ? 3 : 2;
  const rsiComp: ScoreComponent = {
    key: "rsi",
    label: "Oversold reading (RSI14)",
    value: rsi !== null ? rsi.toFixed(0) : "no data",
    detail:
      rsi !== null && rsi < 15
        ? "Under 15 is extreme — as consistent with a broken stock in freefall as a bottom. Verify there's no fundamental reason before treating this as capitulation."
        : "Full credit at RSI 15-25, the classic capitulation reading.",
    points: rsiPts,
    maxPoints: 3,
    direction: rsi !== null && rsi < 15 ? "negative" : rsiPts > 0 ? "positive" : "neutral",
  };

  const cap =
    q.marketCap >= 100e9 ? 2 : q.marketCap >= 10e9 ? 1.5 : q.marketCap >= 2e9 ? 1 : 0;
  const capComp: ScoreComponent = {
    key: "marketcap",
    label: "Market-cap quality",
    value: fmtMarketCapValue(q.marketCap),
    detail:
      cap >= 1.5
        ? "Large/mega-cap — selloffs here are more reliably technical, not existential."
        : "Small/mid-cap — a sharp selloff here is more likely to reflect real deterioration, not just flow.",
    points: cap,
    maxPoints: 2,
    direction: cap > 0 ? "positive" : "neutral",
  };

  const volumeRatio = q.avgVolume10d > 0 ? q.todayVolume / q.avgVolume10d : 0;
  const volPts = volumeRatio > 1.5 ? 1 : 0;
  const volComp: ScoreComponent = {
    key: "volume",
    label: "Volume (seller exhaustion)",
    value: `${volumeRatio.toFixed(1)}x 10-day average`,
    detail: "Elevated volume (>1.5x average) on the selloff is consistent with capitulation/exhaustion rather than quiet drift lower.",
    points: volPts,
    maxPoints: 1,
    direction: volPts > 0 ? "positive" : "neutral",
  };

  return [depth, rsiComp, capComp, volComp];
}

// Trend-quality ranking for pullback. Unlike the old formula, "more
// extended" and "closer to the MA" are NOT monotonically better —
// distance above the 200d and 3-month return are banded with real
// ceilings (an overextended stock that ticked down isn't a pullback to
// support), and MA proximity is graded together with RSI (has momentum
// actually cooled, or did it just tick down while still overbought) and
// how many of the last 5 closes sat near the level (a single touch is
// untested; multiple closes there is real evidence).
export function scorePullbackComponents(stats: TabStats, q: Pass1Quote): ScoreComponent[] {
  const vsMA200 = (q.currentPrice - q.ma200) / q.ma200;
  const trendPts = vsMA200 <= 0.08 ? 2 : vsMA200 <= 0.15 ? 1 : vsMA200 <= 0.2 ? 0 : -2;
  const trendComp: ScoreComponent = {
    key: "trend200",
    label: "Distance above the 200d trend",
    value: `${vsMA200 >= 0 ? "+" : ""}${(vsMA200 * 100).toFixed(1)}% above the 200d MA`,
    detail:
      trendPts < 0
        ? "Above ~20% over the 200d MA reads as an extended stock that ticked down, not a pullback to support — a dip here is reversion risk, not a fresh continuation entry."
        : trendPts === 0
          ? "Fully extended (15-20% over trend) — no credit either way."
          : "Full credit within 0-8% of the 200d MA, a healthy early/mid uptrend.",
    points: trendPts,
    maxPoints: 2,
    direction: trendPts < 0 ? "negative" : trendPts > 0 ? "positive" : "neutral",
  };

  const r3 = stats.return3m ?? 0;
  const trend3mPts = r3 > 50 ? -1 : r3 >= 10 ? 3 : r3 >= 0 ? 1 : 0;
  const trend3mComp: ScoreComponent = {
    key: "trend3m",
    label: "3-month trend strength",
    value: `${r3 >= 0 ? "+" : ""}${r3.toFixed(1)}% over 3 months`,
    detail:
      r3 > 50
        ? "A >50% three-month run is more parabolic than trending — more likely to mean-revert hard than continue smoothly."
        : r3 >= 10
          ? "Strong and sustainable (10-50% over 3 months)."
          : "Positive but modest — a real trend hasn't fully established yet.",
    points: trend3mPts,
    maxPoints: 3,
    direction: trend3mPts < 0 ? "negative" : trend3mPts > 0 ? "positive" : "neutral",
  };

  const vsMA50 = (q.currentPrice - q.ma50) / q.ma50;
  const vsMA50abs = Math.abs(vsMA50);
  const tightPts = vsMA50abs <= 0.01 ? 2 : vsMA50abs <= 0.02 ? 1 : 0;
  const tightComp: ScoreComponent = {
    key: "tightness",
    label: "Pullback tightness to the 50d MA",
    value: `${vsMA50 >= 0 ? "+" : ""}${(vsMA50 * 100).toFixed(1)}% vs 50d MA`,
    detail: "Full credit sitting within 1% of the 50d MA — the level this thesis is testing.",
    points: tightPts,
    maxPoints: 2,
    direction: tightPts > 0 ? "positive" : "neutral",
  };

  const rsi = stats.rsi14;
  const rsiPts = rsi === null ? 0 : rsi >= 35 && rsi <= 55 ? 1 : rsi > 65 ? -1 : 0;
  const rsiComp: ScoreComponent = {
    key: "rsicool",
    label: "Momentum cooldown (RSI14)",
    value: rsi !== null ? rsi.toFixed(0) : "no data",
    detail:
      rsi !== null && rsi > 65
        ? "Still above 65 — momentum hasn't actually cooled. This reads as an extended stock that ticked down, not a real pullback."
        : rsi !== null && rsi >= 35 && rsi <= 55
          ? "Cooled into a healthy pullback range (35-55)."
          : "Neither confirms nor argues against a real cooldown.",
    points: rsiPts,
    maxPoints: 1,
    direction: rsiPts < 0 ? "negative" : rsiPts > 0 ? "positive" : "neutral",
  };

  const testedPts = stats.daysNearMA50 >= 2 ? 1 : 0;
  const testedComp: ScoreComponent = {
    key: "tested",
    label: "Support test quality",
    value:
      stats.daysNearMA50 >= 2
        ? `${stats.daysNearMA50} of the last 5 closes near this level`
        : "First close at this level",
    detail:
      stats.daysNearMA50 >= 2
        ? "Multiple recent closes clustering here is real evidence this level is being tested, not just brushed once."
        : "A single touch is untested support — the level hasn't been proven to hold yet.",
    points: testedPts,
    maxPoints: 1,
    direction: testedPts > 0 ? "positive" : "neutral",
  };

  const pctFromHigh = (q.currentPrice - q.week52High) / q.week52High;
  const depthPts = pctFromHigh <= -0.09 ? 1 : 0;
  const depthComp: ScoreComponent = {
    key: "depth",
    label: "Pullback depth",
    value: `${(pctFromHigh * 100).toFixed(1)}% off the 52-week high`,
    detail:
      depthPts > 0
        ? "A meaningful, orderly dip (9-12% off the high)."
        : "Shallow — barely off the high, limited room for this to have actually reset anything.",
    points: depthPts,
    maxPoints: 1,
    direction: depthPts > 0 ? "positive" : "neutral",
  };

  return [trendComp, trend3mComp, tightComp, rsiComp, testedComp, depthComp];
}

// Pass-1-only fallback for tab candidates that don't clear the legacy R/R
// funnel — like computeTradeLevels above, this is a cheap pre-filter
// geometry, superseded for display by computeStructuralLevels in pass 2.
// Swing-sized stop/target anchored to the live price instead of the
// 52w-low geometry (which is meaningless mid-capitulation).
function fallbackLevels(q: Pass1Quote): TradeLevels {
  const entryPrice = q.currentPrice;
  const stopPrice = entryPrice * 0.92;
  const capTarget = entryPrice * 1.15;
  const targetPrice =
    q.analystTarget !== null && q.analystTarget > entryPrice
      ? Math.min(q.analystTarget, capTarget)
      : entryPrice * 1.12;
  const reward = targetPrice - entryPrice;
  const risk = entryPrice - stopPrice;
  return {
    entryPrice,
    targetPrice,
    stopPrice,
    reward,
    risk,
    rr: risk > 0 ? reward / risk : 0,
  };
}

// Daily bars settle once at EOD — backed by the shared daily_bars_cache
// (lib/daily-bars-cache.ts), which also serves the CSP screener's
// Stage-3 realized-vol fetch. That module already sorts oldest-first,
// filters non-positive prices, and unconditionally falls back to a live
// fetch if the cached row is more than ~30h old, independent of
// forceFresh — a stop computed off multi-day-stale volatility with no
// visible sign anything's wrong is a real risk, not a theoretical one.
async function fetchAtr14(
  symbol: string,
  opts: { forceFresh?: boolean } = {},
): Promise<number | null> {
  try {
    const bars = await getOrFetchDailyBars(symbol, opts);
    return computeATR(bars, 14);
  } catch {
    return null;
  }
}

// Real trade geometry, replacing both computeTradeLevels and
// fallbackLevels above for what's actually displayed to the user (those
// two remain as pass-1's cheap pre-filter — see pass1Filter).
//
// Stop: 1.5x ATR14 below entry (volatility-sized risk), but never
// placed above the structural level the setup is actually defending —
// the 50d MA for anything trading above it (pullback/insider/options
// theses all rest on the 50d holding), or the 52-week low for anything
// still below its 50d (capitulation). We take the wider (lower) of the
// two so the stop sits below both "normal chop" and the level being
// tested, then clamp to a 3-15% risk band so a near-zero-ATR name
// doesn't produce a stop basically at entry and a wild name doesn't
// blow past a sane swing-trade risk budget.
//
// Target: the nearer of analyst consensus and real overhead structure
// (52-week high, or a 3x-ATR projection when price is already above its
// 52w high) — never a fixed percentage. A close target is a more
// realistic multi-week swing objective than a distant one.
function computeStructuralLevels(
  q: Pass1Quote,
  atr14: number | null,
): TradeLevels | null {
  const entryPrice = q.currentPrice;
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) return null;

  const atrStop = atr14 !== null && atr14 > 0 ? entryPrice - 1.5 * atr14 : Infinity;
  const structuralFloor =
    entryPrice > q.ma50 ? q.ma50 * 0.985 : q.week52Low * 0.97;
  let stopPrice = Math.min(atrStop, structuralFloor);
  stopPrice = Math.min(stopPrice, entryPrice * 0.97); // floor: at least 3% risk
  stopPrice = Math.max(stopPrice, entryPrice * 0.85); // ceiling: at most 15% risk

  const atrProjection = atr14 !== null && atr14 > 0 ? entryPrice + 3 * atr14 : null;
  const structuralResistance =
    q.week52High > entryPrice ? q.week52High : atrProjection;
  const targetCandidates = [q.analystTarget, structuralResistance].filter(
    (v): v is number => v !== null && Number.isFinite(v) && v > entryPrice,
  );
  const targetPrice =
    targetCandidates.length > 0
      ? Math.min(...targetCandidates)
      : (atrProjection ?? entryPrice * 1.1);

  const reward = targetPrice - entryPrice;
  const risk = entryPrice - stopPrice;
  if (!Number.isFinite(reward) || !Number.isFinite(risk) || risk <= 0) {
    return null;
  }
  return { entryPrice, targetPrice, stopPrice, reward, risk, rr: reward / risk };
}

// Cheap quote-only pre-gates so we only refresh snapshots (3 Yahoo
// calls each) for plausible tab candidates, capped to protect the 60s
// route budget. A stock down 12%+ in 5 days is necessarily below its
// 50d MA and 10%+ off its high, so the capitulation pre-gate can't
// false-negative; the pullback pre-gate brackets the final bands.
const MAX_SNAPSHOT_ENRICH = 80;

function pregateTabSymbols(quotes: Map<string, Pass1Quote>): string[] {
  const capitulation: Pass1Quote[] = [];
  const pullback: Pass1Quote[] = [];
  for (const q of Array.from(quotes.values())) {
    if (q.currentPrice < 10 || q.marketCap < 500_000_000) continue;
    const vsMA50 = (q.currentPrice - q.ma50) / q.ma50;
    const pctFromHigh = (q.currentPrice - q.week52High) / q.week52High;
    if (
      q.priceChange1d < 0 &&
      q.currentPrice < q.ma50 &&
      pctFromHigh <= -0.1
    ) {
      capitulation.push(q);
    }
    if (
      q.currentPrice > q.ma200 &&
      vsMA50 >= -0.04 &&
      vsMA50 <= 0.08 &&
      pctFromHigh <= -0.04 &&
      pctFromHigh >= -0.13
    ) {
      pullback.push(q);
    }
  }
  // Worst 1-day movers first (capitulation), tightest to the 50d first
  // (pullback) — if the cap bites, we keep the best candidates.
  capitulation.sort((a, b) => a.priceChange1d - b.priceChange1d);
  pullback.sort(
    (a, b) =>
      Math.abs((a.currentPrice - a.ma50) / a.ma50) -
      Math.abs((b.currentPrice - b.ma50) / b.ma50),
  );
  const seen = new Set<string>();
  const out: string[] = [];
  const interleaved = [];
  const maxLen = Math.max(capitulation.length, pullback.length);
  for (let i = 0; i < maxLen; i += 1) {
    if (capitulation[i]) interleaved.push(capitulation[i].symbol);
    if (pullback[i]) interleaved.push(pullback[i].symbol);
  }
  for (const sym of interleaved) {
    if (seen.has(sym)) continue;
    seen.add(sym);
    out.push(sym);
    if (out.length >= MAX_SNAPSHOT_ENRICH) break;
  }
  return out;
}

// ---------- Pass 1 ----------

export async function pass1Filter(
  symbols: string[],
  opts: { forceFresh?: boolean } = {},
): Promise<{
  survivors: string[];
  quotes: Map<string, Pass1Quote>;
  trades: Map<string, TradeLevels>;
  tier2ByCandidate: Map<string, string[]>;
  errors: string[];
  capitulation: Record<string, TabStats>;
  pullback: Record<string, TabStats>;
}> {
  const routeStarted = Date.now();
  const errors: string[] = [];

  // Step 1: cache-check + Yahoo quote sweep for cache misses only (see
  // batchGetOrFetchQuotes) — a normal same-day rerun mostly reads
  // swing_quote_cache instead of refetching all ~520 symbols.
  const quotes = await batchGetOrFetchQuotes(symbols, { forceFresh: opts.forceFresh });
  for (const s of symbols) {
    if (!quotes.has(s.toUpperCase())) errors.push(`yahoo-quote:${s}`);
  }

  // Step 2: instant disqualifiers + technical setup + R/R on quote-only data.
  const techSurvivors: Pass1Quote[] = [];
  const trades = new Map<string, TradeLevels>();
  const tier2ByCandidate = new Map<string, string[]>();
  for (const q of Array.from(quotes.values())) {
    if (q.currentPrice < 10) continue;
    if (q.marketCap < 500_000_000) continue;
    if (q.analystTarget === null) continue;
    const tier2 = detectTier2Signals(q);
    if (tier2.length === 0) continue;
    const tl = computeTradeLevels(q);
    if (!tl) continue;
    if (tl.reward <= 0) continue;
    if (tl.rr < 2.0) continue;
    if (tl.entryPrice >= tl.targetPrice * 0.85) continue;
    techSurvivors.push(q);
    trades.set(q.symbol, tl);
    tier2ByCandidate.set(q.symbol, tier2);
  }

  // Step 3: apply analyst-count, revenue-growth, short-float disqualifiers.
  // Missing fields are treated leniently — Yahoo simply doesn't return some
  // fundamentals on every symbol, and we'd rather not throw out a valid
  // setup over a Yahoo coverage gap.
  const funnelSurvivors: string[] = [];
  for (const q of techSurvivors) {
    if (q.numAnalysts < 3) continue;
    if (q.revenueGrowth !== null && q.revenueGrowth < -0.2) continue;
    if (q.shortPercentFloat !== null && q.shortPercentFloat > 0.4) continue;
    funnelSurvivors.push(q.symbol);
  }

  // Step 4: capitulation / pullback tab qualification. Quote-only
  // pre-gate first, then snapshots (rsi14 + 5d history + sma20 + 3m/1y
  // returns) only for that pre-gated subset — symbol_market_snapshot
  // has a 15-min TTL so repeat runs are mostly cache reads.
  const capitulation: Record<string, TabStats> = {};
  const pullback: Record<string, TabStats> = {};
  const pregated = pregateTabSymbols(quotes);
  if (pregated.length > 0) {
    // Chunked with a route-level deadline: the quote sweep above has
    // already spent 15-30s of the 60s ceiling, so snapshot refreshes
    // stop launching once the route has been running ~45s. Cached-
    // fresh snapshots (15-min TTL) return instantly, so a warm run
    // always covers the full pregated set.
    const SNAPSHOT_DEADLINE_MS = 45_000;
    const CHUNK = 10;
    const snaps: SymbolSnapshot[] = [];
    for (let i = 0; i < pregated.length; i += CHUNK) {
      if (Date.now() - routeStarted > SNAPSHOT_DEADLINE_MS) {
        errors.push(
          `snapshots:deadline (${pregated.length - i} of ${pregated.length} pregated symbols skipped)`,
        );
        break;
      }
      try {
        snaps.push(
          ...(await batchRefreshSnapshots(pregated.slice(i, i + CHUNK), 15)),
        );
      } catch (e) {
        errors.push(
          `snapshots:${e instanceof Error ? e.message : "batch failed"}`,
        );
        break;
      }
    }
    for (const snap of snaps) {
      const q = quotes.get(snap.symbol.toUpperCase());
      if (!q) continue;
      const stats = computeTabStats(snap, q);
      if (!stats) continue;
      if (qualifiesCapitulation(stats)) capitulation[q.symbol] = stats;
      if (qualifiesPullback(stats, q)) pullback[q.symbol] = stats;
    }
  }
  console.log(
    `[swing-screener] pass1 tabs: pregated=${pregated.length} ` +
      `capitulation=${Object.keys(capitulation).length} ` +
      `pullback=${Object.keys(pullback).length} funnel=${funnelSurvivors.length}`,
  );

  // Survivors = union of the legacy funnel (insider/options path) and
  // the tab-qualified symbols, so pass 2 enriches (and earnings-gates)
  // everything. Tab symbols that didn't clear the legacy R/R funnel
  // get swing-sized fallback levels.
  const survivorSet = new Set<string>(funnelSurvivors);
  for (const sym of [
    ...Object.keys(capitulation),
    ...Object.keys(pullback),
  ]) {
    survivorSet.add(sym);
    if (!trades.has(sym)) {
      const q = quotes.get(sym);
      if (q) trades.set(sym, fallbackLevels(q));
    }
    if (!tier2ByCandidate.has(sym)) tier2ByCandidate.set(sym, []);
  }
  const survivors = Array.from(survivorSet);

  return {
    survivors,
    quotes,
    trades,
    tier2ByCandidate,
    errors,
    capitulation,
    pullback,
  };
}

// ---------- Pass 2 helpers ----------

// SEC Form-4 transaction codes. Only the ones we actually surface — anything
// else falls back to the raw code so the user knows we saw it.
const TRANSACTION_CODE_LABELS: Record<string, string> = {
  P: "Purchase",
  S: "Sale",
  A: "Grant",
  M: "Option Exercise",
  F: "Tax Withhold",
  G: "Gift",
  D: "Disposition",
  X: "Option Expire",
  C: "Conversion",
};

function transactionLabel(code: string): string {
  if (!code) return "—";
  return TRANSACTION_CODE_LABELS[code] ?? code;
}

function classifyInsiderTxs(rows: FinnhubInsiderTx[]): {
  transactions: InsiderTransaction[];
  executiveBuys: InsiderTransaction[];
  signal: "strong_bullish" | "bullish" | "neutral" | "bearish";
} {
  // Direction comes from `change` (signed delta), not `share` (total post-tx
  // holdings — always positive). `Math.abs(change)` is the actual transaction
  // size in shares.
  const transactions: InsiderTransaction[] = rows.map((r) => {
    const shares = Math.abs(r.change);
    const price = r.transactionPrice;
    const code = r.transactionCode ?? "";
    return {
      name: r.name ?? "",
      action: transactionLabel(code),
      transactionCode: code,
      shares,
      price,
      date: r.transactionDate ?? r.filingDate ?? "",
      type: r.change > 0 ? "buy" : "sell",
      dollarValue: shares * price,
    };
  });
  // Real conviction signal = open-market PURCHASE (code P) where the insider
  // spent personal money. Without a title field we can't filter to C-suite,
  // but a $100K+ market purchase is itself the conviction proxy regardless of
  // role — RSU grants (A) and option exercises (M) don't count.
  const executiveBuys = transactions.filter(
    (t) => t.transactionCode === "P" && t.dollarValue > 100_000,
  );
  // Sums use only real open-market buys/sells (P/S). Grants and exercises
  // would otherwise drown out the conviction signal.
  let buyShares = 0;
  let sellShares = 0;
  let buyDollars = 0;
  for (const t of transactions) {
    if (t.transactionCode === "P") {
      buyShares += t.shares;
      buyDollars += t.dollarValue;
    } else if (t.transactionCode === "S") {
      sellShares += t.shares;
    }
  }
  let signal: "strong_bullish" | "bullish" | "neutral" | "bearish" = "neutral";
  if (executiveBuys.length > 0) signal = "strong_bullish";
  else if (buyShares > sellShares && buyDollars > 50_000) signal = "bullish";
  else if (sellShares > buyShares * 2 && sellShares > 0) signal = "bearish";
  return { transactions, executiveBuys, signal };
}

type OptionsAnalysis = {
  unusualOptionsActivity: boolean;
  callVolumeOiRatio: number | null;
  topOptionsStrike: number | null;
  topOptionsExpiry: string | null;
  signal: "bullish" | "neutral" | "bearish";
};

function analyzeCallChain(
  chain: SchwabOptionsChain | null,
  currentPrice: number,
): OptionsAnalysis {
  if (!chain || !chain.callExpDateMap) {
    return {
      unusualOptionsActivity: false,
      callVolumeOiRatio: null,
      topOptionsStrike: null,
      topOptionsExpiry: null,
      signal: "neutral",
    };
  }
  let bestStrike: number | null = null;
  let bestExpiry: string | null = null;
  let bestVolume = 0;
  let bestOi = 0;
  let totalCallVolume = 0;
  for (const [expDateKey, expEntry] of Object.entries(chain.callExpDateMap)) {
    for (const strikeStr of Object.keys(expEntry)) {
      const contracts = expEntry[strikeStr];
      const strike = Number(strikeStr);
      const c: SchwabOptionContract | undefined = contracts[0];
      if (!c) continue;
      const vol = c.totalVolume ?? 0;
      const oi = c.openInterest ?? 0;
      totalCallVolume += vol;
      if (vol > bestVolume) {
        bestVolume = vol;
        bestOi = oi;
        bestStrike = strike;
        // Schwab's expDateKey looks like "2026-06-20:55" — strip the trailing
        // `:N` (days-to-expiration) so the UI can render a clean date.
        bestExpiry = c.expirationDate ?? expDateKey.split(":")[0] ?? null;
      }
    }
  }
  const ratio = bestOi > 0 ? bestVolume / bestOi : null;
  const isOTM = bestStrike !== null && bestStrike > currentPrice;
  const unusual = ratio !== null && ratio > 0.5 && isOTM && totalCallVolume > 0;
  return {
    unusualOptionsActivity: unusual,
    callVolumeOiRatio: ratio,
    topOptionsStrike: bestStrike,
    topOptionsExpiry: bestExpiry,
    signal: unusual ? "bullish" : "neutral",
  };
}

function isoDaysAhead(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysFromTodayUtc(dateIso: string): number | null {
  const [y, m, d] = dateIso.split("-").map(Number);
  if (!y || !m || !d) return null;
  const today = new Date();
  const a = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const b = Date.UTC(y, m - 1, d);
  return Math.round((b - a) / (24 * 60 * 60 * 1000));
}

// Raw open-market (code P) purchase numbers scoreInsiderComponents ranks
// on — split out so the Insider tab's row can display the actual $,
// buyer count, and recency instead of just the derived score.
export function insiderPurchaseBreakdown(transactions: InsiderTransaction[]): {
  dollars: number;
  distinctBuyers: number;
  newestBuyDaysAgo: number | null;
} {
  const buys = transactions.filter((t) => t.transactionCode === "P");
  const dollars = buys.reduce((s, t) => s + t.dollarValue, 0);
  const distinctBuyers = new Set(buys.map((t) => t.name)).size;
  let newestBuyDaysAgo: number | null = null;
  for (const t of buys) {
    const d = t.date ? daysFromTodayUtc(t.date) : null;
    if (d === null) continue;
    const age = -d; // past dates are negative days-ahead
    if (newestBuyDaysAgo === null || age < newestBuyDaysAgo) newestBuyDaysAgo = age;
  }
  return { dollars, distinctBuyers, newestBuyDaysAgo };
}

// Insider conviction: open-market purchase dollars + number of distinct
// buyers + recency of the latest buy. Each dimension is already
// tier-capped (a $50M buy scores the same as a $1M buy) so there's no
// "more is infinitely better" issue here to fix — restructured into
// named components for the same reason every other tab is.
function scoreInsiderComponents(transactions: InsiderTransaction[]): ScoreComponent[] {
  const { dollars, distinctBuyers, newestBuyDaysAgo } =
    insiderPurchaseBreakdown(transactions);

  const sizePts = dollars >= 1_000_000 ? 4 : dollars >= 250_000 ? 3 : dollars >= 100_000 ? 2 : 1;
  const sizeComp: ScoreComponent = {
    key: "size",
    label: "Purchase size",
    value: fmtMarketCapValue(dollars),
    detail: "Open-market (Form 4 code P) purchase dollars — full credit at $1M+.",
    points: sizePts,
    maxPoints: 4,
    direction: "positive",
  };

  const breadthPts = distinctBuyers >= 3 ? 3 : distinctBuyers === 2 ? 2 : 1;
  const breadthComp: ScoreComponent = {
    key: "breadth",
    label: "Buyer breadth",
    value: `${distinctBuyers} distinct buyer${distinctBuyers === 1 ? "" : "s"}`,
    detail:
      distinctBuyers >= 3
        ? "3+ insiders buying is broad conviction, not one actor's bet."
        : "A single buyer is a real signal but a narrower one.",
    points: breadthPts,
    maxPoints: 3,
    direction: "positive",
  };

  const recencyPts =
    newestBuyDaysAgo !== null && newestBuyDaysAgo <= 7
      ? 3
      : newestBuyDaysAgo !== null && newestBuyDaysAgo <= 14
        ? 2
        : newestBuyDaysAgo !== null && newestBuyDaysAgo <= 30
          ? 1
          : 0;
  const recencyComp: ScoreComponent = {
    key: "recency",
    label: "Recency",
    value: newestBuyDaysAgo !== null ? `${newestBuyDaysAgo}d ago` : "no dated purchase",
    detail:
      recencyPts >= 3
        ? "Within the last week — a fresh signal, not stale news."
        : recencyPts === 0
          ? "Over 30 days old — the market has had time to digest this."
          : "Within the last month.",
    points: recencyPts,
    maxPoints: 3,
    direction: recencyPts > 0 ? "positive" : "neutral",
  };

  return [sizeComp, breadthComp, recencyComp];
}

// Options-flow aggressiveness: vol/OI ratio of the hottest call strike +
// how far OTM the money is positioned + total-flow context. Deep-OTM
// positioning with almost no time left to expiry is the one place
// "more aggressive" stops being a stronger signal — that combination
// reads as a lottery ticket, not informed positioning, so it's flagged
// as a caution rather than credited.
function scoreOptionsFlowComponents(
  opts: OptionsAnalysis,
  q: Pass1Quote,
): ScoreComponent[] {
  const ratio = opts.callVolumeOiRatio ?? 0;
  const ratioPts = ratio >= 3 ? 5 : ratio >= 2 ? 4 : ratio >= 1 ? 3 : ratio >= 0.5 ? 2 : 1;
  const ratioComp: ScoreComponent = {
    key: "ratio",
    label: "Flow aggressiveness (Vol/OI)",
    value: `${ratio.toFixed(2)}x on the hottest strike`,
    detail: "Volume relative to existing open interest — full credit at 3x+.",
    points: ratioPts,
    maxPoints: 5,
    direction: "positive",
  };

  const strike = opts.topOptionsStrike;
  const isDeepOtm = strike !== null && strike > q.currentPrice * 1.05;
  const skewPts = isDeepOtm ? 2 : strike !== null && strike > q.currentPrice ? 1 : 0;

  const daysToExpiry = opts.topOptionsExpiry ? daysFromTodayUtc(opts.topOptionsExpiry) : null;
  const lotteryRisk = isDeepOtm && daysToExpiry !== null && daysToExpiry <= 7;
  const skewComp: ScoreComponent = {
    key: "skew",
    label: "Strike positioning",
    value: strike !== null ? `$${strike} strike, ${daysToExpiry ?? "?"}d to expiry` : "no strike data",
    detail: lotteryRisk
      ? "Deep OTM with under a week to expiry reads more like a lottery ticket than a directional position — the aggressiveness that would normally score well is discounted here."
      : isDeepOtm
        ? "5%+ OTM — betting on a real move, not just drift."
        : "At or modestly above the money.",
    points: lotteryRisk ? Math.max(0, skewPts - 2) : skewPts,
    maxPoints: 2,
    direction: lotteryRisk ? "negative" : skewPts > 0 ? "positive" : "neutral",
  };

  const volumeRatio = q.avgVolume10d > 0 ? q.todayVolume / q.avgVolume10d : 0;
  const volPts = volumeRatio > 1.5 ? 1 : 0;
  const volComp: ScoreComponent = {
    key: "volume",
    label: "Underlying volume",
    value: `${volumeRatio.toFixed(1)}x 10-day average`,
    detail: "Elevated share volume alongside the options activity corroborates the flow.",
    points: volPts,
    maxPoints: 1,
    direction: volPts > 0 ? "positive" : "neutral",
  };

  return [ratioComp, skewComp, volComp];
}

// Insider tab technical sanity gate: insider buying in a collapsing
// stock is averaging-down, not a swing setup.
const INSIDER_FREEFALL_VS_MA200 = -0.25;

// ---------- Narrative: the components rendered as prose ----------
//
// One structure for score and explanation: every clause below is pulled
// directly from the same ScoreComponent list the badge and breakdown
// render, plus context already sitting on the candidate (catalyst,
// confluence, red flags, trade geometry) — no new data, no separate
// hand-written summary that can drift from what actually scored.

const TAB_THESIS_LABEL: Record<SetupTab, string> = {
  capitulation: "capitulation bounce",
  pullback: "pullback-to-trend",
  insider: "insider-conviction",
  options_flow: "options-flow",
};

function pctStr(n: number, digits = 1): string {
  return `${n >= 0 ? "+" : ""}${(n * 100).toFixed(digits)}%`;
}

export type NarrativeInput = {
  symbol: string;
  tab: SetupTab;
  score: number;
  components: ScoreComponent[];
  setupTabs: SetupTab[];
  tier1Signals: string[];
  redFlags: string[];
  catalystConfidence: "high" | "medium" | "low" | "none";
  catalystDescription: string | null;
  entryPrice: number;
  targetPrice: number;
  stopPrice: number;
  rr: number | null;
  analystTarget: number | null;
  vsMA200: number;
  vsMA50: number;
  return3m: number | null;
  move5dPct: number | null;
  rsi14: number | null;
  insiderBuyDollars: number;
  insiderBuyerCount: number;
  insiderLastBuyDaysAgo: number | null;
  callVolumeOiRatio: number | null;
  topOptionsStrike: number | null;
  topOptionsExpiry: string | null;
};

// The opening line makes the actual case (or, for an extended stock
// that only technically qualifies, makes the honest counter-case) —
// this is where "extended, not pulled back" gets said up front rather
// than buried in a caution further down.
function thesisIntro(n: NarrativeInput): string {
  switch (n.tab) {
    case "capitulation":
      return (
        `${n.symbol} is down ${n.move5dPct !== null ? pctStr(n.move5dPct, 1) : "an unknown amount"} ` +
        `over the last ~5 trading days with RSI14 at ${n.rsi14 !== null ? n.rsi14.toFixed(0) : "n/a"} — ` +
        `a capitulation/bounce candidate, not a trend continuation.`
      );
    case "pullback": {
      const trendComp = n.components.find((c) => c.key === "trend200");
      const extended = trendComp?.direction === "negative";
      if (extended) {
        return (
          `${n.symbol} is trading ${pctStr(n.vsMA200)} above its 200-day average and has only ` +
          `pulled back to the 50-day — this reads as an extended stock that ticked down, not a ` +
          `pullback to support.`
        );
      }
      return (
        `${n.symbol} is pulling back to its 50-day average within an uptrend, ${pctStr(n.vsMA200)} ` +
        `above its 200-day MA after a ${n.return3m !== null ? `${n.return3m >= 0 ? "+" : ""}${n.return3m.toFixed(1)}%` : "n/a"} three-month run.`
      );
    }
    case "insider":
      return (
        `${n.symbol} saw ${n.insiderBuyerCount} insider${n.insiderBuyerCount === 1 ? "" : "s"} buy ` +
        `${fmtMarketCapValue(n.insiderBuyDollars)} on the open market, most recently ` +
        `${n.insiderLastBuyDaysAgo !== null ? `${n.insiderLastBuyDaysAgo}d ago` : "at an unknown date"}.`
      );
    case "options_flow":
      return (
        `${n.symbol} is seeing unusual call activity: ${n.callVolumeOiRatio !== null ? n.callVolumeOiRatio.toFixed(2) : "?"}x ` +
        `volume/OI on the $${n.topOptionsStrike ?? "?"} strike expiring ${n.topOptionsExpiry ?? "unknown"}.`
      );
  }
}

function clauseFor(c: ScoreComponent): string {
  return `${c.label} (${c.value}) — ${c.detail}`;
}

// Cross-signal check — does anything ELSE on this candidate corroborate
// the thesis, or is it standing on this one tab's numbers alone. Pulled
// from data already on the candidate (catalyst, confluence, tier-1
// signals) — no new lookups.
function confirmationLines(n: NarrativeInput): string[] {
  const lines: string[] = [];
  if (n.catalystConfidence === "high" || n.catalystConfidence === "medium") {
    lines.push(
      `Catalyst (${n.catalystConfidence} confidence): ${n.catalystDescription ?? "identified but no description available"}.`,
    );
  } else if (n.catalystConfidence === "low") {
    lines.push(
      "A possible catalyst was found but flagged low-confidence — not enough to treat as confirmation.",
    );
  } else {
    lines.push(
      "No confirming catalyst identified — nothing external corroborates this beyond the technical setup itself.",
    );
  }
  const otherTabs = n.setupTabs.filter((t) => t !== n.tab);
  if (otherTabs.length > 0) {
    lines.push(
      `Also qualifies for ${otherTabs.map((t) => TAB_THESIS_LABEL[t]).join(" and ")} — independent confluence, not just this one read.`,
    );
  } else {
    lines.push("Doesn't confirm on any other tab — this thesis stands alone.");
  }
  if (n.tab !== "insider" && n.tier1Signals.includes("INSIDER_BUYING")) {
    lines.push("Insiders are also buying on the open market — a second, unrelated bullish signal.");
  }
  if (n.tab !== "options_flow" && n.tier1Signals.includes("UNUSUAL_OPTIONS")) {
    lines.push("Unusual call buying is also present — options positioning agrees with this setup.");
  }
  if (n.redFlags.some((f) => f.startsWith("HIGH_SHORT"))) {
    lines.push(
      "Short interest is elevated — genuinely ambiguous here (squeeze fuel or a bearish crowd being proven right), not counted for or against.",
    );
  }
  return lines;
}

// Does the trade geometry actually support acting on this, independent
// of setup quality — the same question a trader asks after deciding
// they like the story.
function geometryLine(n: NarrativeInput): string {
  const rewardPct = n.entryPrice > 0 ? (n.targetPrice - n.entryPrice) / n.entryPrice : 0;
  const riskPct = n.entryPrice > 0 ? (n.entryPrice - n.stopPrice) / n.entryPrice : 0;
  const rrText = n.rr !== null ? `${n.rr.toFixed(1)}:1` : "n/a";
  const targetIsAnalyst = n.analystTarget !== null && Math.abs(n.analystTarget - n.targetPrice) < 0.01;
  let room = "";
  if (rewardPct < 0.05) {
    room =
      ` The target leaves almost no room — only ${pctStr(rewardPct)} of upside versus ` +
      `${pctStr(-riskPct)} risked to the stop` +
      (targetIsAnalyst ? ", capped by the analyst-consensus target." : ".");
  } else if (n.rr !== null && n.rr < 1.5) {
    room = ` At ${rrText}, the reward doesn't clearly outweigh the risk being taken.`;
  } else if (n.rr !== null && n.rr >= 2.5) {
    room = ` At ${rrText}, the reward comfortably outweighs the risk.`;
  }
  return (
    `Entry ${fmtMoney2(n.entryPrice)} → target ${fmtMoney2(n.targetPrice)} (${pctStr(rewardPct)}) → ` +
    `stop ${fmtMoney2(n.stopPrice)} (${pctStr(-riskPct)}), R/R ${rrText}.${room}`
  );
}

function fmtMoney2(n: number): string {
  return `$${n.toFixed(2)}`;
}

function scoreTier(score: number): "strong" | "decent" | "marginal" {
  if (score >= 7) return "strong";
  if (score >= 4) return "decent";
  return "marginal";
}

export function buildNarrative(n: NarrativeInput): string {
  const real = n.components.filter((c) => c.key !== "adjust");
  const positives = real.filter((c) => c.direction === "positive" && c.points > 0);
  const negatives = real.filter((c) => c.direction === "negative" || c.points < 0);

  const strength =
    positives.length > 0
      ? positives.map(clauseFor).join(" ")
      : "Nothing in the scoring actually argues for this setup — it's here on a technicality of the qualifier, not on its merits.";

  const caution =
    negatives.length > 0
      ? negatives.map(clauseFor).join(" ")
      : "No scored caution — the components above are the full case, positive or neutral throughout.";

  const confirmation = confirmationLines(n).join(" ");
  const geometry = geometryLine(n);

  const tier = scoreTier(n.score);
  const worst = negatives.length > 0 ? negatives[0] : null;
  const best = positives.length > 0 ? positives[0] : null;
  const bottomLine =
    tier === "strong"
      ? `Score ${n.score}/10 — a strong ${TAB_THESIS_LABEL[n.tab]} case${best ? `, led by ${best.label.toLowerCase()}` : ""}.`
      : tier === "decent"
        ? `Score ${n.score}/10 — a decent but incomplete case${worst ? `; ${worst.label.toLowerCase()} is the main thing arguing against it` : ""}.`
        : `Score ${n.score}/10 — weak. ${worst ? `${worst.label} (${worst.value}) is the deciding problem: ${worst.detail}` : "The setup doesn't hold up under its own scoring."}`;

  return [
    thesisIntro(n),
    `STRENGTH: ${strength}`,
    `CAUTION: ${caution}`,
    `CONFIRMATION: ${confirmation}`,
    `TRADE GEOMETRY: ${geometry}`,
    `BOTTOM LINE: ${bottomLine}`,
  ].join("\n\n");
}

// ---------- Pass 2 ----------

export async function pass2Enrich(
  symbols: string[],
  pass1Data: Map<string, Pass1Quote>,
  trades: Map<string, ReturnType<typeof computeTradeLevels>>,
  tier2ByCandidate: Map<string, string[]>,
  tabInfo: {
    capitulation: Record<string, TabStats>;
    pullback: Record<string, TabStats>;
  } = { capitulation: {}, pullback: {} },
  opts: { forceFresh?: boolean } = {},
): Promise<SwingCandidate[]> {
  const forceFresh = opts.forceFresh ?? false;
  // Schwab is best-effort — if disconnected or after-hours flake, options
  // signal stays neutral and the candidate isn't dropped.
  let schwabAvailable = false;
  try {
    const conn = await isSchwabConnected();
    schwabAvailable = conn.connected;
  } catch {
    schwabAvailable = false;
  }

  const fromIso = isoDaysAhead(25);
  const toIso = isoDaysAhead(65);

  const candidates: SwingCandidate[] = [];

  // Route-level deadline: stop picking up new symbols once ~45s have
  // elapsed so a slow Finnhub/Schwab stretch degrades to a partial
  // candidate list instead of a 60s Vercel timeout (which returns
  // plain text and breaks the client's JSON parse).
  const PASS2_DEADLINE_MS = 45_000;
  const pass2Started = Date.now();
  let deadlineSkipped = 0;

  await mapWithConcurrency(symbols, 5, async (symbol) => {
    if (Date.now() - pass2Started > PASS2_DEADLINE_MS) {
      deadlineSkipped += 1;
      return null;
    }
    const q = pass1Data.get(symbol);
    const tl = trades.get(symbol);
    if (!q || !tl) return null;

    // Finnhub insider + earnings sequentially with a 200ms gap so we don't
    // burst-hit the free-tier rate limit. Schwab options call runs in
    // parallel since it hits a different host.
    let insiderRows: FinnhubInsiderTx[] = [];
    let nextEarn: NextEarningsAnnouncement | null = null;
    try {
      insiderRows = await getFinnhubInsiderTransactions(symbol, 45, { forceFresh });
    } catch {
      insiderRows = [];
    }
    await sleep(200);
    try {
      nextEarn = await getFinnhubNextEarningsDate(symbol, { forceFresh });
    } catch {
      nextEarn = null;
    }

    // Schwab options + ATR history hit different hosts — run concurrently.
    // Schwab (options chain) is never cached — force-fresh or not, this
    // is always a live fetch.
    const [optionsChain, atr14] = await Promise.all([
      schwabAvailable
        ? getCallOptionsChainRange(symbol, fromIso, toIso).catch((e) => {
            const msg = e instanceof Error ? e.message : String(e);
            console.warn(`[swing-screener] schwab calls(${symbol}) failed: ${msg}`);
            return null;
          })
        : Promise.resolve(null),
      fetchAtr14(symbol, { forceFresh }),
    ]);

    const insider = classifyInsiderTxs(insiderRows);
    const opts = analyzeCallChain(optionsChain, q.currentPrice);

    const daysToEarn =
      nextEarn?.date ? daysFromTodayUtc(nextEarn.date) : null;

    const pctFromHigh = (q.currentPrice - q.week52High) / q.week52High;
    const pctFrom52wLow = (q.currentPrice - q.week52Low) / q.week52Low;
    const vsMA50 = (q.currentPrice - q.ma50) / q.ma50;
    const vsMA200 = (q.currentPrice - q.ma200) / q.ma200;
    const volumeRatio =
      q.avgVolume10d > 0 ? q.todayVolume / q.avgVolume10d : 0;

    // Tier-1 signals — earnings is no longer one of these (regular
    // quarterly results aren't a catalyst). Pass 3 will discover real
    // catalysts via Perplexity and add them post-enrichment.
    const tier1Signals: string[] = [];
    if (insider.signal === "strong_bullish" || insider.signal === "bullish") {
      tier1Signals.push("INSIDER_BUYING");
    }
    if (volumeRatio > 2.0 && q.priceChange1d > 0) {
      tier1Signals.push("VOLUME_SPIKE");
    }
    if (opts.unusualOptionsActivity) {
      tier1Signals.push("UNUSUAL_OPTIONS");
    }

    // Red flags. Earnings <7 days is still a hard filter — we don't want
    // to enter a swing the day before a binary print.
    const redFlags: string[] = [];
    if (daysToEarn !== null && daysToEarn < 7) redFlags.push("EARNINGS_TOO_SOON");
    if (q.shortPercentFloat !== null && q.shortPercentFloat > 0.25) {
      redFlags.push(`HIGH_SHORT_${Math.round(q.shortPercentFloat * 100)}%`);
    }
    if (insider.signal === "bearish") redFlags.push("INSIDER_SELLING");

    // Earnings inside 7 days excludes a stock from EVERY tab — swing
    // entries must not run into binary events.
    if (redFlags.includes("EARNINGS_TOO_SOON")) return null;

    // ---- Setup-tab bucketing ----
    // Every tab's score is the sum of named components (see
    // ScoreComponent) — the same list the expanded row's breakdown
    // renders and the narrative is built from below, so the badge, the
    // breakdown, and the prose can never disagree.
    const setupTabs: SetupTab[] = [];
    const tabScores: Partial<Record<SetupTab, number>> = {};
    const tabComponents: Partial<Record<SetupTab, ScoreComponent[]>> = {};
    const capStats = tabInfo.capitulation[symbol] ?? null;
    const pullStats = tabInfo.pullback[symbol] ?? null;
    if (capStats) {
      setupTabs.push("capitulation");
      tabComponents.capitulation = scoreCapitulationComponents(capStats, q);
    }
    if (pullStats) {
      setupTabs.push("pullback");
      tabComponents.pullback = scorePullbackComponents(pullStats, q);
    }
    if (
      tier1Signals.includes("INSIDER_BUYING") &&
      vsMA200 > INSIDER_FREEFALL_VS_MA200
    ) {
      setupTabs.push("insider");
      tabComponents.insider = scoreInsiderComponents(insider.transactions);
    }
    if (opts.unusualOptionsActivity) {
      setupTabs.push("options_flow");
      tabComponents.options_flow = scoreOptionsFlowComponents(opts, q);
    }
    if (setupTabs.length === 0) return null;

    // Red-flag scoring policy: EARNINGS_TOO_SOON gates (handled above).
    // INSIDER_SELLING is the inverse of the INSIDER_BUYING tier-1 signal
    // — on a bullish-only screener a bearish insider read argues against
    // the setup's own thesis, so it's folded in as a real component (not
    // an invisible post-hoc adjustment) worth -2 to every tab this
    // candidate qualifies for. HIGH_SHORT_* stays informational-only:
    // elevated short interest is genuinely ambiguous (squeeze fuel vs.
    // bearish crowd conviction), so there's no defensible direction to
    // score it — it surfaces in the narrative's confirmation section
    // instead.
    if (insider.signal === "bearish") {
      const penalty: ScoreComponent = {
        key: "insider_selling",
        label: "Insider selling",
        value: "net seller on the open market",
        detail:
          "The inverse of the insider-buying tier-1 signal — bearish insider activity argues against a bullish-only setup regardless of which tab surfaced it.",
        points: -2,
        maxPoints: 0,
        direction: "negative",
      };
      for (const t of setupTabs) {
        tabComponents[t] = [...(tabComponents[t] ?? []), penalty];
      }
    }

    for (const t of setupTabs) {
      const { score, components } = finalizeScore(tabComponents[t] ?? []);
      tabScores[t] = score;
      tabComponents[t] = components;
    }

    // R/R is deliberately not a component anywhere above — trade
    // geometry (can you place a sane order) and setup quality (should
    // you take the trade) are separate questions; R/R stays a displayed
    // sanity check only (see the narrative's TRADE GEOMETRY line).
    //
    // The overall score is just the best of the qualifying tabs' scores
    // — there's no separate legacy formula to diverge from what's
    // actually displayed per tab.
    const setupScore = Math.max(0, ...Object.values(tabScores));

    const tier2Signals = tier2ByCandidate.get(symbol) ?? [];

    // Real trade geometry for display — replaces pass 1's rough tl
    // (which only exists to gate pass-1 survival cheaply, before any of
    // this enrichment). Falls back to tl if a symbol somehow produces a
    // degenerate structural level (e.g. entry <= 0).
    const structural = computeStructuralLevels(q, atr14) ?? tl;

    const insiderBreakdown = insiderPurchaseBreakdown(insider.transactions);

    // Narrative built once here (pre-catalyst) so a candidate never ends
    // up with no explanation if pass 3 fails/is skipped — pass 3
    // rebuilds it per tab once catalyst data (and its scoring bonus) is
    // known.
    const tabNarrative: Partial<Record<SetupTab, string>> = {};
    for (const t of setupTabs) {
      tabNarrative[t] = buildNarrative({
        symbol: q.symbol,
        tab: t,
        score: tabScores[t] ?? 0,
        components: tabComponents[t] ?? [],
        setupTabs,
        tier1Signals,
        redFlags,
        catalystConfidence: "none",
        catalystDescription: null,
        entryPrice: structural.entryPrice,
        targetPrice: structural.targetPrice,
        stopPrice: structural.stopPrice,
        rr: structural.rr,
        analystTarget: q.analystTarget,
        vsMA200,
        vsMA50,
        return3m: pullStats?.return3m ?? capStats?.return3m ?? null,
        move5dPct: capStats?.move5dPct ?? pullStats?.move5dPct ?? null,
        rsi14: capStats?.rsi14 ?? pullStats?.rsi14 ?? null,
        insiderBuyDollars: insiderBreakdown.dollars,
        insiderBuyerCount: insiderBreakdown.distinctBuyers,
        insiderLastBuyDaysAgo: insiderBreakdown.newestBuyDaysAgo,
        callVolumeOiRatio: opts.callVolumeOiRatio,
        topOptionsStrike: opts.topOptionsStrike,
        topOptionsExpiry: opts.topOptionsExpiry,
      });
    }

    candidates.push({
      symbol: q.symbol,
      companyName: q.companyName,
      currentPrice: q.currentPrice,
      priceChange1d: q.priceChange1d,
      ma50: q.ma50,
      ma200: q.ma200,
      week52Low: q.week52Low,
      week52High: q.week52High,
      analystTarget: q.analystTarget,
      numAnalysts: q.numAnalysts,
      avgVolume10d: q.avgVolume10d,
      todayVolume: q.todayVolume,
      marketCap: q.marketCap,
      shortPercentFloat: q.shortPercentFloat,
      revenueGrowth: q.revenueGrowth,
      pctFromHigh,
      pctFrom52wLow,
      vsMA50,
      vsMA200,
      volumeRatio,
      rr: structural.rr,
      entryPrice: structural.entryPrice,
      targetPrice: structural.targetPrice,
      stopPrice: structural.stopPrice,
      nextEarningsDate: nextEarn?.date ?? null,
      daysToEarnings: daysToEarn,
      insiderTransactions: insider.transactions,
      insiderSignal: insider.signal,
      executiveBuys: insider.executiveBuys,
      insiderBuyDollars: insiderBreakdown.dollars,
      insiderBuyerCount: insiderBreakdown.distinctBuyers,
      insiderLastBuyDaysAgo: insiderBreakdown.newestBuyDaysAgo,
      unusualOptionsActivity: opts.unusualOptionsActivity,
      callVolumeOiRatio: opts.callVolumeOiRatio,
      optionsSignal: opts.signal,
      topOptionsStrike: opts.topOptionsStrike,
      topOptionsExpiry: opts.topOptionsExpiry,
      // Catalyst fields default to "not yet checked" / "none" — pass 3
      // overwrites these when it runs.
      catalystFound: false,
      catalystType: "none",
      catalystDate: null,
      catalystDescription: null,
      catalystConfidence: "none",
      catalystInsiderAngle: null,
      catalystRawResponse: null,
      tier1Signals,
      tier2Signals,
      redFlags,
      signalCount: tier1Signals.length,
      setupScore,
      setupTabs,
      tabScores,
      tabScoreComponents: tabComponents,
      tabNarrative,
      tabStats: capStats ?? pullStats,
      capitulationStats: capStats,
      pullbackStats: pullStats,
      atr14,
    });
    return null;
  });

  if (deadlineSkipped > 0) {
    console.warn(
      `[swing-screener] pass2 deadline hit — ${deadlineSkipped} of ${symbols.length} symbols skipped`,
    );
  }
  candidates.sort((a, b) => b.setupScore - a.setupScore);
  return candidates;
}

// ---------- Pass 3: catalyst discovery ----------

import { askPerplexityRaw } from "./perplexity";

const VALID_CATALYST_TYPES: ReadonlyArray<CatalystType> = [
  "product_launch",
  "fda",
  "fda_decision",
  "contract",
  "contract_award",
  "rate_decision",
  "partnership",
  "regulatory",
  "management",
  "macro",
  "squeeze",
  "activist",
  "analyst_upgrade",
  "restructuring",
  "other",
  "none",
];

function tryParseObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  const direct = (() => {
    try {
      return JSON.parse(trimmed);
    } catch {
      return null;
    }
  })();
  if (direct && typeof direct === "object" && !Array.isArray(direct)) {
    return direct as Record<string, unknown>;
  }
  // Strip code fences then retry.
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced) {
    try {
      const parsed = JSON.parse(fenced[1].trim());
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      /* fall through */
    }
  }
  // Last resort: find the outermost balanced { ... } block.
  const objMatch = trimmed.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try {
      const parsed = JSON.parse(objMatch[0]);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      /* swallow */
    }
  }
  return null;
}

function buildCatalystPrompt(symbol: string, companyName: string): string {
  return `You are researching ${symbol} (${companyName}) for a swing trader looking for 30-90 day setups.

What SPECIFIC events or catalysts could move this stock significantly in the next 30-90 days?

Look for:
- Product launches or major releases
- FDA approval decisions
- Government contract awards
- Partnership or licensing announcements
- Regulatory decisions
- Management changes with market impact
- Macro events directly impacting this company
- Short squeeze potential
- Activist investor activity
- Any other near-term binary events

Be SPECIFIC with dates if known.
Do NOT include regular quarterly earnings.

If ${symbol} has insider buying, what might insiders know that retail doesn't?

Return ONLY this JSON:
{
  "catalyst_found": true/false,
  "catalyst_type": "product_launch|fda|contract|partnership|regulatory|management|macro|squeeze|activist|other|none",
  "catalyst_date": "YYYY-MM-DD or Q2 2026 or null",
  "catalyst_description": "2-3 specific sentences or null if none found",
  "catalyst_confidence": "high|medium|low|none",
  "insider_angle": "why might insiders be buying right now? or null"
}`;
}

function applyCatalystResponse(
  c: SwingCandidate,
  raw: { text: string } | null,
): SwingCandidate {
  const out: SwingCandidate = { ...c };
  if (!raw || !raw.text) {
    out.catalystRawResponse = null;
    return out;
  }
  out.catalystRawResponse = raw.text;
  const parsed = tryParseObject(raw.text);
  if (!parsed) {
    return out;
  }
  const found = parsed.catalyst_found === true;
  const typeRaw =
    typeof parsed.catalyst_type === "string"
      ? (parsed.catalyst_type as string)
      : "none";
  const type: CatalystType = (VALID_CATALYST_TYPES as readonly string[]).includes(
    typeRaw,
  )
    ? (typeRaw as CatalystType)
    : "other";
  // Date can be ISO (YYYY-MM-DD), or a fuzzy "Q2 2026" / "H2 2026" /
  // "2027" — keep as-is when we can recognise the shape, blank
  // otherwise. fmtCalendarDate in the UI gracefully falls back to
  // passthrough when it can't parse.
  const dateRaw = parsed.catalyst_date;
  const dateStr =
    typeof dateRaw === "string" ? dateRaw.trim() : null;
  const date =
    dateStr && dateStr.length > 0 && dateStr.toLowerCase() !== "null"
      ? dateStr
      : null;
  const desc =
    typeof parsed.catalyst_description === "string" &&
    parsed.catalyst_description.trim().length > 0
      ? parsed.catalyst_description.trim()
      : null;
  const confRaw =
    typeof parsed.catalyst_confidence === "string"
      ? parsed.catalyst_confidence.toLowerCase()
      : "none";
  const confidence: SwingCandidate["catalystConfidence"] =
    confRaw === "high" || confRaw === "medium" || confRaw === "low"
      ? confRaw
      : "none";
  // insider_angle can come back even when no specific catalyst was
  // found — that's the whole point: insiders may be buying for a
  // structural reason (turnaround, hidden value) rather than a single
  // upcoming event.
  const angleRaw = parsed.insider_angle;
  const angle =
    typeof angleRaw === "string" &&
    angleRaw.trim().length > 0 &&
    angleRaw.trim().toLowerCase() !== "null"
      ? angleRaw.trim()
      : null;
  out.catalystFound = found;
  out.catalystType = found ? type : "none";
  out.catalystDate = found ? date : null;
  out.catalystDescription = desc;
  out.catalystConfidence = found ? confidence : "none";
  out.catalystInsiderAngle = angle;
  return out;
}

// Catalyst fields a prior run can carry forward so a re-screen doesn't
// re-pay Perplexity for symbols it already researched recently.
export type KnownCatalyst = Pick<
  SwingCandidate,
  | "catalystFound"
  | "catalystType"
  | "catalystDate"
  | "catalystDescription"
  | "catalystConfidence"
  | "catalystInsiderAngle"
  | "catalystRawResponse"
>;

// Hard ceiling on fresh Perplexity calls per run. With 4 tabs the
// candidate set can be much larger than the old insider-dominated
// list; 24 × ~3s / 3-concurrency ≈ 24s keeps the route under 60s.
const MAX_FRESH_CATALYST_CALLS = 24;

export async function pass3CatalystDiscovery(
  candidates: SwingCandidate[],
  opts: { knownCatalysts?: Record<string, KnownCatalyst> } = {},
): Promise<SwingCandidate[]> {
  if (candidates.length === 0) return [];
  const known = opts.knownCatalysts ?? {};

  // Split: cached catalysts apply instantly; the rest get fresh
  // Perplexity calls, highest setupScore first, capped.
  const out: SwingCandidate[] = new Array(candidates.length);
  const freshIdx: number[] = [];
  for (let i = 0; i < candidates.length; i += 1) {
    const c = candidates[i];
    const cached = known[c.symbol.toUpperCase()];
    if (cached) {
      out[i] = { ...c, ...cached };
    } else {
      freshIdx.push(i);
    }
  }
  freshIdx.sort(
    (a, b) => candidates[b].setupScore - candidates[a].setupScore,
  );
  const toFetch = freshIdx.slice(0, MAX_FRESH_CATALYST_CALLS);
  for (const i of freshIdx.slice(MAX_FRESH_CATALYST_CALLS)) {
    out[i] = candidates[i]; // beyond the cap: defaults stay "none"
  }
  if (freshIdx.length > MAX_FRESH_CATALYST_CALLS) {
    console.log(
      `[pass3] capping fresh catalyst calls at ${MAX_FRESH_CATALYST_CALLS} ` +
        `(${freshIdx.length - MAX_FRESH_CATALYST_CALLS} lower-scored candidates skipped, ` +
        `${candidates.length - freshIdx.length} served from prior run)`,
    );
  }

  // Process in fixed-size batches with a 500ms inter-batch gap so we
  // don't burst the Perplexity rate limit. Two layers of timeout
  // protection keep the route under Vercel's 60s ceiling no matter
  // how Perplexity behaves: a 20s per-call abort, and a 40s launch
  // deadline after which remaining batches keep their defaults.
  // 35s launch deadline + 20s per-call abort = 55s worst case, safely
  // inside the 60s function ceiling.
  const BATCH = 3;
  const PASS3_DEADLINE_MS = 35_000;
  const pass3Started = Date.now();
  for (let i = 0; i < toFetch.length; i += BATCH) {
    if (Date.now() - pass3Started > PASS3_DEADLINE_MS) {
      console.warn(
        `[pass3] deadline hit — ${toFetch.length - i} catalyst lookups skipped`,
      );
      for (const idx of toFetch.slice(i)) out[idx] = candidates[idx];
      break;
    }
    const batch = toFetch.slice(i, i + BATCH);
    const results = await Promise.all(
      batch.map(async (idx) => {
        const c = candidates[idx];
        try {
          const raw = await askPerplexityRaw(
            buildCatalystPrompt(c.symbol, c.companyName),
            { label: `catalyst:${c.symbol}`, maxTokens: 600, timeoutMs: 20_000 },
          );
          return applyCatalystResponse(c, raw);
        } catch (e) {
          console.warn(
            `[pass3] ${c.symbol} catalyst failed: ${e instanceof Error ? e.message : e}`,
          );
          return c;
        }
      }),
    );
    for (let j = 0; j < batch.length; j += 1) {
      out[toFetch[i + j]] = results[j];
    }
    if (i + BATCH < toFetch.length) await sleep(500);
  }

  // Re-score with catalyst points: +2 high, +1 medium, +0 low/none —
  // applied as a real component on EVERY qualifying tab (not just the
  // top-level setupScore) so the per-tab badge, breakdown, and narrative
  // stay in sync with what pass 3 found. NOTE: pass 3 only ENRICHES —
  // every candidate that made it through pass 2's tier-1 filter must
  // remain in the result set regardless of whether Perplexity found a
  // specific catalyst. No candidate is filtered out here, no points are
  // subtracted, and a missing catalyst never reduces a stock's score
  // below what pass 2 produced.
  return out.map((c) => {
    const bonus =
      c.catalystConfidence === "high" ? 2 : c.catalystConfidence === "medium" ? 1 : 0;
    const tabScores: Partial<Record<SetupTab, number>> = {};
    const tabScoreComponents: Partial<Record<SetupTab, ScoreComponent[]>> = {};
    const tabNarrative: Partial<Record<SetupTab, string>> = {};
    for (const tab of c.setupTabs) {
      const base = c.tabScoreComponents[tab] ?? [];
      const withCatalyst =
        bonus > 0
          ? [
              ...base,
              {
                key: "catalyst",
                label: "Catalyst",
                value: `${c.catalystConfidence} confidence`,
                detail: c.catalystDescription ?? "Perplexity identified a near-term catalyst.",
                points: bonus,
                maxPoints: 2,
                direction: "positive" as const,
              },
            ]
          : base;
      const { score, components } = finalizeScore(withCatalyst);
      tabScores[tab] = score;
      tabScoreComponents[tab] = components;
      tabNarrative[tab] = buildNarrative({
        symbol: c.symbol,
        tab,
        score,
        components,
        setupTabs: c.setupTabs,
        tier1Signals: c.tier1Signals,
        redFlags: c.redFlags,
        catalystConfidence: c.catalystConfidence,
        catalystDescription: c.catalystDescription,
        entryPrice: c.entryPrice,
        targetPrice: c.targetPrice,
        stopPrice: c.stopPrice,
        rr: c.rr,
        analystTarget: c.analystTarget,
        vsMA200: c.vsMA200,
        vsMA50: c.vsMA50,
        return3m: c.pullbackStats?.return3m ?? c.capitulationStats?.return3m ?? null,
        move5dPct: c.capitulationStats?.move5dPct ?? c.pullbackStats?.move5dPct ?? null,
        rsi14: c.capitulationStats?.rsi14 ?? c.pullbackStats?.rsi14 ?? null,
        insiderBuyDollars: c.insiderBuyDollars,
        insiderBuyerCount: c.insiderBuyerCount,
        insiderLastBuyDaysAgo: c.insiderLastBuyDaysAgo,
        callVolumeOiRatio: c.callVolumeOiRatio,
        topOptionsStrike: c.topOptionsStrike,
        topOptionsExpiry: c.topOptionsExpiry,
      });
    }
    return {
      ...c,
      setupScore: Math.max(0, ...Object.values(tabScores)),
      tabScores,
      tabScoreComponents,
      tabNarrative,
    };
  });
}

// ---------- Top-level entry ----------

export type ScreenerResult = {
  candidates: SwingCandidate[];
  screened: number;
  pass1Survivors: number;
  pass2Results: number;
  durationMs: number;
  errors: string[];
};

export async function runSwingScreener(
  universe: string[],
): Promise<ScreenerResult> {
  const started = Date.now();
  const p1 = await pass1Filter(universe);
  const p2 = await pass2Enrich(p1.survivors, p1.quotes, p1.trades, p1.tier2ByCandidate, {
    capitulation: p1.capitulation,
    pullback: p1.pullback,
  });
  const p3 = await pass3CatalystDiscovery(p2);
  // Re-sort post-pass-3 since catalyst points can shift the ranking.
  p3.sort((a, b) => b.setupScore - a.setupScore);
  return {
    candidates: p3,
    screened: universe.length,
    pass1Survivors: p1.survivors.length,
    pass2Results: p3.length,
    durationMs: Date.now() - started,
    errors: p1.errors,
  };
}

// ---------- Wire format for the split route pair ----------
//
// Pass 1's result includes JS Maps that don't survive JSON.stringify, so
// the route serializes to plain Records before sending to the client and
// reconstitutes them in pass 2. Pass1Wire intentionally only carries data
// for survivors (we don't need the full quote map cross-passed).

export type Pass1Wire = {
  survivors: string[];
  screened: number;
  errors: string[];
  quotes: Record<string, Pass1Quote>;
  trades: Record<string, TradeLevels>;
  tier2ByCandidate: Record<string, string[]>;
  capitulation: Record<string, TabStats>;
  pullback: Record<string, TabStats>;
};

export function serializePass1(
  result: Awaited<ReturnType<typeof pass1Filter>>,
  screened: number,
): Pass1Wire {
  const quotes: Record<string, Pass1Quote> = {};
  const trades: Record<string, TradeLevels> = {};
  const tier2ByCandidate: Record<string, string[]> = {};
  // Strip non-survivor entries — the client doesn't need quotes for stocks
  // we already dropped, and dragging them across the wire wastes ~150KB.
  for (const sym of result.survivors) {
    const q = result.quotes.get(sym);
    const t = result.trades.get(sym);
    const sigs = result.tier2ByCandidate.get(sym);
    if (q) quotes[sym] = q;
    if (t) trades[sym] = t;
    if (sigs) tier2ByCandidate[sym] = sigs;
  }
  return {
    survivors: result.survivors,
    screened,
    errors: result.errors,
    quotes,
    trades,
    tier2ByCandidate,
    capitulation: result.capitulation,
    pullback: result.pullback,
  };
}

export function deserializePass1(wire: Pass1Wire): {
  quotes: Map<string, Pass1Quote>;
  trades: Map<string, TradeLevels>;
  tier2ByCandidate: Map<string, string[]>;
} {
  const quotes = new Map<string, Pass1Quote>();
  const trades = new Map<string, TradeLevels>();
  const tier2ByCandidate = new Map<string, string[]>();
  for (const [k, v] of Object.entries(wire.quotes)) quotes.set(k, v);
  for (const [k, v] of Object.entries(wire.trades)) trades.set(k, v);
  for (const [k, v] of Object.entries(wire.tier2ByCandidate)) {
    tier2ByCandidate.set(k, v);
  }
  return { quotes, trades, tier2ByCandidate };
}

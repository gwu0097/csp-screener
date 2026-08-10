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
  getFinnhubNextEarningsDateOrThrow,
  type FinnhubInsiderTx,
  type NextEarningsAnnouncement,
} from "./earnings";
import {
  getCallOptionsChainRange,
  isSchwabConnected,
  type SchwabOptionContract,
  type SchwabOptionsChain,
} from "./schwab";
import { getResearchSnapshot, getSectorIndustryOrThrow } from "./yahoo";
import {
  batchRefreshSnapshots,
  type SymbolSnapshot,
} from "./market-snapshot";
import { computeATR, computeADRPercent, computeSMA } from "./indicators";
import { createServerClient } from "./supabase";
import { getOrFetchDailyBars, DAILY_BARS_STALE_MS, type DailyBar } from "./daily-bars-cache";
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

// The five setup-type tabs. A candidate can qualify for several
// (confluence) — setupTabs lists every tab it belongs to and
// tabScores carries the per-tab ranking score (0-10).
//
// rs_pullback is structurally different from the other four: it's a
// pass/fail trend+RS classification split into three lists rather than a
// 0-10 ranked score (see RsPullbackList/computeRsPullbackCandidates
// below) — rs_pullback candidates carry setupScore 0 and empty
// tabScores/tabScoreComponents/tabNarrative by design, not by omission.
export type SetupTab = "capitulation" | "pullback" | "insider" | "options_flow" | "rs_pullback";

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

  // 20-day Average Daily Range, as a % of price — display + filter only,
  // never a scoring input (see scoreCapitulationComponents etc., none of
  // which reference this field). Same daily_bars_cache bars as atr14,
  // computed in the same pass so there's no extra cache read.
  adr20Pct: number | null;

  // Yahoo sector, cached in stock_profiles (see getOrFetchSector). Display
  // only — not used by any tab qualifier or scorer.
  sector: string | null;

  // ---- RS Pullback tab only (see computeRsPullbackCandidates). All
  // null/undefined for every other tab's candidates. ----
  // ((price - SMA50) / SMA50 * 100) / ADR% — how many "average days of
  // range" price sits from its 50MA. The gate/list-partition input.
  extensionAdrDays?: number | null;
  // Stock's N-day return minus SPY's N-day return, both computed from
  // daily_bars_cache closes (not a live quote — see the function's own
  // comment for why). > 0 is the RS gate; the raw number is displayed.
  rs20?: number | null;
  rs60?: number | null;
  // Whether the stock made a higher low than SPY while SPY made a lower
  // low over the trailing 30 sessions. Display-only, never gates — see
  // computeHigherLowVsSpy for the exact (documented-heuristic) definition.
  higherLowVsSpy?: boolean | null;
  // Which of the three output lists this candidate landed in.
  rsPullbackList?: RsPullbackList | null;
  // True if this candidate was produced with a sector or earnings check
  // that failed (Finnhub 429, Yahoo error, etc.) rather than a real
  // answer — fail-open still includes the candidate, but the caller
  // couldn't actually confirm it isn't disqualified. Surfaced rather
  // than silently absorbed, per the 2026-08 throttling incident.
  dataQualityDegraded?: boolean;
  dataQualityIssues?: string[];
  // ---- RS Pullback row-detail fields — the underlying values behind
  // extensionAdrDays/rs20/rs60/the 50MA-rising gate, exposed so they're
  // checkable rather than assertions. All bars-derived except where
  // noted; null/undefined for every other tab's candidates. ----
  sma20?: number | null;
  // Bars-derived SMA50 as of today and as of sma50RisingLookbackSessions
  // sessions ago — the same two numbers extensionAdrDays and the
  // 50MA-rising gate are computed from. Deliberately not "ma50" (that's
  // Yahoo's separate point-in-time quote value, used elsewhere).
  sma50AtEntry?: number | null;
  sma50TwentySessionsAgo?: number | null;
  sma50RisingPct?: number | null;
  // Raw N-session returns (bars-only, both endpoints — see
  // nSessionReturn) for the stock and for SPY, before the rs20/rs60
  // diff is taken.
  stockReturn20?: number | null;
  stockReturn60?: number | null;
  spyReturn20?: number | null;
  spyReturn60?: number | null;
};

export type RsPullbackList = "ready" | "leading_extended" | "in_zone_lagging";

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
// Single bars fetch feeds both ATR14 (stop/target geometry) and ADR%20
// (display + filter, added alongside the plan-vs-actual journal) — no
// reason to hit daily_bars_cache twice for the same symbol.
async function fetchAtrAndAdr(
  symbol: string,
  opts: { forceFresh?: boolean } = {},
): Promise<{ atr14: number | null; adr20Pct: number | null }> {
  try {
    const bars = await getOrFetchDailyBars(symbol, opts);
    return { atr14: computeATR(bars, 14), adr20Pct: computeADRPercent(bars, 20) };
  } catch {
    return { atr14: null, adr20Pct: null };
  }
}

// Sector is cached indefinitely in stock_profiles (same table/TTL policy
// lib/classification.ts already uses for industry — sector drifts about
// as often, i.e. essentially never) — a cache hit avoids a live Yahoo
// quoteSummary call on every screen run. getSectorIndustry already
// existed in lib/yahoo.ts (unused anywhere until now); this just gives
// its result somewhere to land.
// `failed` distinguishes "checked, no sector on file" from "the live
// fetch itself failed" (rate limit, network) — RS Pullback's enrichment
// needs that distinction for data-quality tracking; pass2Enrich (the
// four legacy tabs) just reads `.sector` and ignores `.failed`, so this
// is a behavior-preserving change for that caller.
async function getOrFetchSector(symbol: string): Promise<{ sector: string | null; failed: boolean }> {
  const sb = createServerClient();
  try {
    const cached = await sb
      .from("stock_profiles")
      .select("sector")
      .eq("symbol", symbol)
      .maybeSingle();
    const row = cached.data as { sector: string | null } | null;
    if (row?.sector) return { sector: row.sector, failed: false };
  } catch {
    // fall through to a live fetch
  }
  try {
    const { sector } = await getSectorIndustryOrThrow(symbol);
    if (sector) {
      // Partial upsert — only touches `sector`/`updated_at`, leaves
      // industry/industry_pass/market_cap_billions alone if the row
      // already exists (same pattern as classification.ts's
      // cacheMarketCapBillions).
      await sb
        .from("stock_profiles")
        .upsert({ symbol, sector, updated_at: new Date().toISOString() }, { onConflict: "symbol" });
    }
    return { sector, failed: false };
  } catch (e) {
    console.warn(
      `[swing-screener] getOrFetchSector(${symbol}) live fetch failed: ${e instanceof Error ? e.message : e}`,
    );
    return { sector: null, failed: true };
  }
}

// ---------- RS Pullback (fifth tab) ----------
//
// Structurally different from the other four tabs: no 0-10 score, no
// narrative. A candidate either passes the trend+volatility filter or it
// doesn't, and if it does, it lands in exactly one of three lists based
// on relative strength and how extended it is from its own 50MA. See
// computeRsPullbackCandidates for the full pipeline.

export type RsPullbackThresholds = {
  minAdrPct: number;
  // Boundary for BOTH "Ready" (inside) and "Leading, extended" (outside)
  // — there is no separate extended threshold above this one. See the
  // list-partition comment in the enrichment loop for why a second
  // threshold used to exist and was removed.
  entryZoneAdrDays: number;
  sma50RisingMinPct: number;
  sma50RisingLookbackSessions: number;
  ma50BelowTolerancePct: number;
};

export const DEFAULT_RS_PULLBACK_THRESHOLDS: RsPullbackThresholds = {
  minAdrPct: 3.0,
  entryZoneAdrDays: 1.0,
  sma50RisingMinPct: 3.0,
  sma50RisingLookbackSessions: 20,
  ma50BelowTolerancePct: 3.0,
};

// Sector disqualifiers — checked in enrichment (needs getOrFetchSector),
// not the pregate below (which only has Pass1Quote, no sector).
const RS_PULLBACK_DISQUALIFIED_SECTORS = new Set(["Real Estate", "Utilities"]);

// Same liquidity floor the legacy funnel applies (price >= $10, mcap >=
// $500M) — RS Pullback has its own independent gate chain, not a
// subset of the legacy funnel, so it needs this stated explicitly rather
// than inheriting it.
const RS_PULLBACK_MIN_PRICE = 10;
const RS_PULLBACK_MIN_MARKET_CAP = 500_000_000;

// Cheap pre-gate using only the already-fetched Pass1Quote (Yahoo's
// point-in-time 50MA/200MA) — narrows the ~520-symbol universe before any
// per-symbol bars/earnings/sector fetch. This is the part of the trend
// filter that doesn't need bar history; the 50MA-RISING leg needs a
// historical SMA50 and can only be checked once bars are fetched. No cap
// here — every symbol that passes goes on to applyRsPullbackPrefilter
// (free, cache-only) and then real enrichment, chunked as needed; capping
// the pregate itself would silently drop symbols before they're ever
// evaluated, which is exactly what the 2026-08 audit flagged. Exported so
// pass1Filter can union pregated symbols into its survivor set (otherwise
// serializePass1 would strip their quotes before enrichment ever sees
// them).
export function pregateRsPullbackSymbols(
  quotes: Map<string, Pass1Quote>,
  thresholds: RsPullbackThresholds = DEFAULT_RS_PULLBACK_THRESHOLDS,
): string[] {
  const out: string[] = [];
  for (const q of Array.from(quotes.values())) {
    if (q.currentPrice < RS_PULLBACK_MIN_PRICE) continue;
    if (q.marketCap < RS_PULLBACK_MIN_MARKET_CAP) continue;
    if (!(q.ma50 > 0) || !(q.ma200 > 0)) continue;
    if (q.currentPrice <= q.ma200) continue;
    const vsMA50 = (q.currentPrice - q.ma50) / q.ma50;
    if (vsMA50 < -thresholds.ma50BelowTolerancePct / 100) continue;
    out.push(q.symbol);
  }
  return out;
}

// ---- Bulk (cache-only, no live calls) pre-filter ----
//
// Runs once, up front, over the full pregate set — narrows how many
// symbols the (expensive, Finnhub-bound) chunked enrichment below has to
// touch. Two DB-only checks, chunked at 100 symbols per query to stay
// well under the PostgREST wrapper's read cap and keep URL length sane:
//   1. Sector, if already cached in stock_profiles (indefinite TTL) —
//      excludes Real Estate/Utilities for symbols we already know about.
//   2. 50MA-rising, computed from daily_bars_cache IF a fresh (<30h) row
//      already exists — excludes symbols whose cached bars already show
//      a clearly-failing rising check.
// A symbol with no cached sector or no fresh cached bars simply passes
// through to needsEnrichment unchanged — this step only ever removes
// symbols it can PROVE fail, from data already sitting in the DB. It
// never asserts a symbol passes; the real (fresh-bars, live-earnings)
// check in enrichRsPullbackChunk is still authoritative for anything
// that survives here.
const PREFILTER_CHUNK = 100;

async function bulkCachedSectors(symbols: string[]): Promise<Map<string, string>> {
  const sb = createServerClient();
  const out = new Map<string, string>();
  for (let i = 0; i < symbols.length; i += PREFILTER_CHUNK) {
    const chunk = symbols.slice(i, i + PREFILTER_CHUNK);
    try {
      const res = await sb.from("stock_profiles").select("symbol,sector").in("symbol", chunk);
      if (res.error || !res.data) continue;
      for (const row of res.data as Array<{ symbol: string; sector: string | null }>) {
        if (row.sector) out.set(row.symbol, row.sector);
      }
    } catch {
      // best-effort — a failed chunk just means those symbols fall
      // through to full enrichment instead of being pre-excluded
    }
  }
  return out;
}

async function bulkFreshBars(symbols: string[]): Promise<Map<string, DailyBar[]>> {
  const sb = createServerClient();
  const out = new Map<string, DailyBar[]>();
  const now = Date.now();
  for (let i = 0; i < symbols.length; i += PREFILTER_CHUNK) {
    const chunk = symbols.slice(i, i + PREFILTER_CHUNK);
    try {
      // Sorted desc by trading_day, no per-symbol grouping available
      // through this wrapper — so we take the FIRST row seen per symbol
      // while iterating (that's the latest, since the whole result set
      // is sorted). limit() is generous headroom for symbols carrying a
      // few historical rows (daily_bars_cache today: mostly 1 row/symbol,
      // up to 4 for a few).
      const res = await sb
        .from("daily_bars_cache")
        .select("symbol,bars,last_refreshed_at")
        .in("symbol", chunk)
        .order("trading_day", { ascending: false })
        .limit(chunk.length * 5);
      if (res.error || !res.data) continue;
      for (const row of res.data as Array<{
        symbol: string;
        bars: DailyBar[];
        last_refreshed_at: string;
      }>) {
        if (out.has(row.symbol)) continue;
        const ageMs = now - new Date(row.last_refreshed_at).getTime();
        if (ageMs < DAILY_BARS_STALE_MS) out.set(row.symbol, row.bars);
      }
    } catch {
      // best-effort — falls through to full enrichment for this chunk
    }
  }
  return out;
}

export async function applyRsPullbackPrefilter(
  pregatedSymbols: string[],
  thresholds: RsPullbackThresholds = DEFAULT_RS_PULLBACK_THRESHOLDS,
): Promise<{
  needsEnrichment: string[];
  excludedBySectorPrefilter: number;
  excludedBySma50RisingPrefilter: number;
}> {
  if (pregatedSymbols.length === 0) {
    return { needsEnrichment: [], excludedBySectorPrefilter: 0, excludedBySma50RisingPrefilter: 0 };
  }
  const [sectors, freshBars] = await Promise.all([
    bulkCachedSectors(pregatedSymbols),
    bulkFreshBars(pregatedSymbols),
  ]);

  const minBarsNeeded = Math.max(thresholds.sma50RisingLookbackSessions + 50, 61);
  let excludedBySectorPrefilter = 0;
  let excludedBySma50RisingPrefilter = 0;
  const needsEnrichment: string[] = [];

  for (const symbol of pregatedSymbols) {
    const sector = sectors.get(symbol);
    if (sector && RS_PULLBACK_DISQUALIFIED_SECTORS.has(sector)) {
      excludedBySectorPrefilter += 1;
      continue;
    }
    const bars = freshBars.get(symbol);
    if (bars && bars.length >= minBarsNeeded) {
      const closes = bars.map((b) => b.close);
      const sma50Now = computeSMA(closes, 50);
      const sma50Ago = smaAsOfSessionsAgo(closes, 50, thresholds.sma50RisingLookbackSessions);
      if (sma50Now !== null && sma50Ago !== null && sma50Ago > 0) {
        const risingPct = ((sma50Now - sma50Ago) / sma50Ago) * 100;
        if (risingPct < thresholds.sma50RisingMinPct) {
          excludedBySma50RisingPrefilter += 1;
          continue;
        }
      }
    }
    needsEnrichment.push(symbol);
  }

  return { needsEnrichment, excludedBySectorPrefilter, excludedBySma50RisingPrefilter };
}

// Bars-derived SMA50 "as of N sessions ago" — drop the most recent N
// closes, then take the 50-bar SMA of what's left. Same computeSMA
// semantics as everywhere else in this file ("last `period` of the given
// array"), just given a trimmed array.
function smaAsOfSessionsAgo(
  closes: number[],
  period: number,
  sessionsAgo: number,
): number | null {
  const trimmed = sessionsAgo > 0 ? closes.slice(0, closes.length - sessionsAgo) : closes;
  return computeSMA(trimmed, period);
}

// Whether the stock made a higher low than SPY while SPY made a lower
// low, over the trailing `sessions` days. Display-only — never gates.
// This is a documented heuristic, not full swing-low detection: splits
// the window into two equal halves and compares each half's lowest LOW.
// A real swing-low algorithm would find local minima; a fixed 15/15 split
// is a simpler, defensible stand-in given this field is explicitly
// non-gating.
function computeHigherLowVsSpy(
  stockBars: DailyBar[],
  spyBars: DailyBar[],
  sessions = 30,
): boolean | null {
  const half = Math.floor(sessions / 2);
  if (stockBars.length < sessions || spyBars.length < sessions) return null;
  const sWindow = stockBars.slice(-sessions);
  const pWindow = spyBars.slice(-sessions);
  const sEarlyLow = Math.min(...sWindow.slice(0, half).map((b) => b.low));
  const sRecentLow = Math.min(...sWindow.slice(half).map((b) => b.low));
  const pEarlyLow = Math.min(...pWindow.slice(0, half).map((b) => b.low));
  const pRecentLow = Math.min(...pWindow.slice(half).map((b) => b.low));
  return sRecentLow > sEarlyLow && pRecentLow < pEarlyLow;
}

// N-session return from a closes series (OLDEST FIRST), both endpoints
// from the array — not the live quote. This keeps the stock side and the
// SPY side on identical footing (SPY has no "live quote" fetched
// anywhere in this pipeline, only cached bars); mixing a live stock price
// against a bars-derived SPY return would put a few-hours-old skew into
// the RS diff that has nothing to do with actual relative strength.
function nSessionReturn(closes: number[], n: number): number | null {
  if (closes.length < n + 1) return null;
  const now = closes[closes.length - 1];
  const then = closes[closes.length - 1 - n];
  if (!(then > 0)) return null;
  return ((now - then) / then) * 100;
}

export async function computeRsPullbackCandidates(
  symbols: string[],
  pass1Data: Map<string, Pass1Quote>,
  thresholds: RsPullbackThresholds = DEFAULT_RS_PULLBACK_THRESHOLDS,
  opts: { forceFresh?: boolean } = {},
): Promise<{
  candidates: SwingCandidate[];
  excludedBySma50Rising: number;
  // Pregate survivor whose data couldn't be evaluated at all (bars
  // fetch failed or came back with too little history) — never became a
  // candidate, in any list. Distinct from a real disqualification: we
  // don't actually know if this name would have qualified.
  insufficientData: number;
  // Of the candidates actually produced, how many carry
  // dataQualityDegraded — i.e. were evaluated with a sector or earnings
  // check that failed rather than returning a real answer.
  degradedCount: number;
  // Symbols in this chunk not reached before the internal deadline —
  // should be near-empty given chunk sizes are chosen to fit comfortably
  // under it, but if not, the caller MUST re-queue these (e.g. as part
  // of the next chunk) to keep the "every survivor evaluated" guarantee
  // mechanical rather than probabilistic.
  deadlineSkipped: string[];
}> {
  const forceFresh = opts.forceFresh ?? false;
  if (symbols.length === 0) {
    return {
      candidates: [],
      excludedBySma50Rising: 0,
      insufficientData: 0,
      degradedCount: 0,
      deadlineSkipped: [],
    };
  }

  const spyBars = await getOrFetchDailyBars("SPY", { forceFresh }).catch(() => [] as DailyBar[]);
  const spyCloses = spyBars.map((b) => b.close);

  // Minimum history: 50-bar SMA anchored `sma50RisingLookbackSessions`
  // sessions back (default 70 bars) and a 60-session return (61 bars) —
  // whichever is larger.
  const minBarsNeeded = Math.max(thresholds.sma50RisingLookbackSessions + 50, 61);

  const candidates: SwingCandidate[] = [];
  let excludedBySma50Rising = 0;
  let insufficientData = 0;
  let degradedCount = 0;
  const deadlineSkipped: string[] = [];
  const started = Date.now();
  // Safety backstop, not the primary coverage mechanism — chunk sizes are
  // chosen (client-side) to comfortably finish well under this. If it
  // still trips, deadlineSkipped carries the symbols that didn't get
  // processed so the caller can re-queue them rather than silently lose
  // coverage.
  const DEADLINE_MS = 45_000;

  await mapWithConcurrency(symbols, 5, async (symbol) => {
    if (Date.now() - started > DEADLINE_MS) {
      deadlineSkipped.push(symbol);
      return null;
    }
    const q = pass1Data.get(symbol);
    if (!q) return null;

    // getOrFetchSector already distinguishes fetch failure from "no
    // sector on file" (returns .failed), so its own internal try/catch
    // is enough — no wrapping .catch needed here. Earnings uses the
    // OrThrow variant specifically so a Finnhub 429 actually rejects
    // instead of silently resolving to null (which is what
    // getFinnhubNextEarningsDate's own internal catch would otherwise
    // do, making a throttled call indistinguishable from a real "no
    // earnings" result).
    let earningsFailed = false;
    const [bars, sectorResult, nextEarn] = await Promise.all([
      getOrFetchDailyBars(symbol, { forceFresh }).catch(() => [] as DailyBar[]),
      getOrFetchSector(symbol),
      getFinnhubNextEarningsDateOrThrow(symbol, { forceFresh }).catch(() => {
        earningsFailed = true;
        return null;
      }),
    ]);
    const sector = sectorResult.sector;
    const sectorFailed = sectorResult.failed;

    // Earnings <7 days out — same disqualifier pass2Enrich applies to
    // every other tab. earningsFailed means we DON'T actually know this
    // — the candidate proceeds (fail-open, same as elsewhere in this
    // file) but gets flagged as degraded below rather than silently
    // treated as "no earnings risk confirmed."
    const daysToEarn = nextEarn?.date ? daysFromTodayUtc(nextEarn.date) : null;
    if (daysToEarn !== null && daysToEarn < 7) return null;

    if (sector !== null && RS_PULLBACK_DISQUALIFIED_SECTORS.has(sector)) return null;

    const closes = bars.map((b) => b.close);
    if (closes.length < minBarsNeeded || spyCloses.length < minBarsNeeded) {
      insufficientData += 1;
      return null;
    }

    const sma50Now = computeSMA(closes, 50);
    const sma50Ago = smaAsOfSessionsAgo(
      closes,
      50,
      thresholds.sma50RisingLookbackSessions,
    );
    if (sma50Now === null || sma50Ago === null || !(sma50Ago > 0)) {
      insufficientData += 1;
      return null;
    }

    const sma50RisingPct = ((sma50Now - sma50Ago) / sma50Ago) * 100;
    if (sma50RisingPct < thresholds.sma50RisingMinPct) {
      excludedBySma50Rising += 1;
      return null;
    }

    // Re-derive price-vs-50MA from the SAME bars-based SMA50 used for the
    // rising check and the extension calc below, rather than Yahoo's
    // separately-sourced point quote — one consistent SMA50 throughout,
    // not two numbers that could quietly disagree.
    const vsMA50Bars = (q.currentPrice - sma50Now) / sma50Now;
    if (vsMA50Bars < -thresholds.ma50BelowTolerancePct / 100) return null;

    const adr20Pct = computeADRPercent(bars, 20);
    if (adr20Pct === null || adr20Pct < thresholds.minAdrPct) return null;

    const extensionAdrDays = (((q.currentPrice - sma50Now) / sma50Now) * 100) / adr20Pct;
    const sma20 = computeSMA(closes, 20);

    const stockReturn20 = nSessionReturn(closes, 20);
    const stockReturn60 = nSessionReturn(closes, 60);
    const spyReturn20 = nSessionReturn(spyCloses, 20);
    const spyReturn60 = nSessionReturn(spyCloses, 60);
    if (
      stockReturn20 === null ||
      stockReturn60 === null ||
      spyReturn20 === null ||
      spyReturn60 === null
    ) {
      return null;
    }
    const rs20 = stockReturn20 - spyReturn20;
    const rs60 = stockReturn60 - spyReturn60;
    const higherLowVsSpy = computeHigherLowVsSpy(bars, spyBars, 30);

    const passesRs = rs20 > 0 && rs60 > 0;
    const inEntryZone = Math.abs(extensionAdrDays) <= thresholds.entryZoneAdrDays;

    // Leading-extended is "passes RS and isn't in the entry zone" — full
    // stop, not a second threshold above the entry zone. An earlier
    // version gated this on extensionAdrDays > extendedAdrDaysThreshold
    // (2.0), which left a dead band between the entry zone (1.0) and
    // that threshold: a candidate passing RS with, say, ext=1.5 matched
    // neither "in entry zone" nor "past 2.0" and was evaluated, then
    // silently dropped from all three lists. Confirmed live: 11 of 68
    // fully-evaluated candidates fell in that band on 2026-08-10. Every
    // passesRs candidate now lands in exactly one of Ready/
    // Leading-extended; only "fails RS and not in the entry zone" is
    // still unshown, which is intentional — In-zone/lagging is
    // explicitly the entry-zone control group, not a catch-all.
    let list: RsPullbackList | null = null;
    if (passesRs && inEntryZone) list = "ready";
    else if (passesRs && !inEntryZone) list = "leading_extended";
    else if (inEntryZone && !passesRs) list = "in_zone_lagging";
    if (list === null) return null;

    const atr14 = computeATR(bars, 14);
    const structural = computeStructuralLevels(q, atr14);
    if (!structural) return null;

    const pctFromHigh = (q.currentPrice - q.week52High) / q.week52High;
    const pctFrom52wLow = (q.currentPrice - q.week52Low) / q.week52Low;
    const vsMA200 = (q.currentPrice - q.ma200) / q.ma200;
    const volumeRatio = q.avgVolume10d > 0 ? q.todayVolume / q.avgVolume10d : 0;

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
      vsMA50: vsMA50Bars,
      vsMA200,
      volumeRatio,
      rr: structural.rr,
      entryPrice: structural.entryPrice,
      targetPrice: structural.targetPrice,
      stopPrice: structural.stopPrice,
      nextEarningsDate: nextEarn?.date ?? null,
      daysToEarnings: daysToEarn,
      insiderTransactions: [],
      insiderSignal: "neutral",
      executiveBuys: [],
      insiderBuyDollars: 0,
      insiderBuyerCount: 0,
      insiderLastBuyDaysAgo: null,
      unusualOptionsActivity: false,
      callVolumeOiRatio: null,
      optionsSignal: "neutral",
      topOptionsStrike: null,
      topOptionsExpiry: null,
      catalystFound: false,
      catalystType: "none",
      catalystDate: null,
      catalystDescription: null,
      catalystConfidence: "none",
      catalystInsiderAngle: null,
      catalystRawResponse: null,
      tier1Signals: [],
      tier2Signals: [],
      redFlags: [],
      signalCount: 0,
      setupScore: 0,
      setupTabs: ["rs_pullback"],
      tabScores: {},
      tabScoreComponents: {},
      tabNarrative: {},
      tabStats: null,
      capitulationStats: null,
      pullbackStats: null,
      atr14,
      adr20Pct,
      sector,
      extensionAdrDays,
      rs20,
      rs60,
      higherLowVsSpy,
      rsPullbackList: list,
      // Row-detail fields — the underlying values behind extensionAdrDays/
      // rs20/rs60/the trend gate, so they're checkable rather than
      // assertions. sma20/sma50AtEntry/sma50TwentySessionsAgo/
      // sma50RisingPct are all bars-derived (same closes array as
      // extensionAdrDays — one consistent SMA50 throughout, see above).
      // No sma200: the 150-day bars window doesn't reach back far enough
      // for a 200-bar SMA — ma200 (Yahoo's point quote) is the only
      // 200-day figure available here, already on the candidate.
      sma20,
      sma50AtEntry: sma50Now,
      sma50TwentySessionsAgo: sma50Ago,
      sma50RisingPct,
      stockReturn20,
      stockReturn60,
      spyReturn20,
      spyReturn60,
      dataQualityDegraded: sectorFailed || earningsFailed,
      dataQualityIssues: [
        ...(sectorFailed ? ["sector_check_failed"] : []),
        ...(earningsFailed ? ["earnings_check_failed"] : []),
      ],
    });
    if (sectorFailed || earningsFailed) degradedCount += 1;
    return null;
  });

  return {
    candidates,
    excludedBySma50Rising,
    insufficientData,
    degradedCount,
    deadlineSkipped,
  };
}

// Real trade geometry, replacing both computeTradeLevels and
// fallbackLevels above for what's actually displayed to the user (those
// two remain as pass-1's cheap pre-filter — see pass1Filter).
//
// Stop: ATR14-primary, not a structural-level switch. Earlier this picked
// the WIDER of an ATR stop and a structural floor that flipped between
// 50MA*0.985 (above the 50d) and 52wLow*0.97 (below it) — a stock 0.1%
// under its 50MA got the 52-week-low anchor, which for a name merely
// pulling back (not actually near its yearly low) sits 15-45% away and
// blew straight through the 15% ceiling. Result: two nearly-identical
// setups a fraction of a percent apart on either side of the 50MA got
// stop distances 4x apart (see the 2026-08-08/09 audit: 13 above-50MA
// candidates averaged 3.8% stop distance; 18 below-50MA candidates
// averaged 14.6%, 15 of them pinned exactly at the ceiling).
//
// Now: stop = 1.5x ATR14 below entry, full stop. Structural levels only
// act as a SANITY FLOOR — if entry is actually resting close to (within
// 3%, either side of) its 50MA or 200MA, the stop isn't allowed to sit
// above that level, since a trade genuinely testing a support needs room
// for that support to hold, not just whatever the volatility math says.
// This only ever widens the ATR stop, and only when price is close to a
// real level — it does not apply as a blanket override the way the old
// binary switch did. atr14 unavailable (e.g. too little daily history for
// a recent IPO) falls back to that same sanity-floor logic, and finally
// to the 52-week low, as the only levels left to anchor on.
//
// Target: the nearer of analyst consensus and real overhead structure
// (52-week high, or a 3x-ATR projection when price is already above its
// 52w high) — never a fixed percentage. A close target is a more
// realistic multi-week swing objective than a distant one. Unchanged by
// this revision.
function computeStructuralLevels(
  q: Pass1Quote,
  atr14: number | null,
): TradeLevels | null {
  const entryPrice = q.currentPrice;
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) return null;

  const nearMA50 = q.ma50 > 0 && Math.abs(entryPrice - q.ma50) / entryPrice <= 0.03;
  const nearMA200 = q.ma200 > 0 && Math.abs(entryPrice - q.ma200) / entryPrice <= 0.03;
  const sanityFloorCandidates = [
    nearMA50 ? q.ma50 * 0.985 : null,
    nearMA200 ? q.ma200 * 0.985 : null,
  ].filter((v): v is number => v !== null && v < entryPrice);
  // The tighter of the two if price is close to both — a real support
  // level is a floor, not an average of floors.
  const sanityFloor =
    sanityFloorCandidates.length > 0 ? Math.max(...sanityFloorCandidates) : null;

  let stopPrice: number;
  if (atr14 !== null && atr14 > 0) {
    const atrStop = entryPrice - 1.5 * atr14;
    // Widen only if the ATR stop would sit above (tighter than) a support
    // level price is actually resting on.
    stopPrice = sanityFloor !== null ? Math.min(atrStop, sanityFloor) : atrStop;
  } else {
    stopPrice = sanityFloor ?? q.week52Low * 0.97;
  }
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
  opts: { forceFresh?: boolean; rsPullbackThresholds?: RsPullbackThresholds } = {},
): Promise<{
  survivors: string[];
  quotes: Map<string, Pass1Quote>;
  trades: Map<string, TradeLevels>;
  tier2ByCandidate: Map<string, string[]>;
  errors: string[];
  capitulation: Record<string, TabStats>;
  pullback: Record<string, TabStats>;
  rsPullback: {
    pregatedCount: number;
    needsEnrichment: string[];
    excludedBySectorPrefilter: number;
    excludedBySma50RisingPrefilter: number;
  };
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

  // RS Pullback pregate — cheap (Pass1Quote-only) check, unioned into
  // survivors below so serializePass1 doesn't strip these symbols'
  // quotes before the real enrichment (bars-derived 50MA-rising, ADR,
  // RS) gets a chance to run in pass 2. Always run with at least the
  // default thresholds even if the caller doesn't pass any, so an older
  // client that doesn't know about this tab still gets correct survivor
  // data for free.
  const rsPullbackThresholds = opts.rsPullbackThresholds ?? DEFAULT_RS_PULLBACK_THRESHOLDS;
  const rsPullbackPregated = pregateRsPullbackSymbols(quotes, rsPullbackThresholds);

  // Cheap, cache-only narrowing (sector + cached-bars 50MA-rising) — runs
  // once here so the client knows exactly which (much smaller) set needs
  // real per-symbol enrichment, and can chunk that set into sequential
  // calls that each safely fit under the 60s ceiling. See
  // applyRsPullbackPrefilter's own comment for why this can only ever
  // narrow, never wrongly include/exclude beyond what cached data proves.
  const rsPullbackPrefilter = await applyRsPullbackPrefilter(
    rsPullbackPregated,
    rsPullbackThresholds,
  );

  // Survivors = union of the legacy funnel (insider/options path), the
  // tab-qualified symbols, and the RS Pullback pregate, so pass 2
  // enriches (and earnings-gates) everything. Tab symbols that didn't
  // clear the legacy R/R funnel get swing-sized fallback levels.
  const survivorSet = new Set<string>(funnelSurvivors);
  for (const sym of [
    ...Object.keys(capitulation),
    ...Object.keys(pullback),
    ...rsPullbackPregated,
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
    rsPullback: {
      pregatedCount: rsPullbackPregated.length,
      needsEnrichment: rsPullbackPrefilter.needsEnrichment,
      excludedBySectorPrefilter: rsPullbackPrefilter.excludedBySectorPrefilter,
      excludedBySma50RisingPrefilter: rsPullbackPrefilter.excludedBySma50RisingPrefilter,
    },
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

export function classifyInsiderTxs(rows: FinnhubInsiderTx[]): {
  transactions: InsiderTransaction[];
  executiveBuys: InsiderTransaction[];
  signal: "strong_bullish" | "bullish" | "neutral" | "bearish";
} {
  // An option exercise reports as TWO Finnhub rows for the same event:
  // a derivative leg (isDerivative: true, transactionPrice: 0 — the
  // option being extinguished, a bookkeeping placeholder with no real
  // dollar value) and a non-derivative leg (the actual shares acquired,
  // with a real price). Both carry the same transactionCode, so
  // without this filter the $0 placeholder sits in the display
  // alongside — or ahead of, crowding out of the 8-row cap — its
  // real-value sibling. Dropped before mapping so nothing downstream
  // (display, executiveBuys, buy/sell sums) ever sees the placeholder.
  const nonDerivative = rows.filter((r) => r.isDerivative !== true);

  // Direction comes from `change` (signed delta), not `share` (total post-tx
  // holdings — always positive). `Math.abs(change)` is the actual transaction
  // size in shares.
  const transactions: InsiderTransaction[] = nonDerivative.map((r) => {
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
  // buildNarrative is never called for rs_pullback candidates (see
  // computeRsPullbackCandidates — they're built independently of the
  // tabScores/buildNarrative machinery) — entry present only to satisfy
  // Record<SetupTab, string> exhaustiveness.
  rs_pullback: "RS pullback",
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
    case "rs_pullback":
      // Unreachable — buildNarrative is never invoked for rs_pullback
      // candidates (see computeRsPullbackCandidates). Present only so
      // this switch stays exhaustive over SetupTab.
      return `${n.symbol} — RS pullback (no narrative generated for this tab).`;
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
      insiderRows = await getFinnhubInsiderTransactions(symbol, 90, { forceFresh });
    } catch {
      insiderRows = [];
    }
    await sleep(200);
    try {
      nextEarn = await getFinnhubNextEarningsDate(symbol, { forceFresh });
    } catch {
      nextEarn = null;
    }

    // Schwab options, ATR/ADR history, and sector hit different
    // hosts/tables — run concurrently.
    // Schwab (options chain) is never cached — force-fresh or not, this
    // is always a live fetch.
    const [optionsChain, { atr14, adr20Pct }, sector] = await Promise.all([
      schwabAvailable
        ? getCallOptionsChainRange(symbol, fromIso, toIso).catch((e) => {
            const msg = e instanceof Error ? e.message : String(e);
            console.warn(`[swing-screener] schwab calls(${symbol}) failed: ${msg}`);
            return null;
          })
        : Promise.resolve(null),
      fetchAtrAndAdr(symbol, { forceFresh }),
      getOrFetchSector(symbol)
        .then((r) => r.sector)
        .catch(() => null),
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
      adr20Pct,
      sector,
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
  rsPullback: {
    pregatedCount: number;
    needsEnrichment: string[];
    excludedBySectorPrefilter: number;
    excludedBySma50RisingPrefilter: number;
  };
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
    rsPullback: result.rsPullback,
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

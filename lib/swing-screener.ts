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
};

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
  tabStats: TabStats | null;
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
function computeTabStats(
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

  return {
    redDayCount,
    move5dPct,
    rsi14: snap.rsi14,
    sma20: snap.sma20,
    return3m: snap.return_3m,
    return1y: snap.return_1y,
  };
}

// TAB 1 — CAPITULATION: 3+ consecutive red days (today counts
// intraday), 5d cumulative worse than -12%, RSI14 < 40. Mirrors the
// manual ThinkorSwim scan (3 red / -15% in 5d) slightly loosened.
function qualifiesCapitulation(stats: TabStats): boolean {
  return (
    stats.redDayCount >= 3 &&
    stats.move5dPct <= -0.12 &&
    stats.rsi14 !== null &&
    stats.rsi14 < 40
  );
}

// TAB 2 — PULLBACK TO TREND: uptrend intact (above 200d, positive 3m
// return), price within ~3% of the 50d SMA or sitting between the 20d
// and 50d, and an orderly 5-12% pullback from the recent high.
function qualifiesPullback(stats: TabStats, q: Pass1Quote): boolean {
  if (q.currentPrice <= q.ma200) return false;
  if (stats.return3m === null || stats.return3m <= 0) return false;
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

// Severity ranking for capitulation: deeper selloff + lower RSI +
// larger cap ranks higher; elevated volume = seller-exhaustion bonus.
export function scoreCapitulation(stats: TabStats, q: Pass1Quote): number {
  const depth = Math.min(4, (Math.abs(stats.move5dPct) * 100 - 12) * 0.5);
  const rsi = stats.rsi14 !== null ? Math.min(3, (40 - stats.rsi14) * 0.15) : 0;
  const cap =
    q.marketCap >= 100e9 ? 2 : q.marketCap >= 10e9 ? 1.5 : q.marketCap >= 2e9 ? 1 : 0;
  const volumeRatio = q.avgVolume10d > 0 ? q.todayVolume / q.avgVolume10d : 0;
  const vol = volumeRatio > 1.5 ? 1 : 0;
  return Math.min(10, Math.round(depth + rsi + cap + vol));
}

// Trend-quality ranking for pullback: stronger 3m/1y returns + tighter
// pullback to the 50d ranks higher.
export function scorePullback(stats: TabStats, q: Pass1Quote): number {
  const r3 = stats.return3m ?? 0;
  const r1y = stats.return1y ?? 0;
  const vsMA50 = Math.abs((q.currentPrice - q.ma50) / q.ma50);
  const pctFromHigh = (q.currentPrice - q.week52High) / q.week52High;
  const trend3m = r3 >= 20 ? 3 : r3 >= 10 ? 2 : 1;
  const trend1y = r1y >= 30 ? 2 : r1y >= 10 ? 1 : 0;
  const tight = vsMA50 <= 0.01 ? 3 : vsMA50 <= 0.02 ? 2 : 1;
  const orderly = pctFromHigh >= -0.08 ? 2 : 1;
  return Math.min(10, Math.round(trend3m + trend1y + tight + orderly));
}

// Levels for tab candidates that don't clear the legacy R/R funnel —
// swing-sized stop/target anchored to the live price instead of the
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

export async function pass1Filter(symbols: string[]): Promise<{
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
  const quotes = new Map<string, Pass1Quote>();

  // Step 1: bulk yahoo quote in batches of 20 with 200ms gaps.
  const BATCH = 20;
  for (let i = 0; i < symbols.length; i += BATCH) {
    const batch = symbols.slice(i, i + BATCH);
    const results = await Promise.all(batch.map((s) => fetchYahooQuote(s)));
    for (let j = 0; j < batch.length; j += 1) {
      const q = results[j];
      if (!q) {
        errors.push(`yahoo-quote:${batch[j]}`);
        continue;
      }
      quotes.set(q.symbol, q);
    }
    if (i + BATCH < symbols.length) await sleep(200);
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

// Insider conviction (0-10): open-market purchase dollars + number of
// distinct buyers + recency of the latest buy.
export function scoreInsiderConviction(
  transactions: InsiderTransaction[],
): number {
  const buys = transactions.filter((t) => t.transactionCode === "P");
  if (buys.length === 0) return 0;
  const dollars = buys.reduce((s, t) => s + t.dollarValue, 0);
  const distinct = new Set(buys.map((t) => t.name)).size;
  let newestDays: number | null = null;
  for (const t of buys) {
    const d = t.date ? daysFromTodayUtc(t.date) : null;
    if (d === null) continue;
    const age = -d; // past dates are negative days-ahead
    if (newestDays === null || age < newestDays) newestDays = age;
  }
  const size =
    dollars >= 1_000_000 ? 4 : dollars >= 250_000 ? 3 : dollars >= 100_000 ? 2 : 1;
  const breadth = distinct >= 3 ? 3 : distinct === 2 ? 2 : 1;
  const recency =
    newestDays !== null && newestDays <= 7
      ? 3
      : newestDays !== null && newestDays <= 14
        ? 2
        : newestDays !== null && newestDays <= 30
          ? 1
          : 0;
  return Math.min(10, size + breadth + recency);
}

// Options-flow aggressiveness (0-10): vol/OI ratio of the hottest call
// strike + how far OTM the money is positioned + total-flow context.
export function scoreOptionsFlow(
  opts: OptionsAnalysis,
  q: Pass1Quote,
): number {
  const ratio = opts.callVolumeOiRatio ?? 0;
  const ratioPts =
    ratio >= 3 ? 5 : ratio >= 2 ? 4 : ratio >= 1 ? 3 : ratio >= 0.5 ? 2 : 1;
  const strike = opts.topOptionsStrike;
  const skewPts =
    strike !== null && strike > q.currentPrice * 1.05
      ? 2
      : strike !== null && strike > q.currentPrice
        ? 1
        : 0;
  const volumeRatio = q.avgVolume10d > 0 ? q.todayVolume / q.avgVolume10d : 0;
  const volPts = volumeRatio > 1.5 ? 1 : 0;
  return Math.min(10, ratioPts + skewPts + volPts);
}

// Insider tab technical sanity gate: insider buying in a collapsing
// stock is averaging-down, not a swing setup.
const INSIDER_FREEFALL_VS_MA200 = -0.25;

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
): Promise<SwingCandidate[]> {
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
      insiderRows = await getFinnhubInsiderTransactions(symbol, 45);
    } catch {
      insiderRows = [];
    }
    await sleep(200);
    try {
      nextEarn = await getFinnhubNextEarningsDate(symbol);
    } catch {
      nextEarn = null;
    }

    let optionsChain: SchwabOptionsChain | null = null;
    if (schwabAvailable) {
      try {
        optionsChain = await getCallOptionsChainRange(symbol, fromIso, toIso);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`[swing-screener] schwab calls(${symbol}) failed: ${msg}`);
        optionsChain = null;
      }
    }

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
    const setupTabs: SetupTab[] = [];
    const tabScores: Partial<Record<SetupTab, number>> = {};
    const capStats = tabInfo.capitulation[symbol] ?? null;
    const pullStats = tabInfo.pullback[symbol] ?? null;
    if (capStats) {
      setupTabs.push("capitulation");
      tabScores.capitulation = scoreCapitulation(capStats, q);
    }
    if (pullStats) {
      setupTabs.push("pullback");
      tabScores.pullback = scorePullback(pullStats, q);
    }
    if (
      tier1Signals.includes("INSIDER_BUYING") &&
      vsMA200 > INSIDER_FREEFALL_VS_MA200
    ) {
      setupTabs.push("insider");
      tabScores.insider = scoreInsiderConviction(insider.transactions);
    }
    if (opts.unusualOptionsActivity) {
      setupTabs.push("options_flow");
      tabScores.options_flow = scoreOptionsFlow(opts, q);
    }
    if (setupTabs.length === 0) return null;

    // Score (out of 10). Catalyst points (+2/+1/0) are added in pass 3.
    //   +2 strong_bullish insider (P-code purchase >$100K)
    //   +1 bullish insider (net P buyer, no $100K trade)
    //   +2 unusual options activity (was +1; promoted now that earnings
    //      no longer occupies the +2 slot)
    //   +1 volume spike (>2x avg + price up)
    //   +1 R/R >= 3.0
    //   +1 short float >15% (squeeze potential)
    //   +1 within ±2% of 50d MA
    let setupScore = 0;
    if (insider.signal === "strong_bullish") setupScore += 2;
    else if (insider.signal === "bullish") setupScore += 1;
    if (opts.unusualOptionsActivity) setupScore += 2;
    if (volumeRatio > 2.0 && q.priceChange1d > 0) setupScore += 1;
    if (tl.rr >= 3.0) setupScore += 1;
    if (q.shortPercentFloat !== null && q.shortPercentFloat > 0.15) setupScore += 1;
    if (vsMA50 >= -0.02 && vsMA50 <= 0.02) setupScore += 1;
    setupScore = Math.min(10, setupScore);
    // Pure capitulation/pullback candidates have no tier-1 signals, so
    // the legacy additive score would read ~0 — the overall score is
    // the best of (legacy additive, best tab score).
    const bestTabScore = Math.max(0, ...Object.values(tabScores));
    setupScore = Math.min(10, Math.max(setupScore, bestTabScore));

    const tier2Signals = tier2ByCandidate.get(symbol) ?? [];

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
      rr: tl.rr,
      entryPrice: tl.entryPrice,
      targetPrice: tl.targetPrice,
      stopPrice: tl.stopPrice,
      nextEarningsDate: nextEarn?.date ?? null,
      daysToEarnings: daysToEarn,
      insiderTransactions: insider.transactions,
      insiderSignal: insider.signal,
      executiveBuys: insider.executiveBuys,
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
      tabStats: capStats ?? pullStats,
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

  // Re-score with catalyst points: +2 high, +1 medium, +0 low/none.
  // Cap at 10. NOTE: pass 3 only ENRICHES — every candidate that made
  // it through pass 2's tier-1 filter must remain in the result set,
  // regardless of whether Perplexity found a specific catalyst. No
  // candidate is filtered out here, no points are subtracted, and a
  // missing catalyst never reduces a stock's setupScore below what
  // pass 2 produced.
  return out.map((c) => {
    const bonus =
      c.catalystConfidence === "high"
        ? 2
        : c.catalystConfidence === "medium"
          ? 1
          : 0;
    return {
      ...c,
      setupScore: Math.min(10, c.setupScore + bonus),
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

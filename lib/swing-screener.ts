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

export type CatalystType =
  | "product_launch"
  | "fda_decision"
  | "contract_award"
  | "rate_decision"
  | "partnership"
  | "regulatory"
  | "analyst_upgrade"
  | "restructuring"
  | "other"
  | "none";

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
  catalystRawResponse: string | null;

  // Display
  tier1Signals: string[];
  tier2Signals: string[];
  redFlags: string[];

  signalCount: number;
  setupScore: number;
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

// ---------- Pass 1 ----------

export async function pass1Filter(symbols: string[]): Promise<{
  survivors: string[];
  quotes: Map<string, Pass1Quote>;
  trades: Map<string, TradeLevels>;
  tier2ByCandidate: Map<string, string[]>;
  errors: string[];
}> {
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
  const survivors: string[] = [];
  for (const q of techSurvivors) {
    if (q.numAnalysts < 3) continue;
    if (q.revenueGrowth !== null && q.revenueGrowth < -0.2) continue;
    if (q.shortPercentFloat !== null && q.shortPercentFloat > 0.4) continue;
    survivors.push(q.symbol);
  }

  return { survivors, quotes, trades, tier2ByCandidate, errors };
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

// ---------- Pass 2 ----------

export async function pass2Enrich(
  symbols: string[],
  pass1Data: Map<string, Pass1Quote>,
  trades: Map<string, ReturnType<typeof computeTradeLevels>>,
  tier2ByCandidate: Map<string, string[]>,
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

  await mapWithConcurrency(symbols, 5, async (symbol) => {
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

    if (redFlags.includes("EARNINGS_TOO_SOON")) return null;
    if (tier1Signals.length === 0) return null;

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
      catalystRawResponse: null,
      tier1Signals,
      tier2Signals,
      redFlags,
      signalCount: tier1Signals.length,
      setupScore,
    });
    return null;
  });

  candidates.sort((a, b) => b.setupScore - a.setupScore);
  return candidates;
}

// ---------- Pass 3: catalyst discovery ----------

import { askPerplexityRaw } from "./perplexity";

const VALID_CATALYST_TYPES: ReadonlyArray<CatalystType> = [
  "product_launch",
  "fda_decision",
  "contract_award",
  "rate_decision",
  "partnership",
  "regulatory",
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
  return `Research ${symbol} (${companyName}).

Find SPECIFIC upcoming catalysts in the next 30-90 days that could cause a significant price move.

Look for:
- Product launches or major releases
- FDA drug approval decisions (PDUFA dates)
- Government contract awards or decisions
- Federal Reserve or macro policy decisions that directly impact this company
- Major partnership or licensing announcements
- Regulatory approvals or decisions
- Analyst day or investor day events
- Index inclusion decisions
- Activist investor campaigns
- M&A or strategic review announcements

Do NOT count:
- Regular quarterly earnings (not a catalyst)
- Normal dividend payments
- Vague "momentum" or "market conditions"
- Generic analyst upgrades without specific trigger

If a specific catalyst exists, be precise: What is it? When exactly? What's the expected impact?

Return ONLY this JSON, no markdown:
{
  "catalyst_found": true/false,
  "catalyst_type": "product_launch|fda_decision|contract_award|rate_decision|partnership|regulatory|analyst_upgrade|restructuring|other|none",
  "catalyst_date": "YYYY-MM-DD or null if unknown",
  "catalyst_description": "one specific sentence describing the catalyst and expected timeline, or null if none found",
  "catalyst_confidence": "high|medium|low|none",
  "reasoning": "one sentence on why this is or isn't a real near-term catalyst"
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
  const dateRaw = parsed.catalyst_date;
  const date =
    typeof dateRaw === "string" && /^\d{4}-\d{2}-\d{2}$/.test(dateRaw)
      ? dateRaw
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
  out.catalystFound = found;
  out.catalystType = found ? type : "none";
  out.catalystDate = date;
  out.catalystDescription = desc;
  out.catalystConfidence = found ? confidence : "none";
  return out;
}

export async function pass3CatalystDiscovery(
  candidates: SwingCandidate[],
): Promise<SwingCandidate[]> {
  if (candidates.length === 0) return [];
  // Process in fixed-size batches with a 500ms inter-batch gap so we don't
  // burst the Perplexity rate limit. Concurrency 3 = 3 simultaneous calls;
  // 5-15 candidates × ~3s = well under the 60s pass-2 ceiling.
  const BATCH = 3;
  const out: SwingCandidate[] = new Array(candidates.length);
  for (let i = 0; i < candidates.length; i += BATCH) {
    const batch = candidates.slice(i, i + BATCH);
    const results = await Promise.all(
      batch.map(async (c) => {
        try {
          const raw = await askPerplexityRaw(
            buildCatalystPrompt(c.symbol, c.companyName),
            { label: `catalyst:${c.symbol}`, maxTokens: 600 },
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
      out[i + j] = results[j];
    }
    if (i + BATCH < candidates.length) await sleep(500);
  }

  // Re-score with catalyst points: +2 high, +1 medium, +0 low/none.
  // Cap at 10 — same total ceiling as before.
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
  const p2 = await pass2Enrich(p1.survivors, p1.quotes, p1.trades, p1.tier2ByCandidate);
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

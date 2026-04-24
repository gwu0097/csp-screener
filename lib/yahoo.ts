// All yahoo-finance2 access goes through this module. A single failed symbol
// must never throw out — every public function catches and returns a safe
// default (null / [] / undefined) so the screener loop keeps running across
// the remaining candidates.
//
// IMPORTANT: the correct yahoo-finance2 usage in Next.js serverless is the
// default import. Do NOT `new YahooFinance()`. Do NOT `require()`. Every call
// must pass `{ validateResult: false }` as the module-options argument so Yahoo
// payload drift does not trip the library's Zod validator.

import YahooFinance from "yahoo-finance2";
import { getFinnhubEarningsPeriods } from "./earnings";

// yahoo-finance2 v3 changed the default export from a pre-instantiated client
// to the class itself. Calling methods on the class throws
// "Call `const yahooFinance = new YahooFinance()` first." — instantiate once.
const yahooFinance = new (YahooFinance as unknown as new () => Record<string, unknown>)();

try {
  (yahooFinance as unknown as { suppressNotices?: (keys: string[]) => void }).suppressNotices?.([
    "yahooSurvey",
  ]);
} catch {
  // Non-fatal — the notice banner is cosmetic.
}

// Passed as the third argument to every yahoo-finance2 call.
const MODULE_OPTS = { validateResult: false } as const;

// ---------- Types ----------

export type EarningsMove = {
  date: string;
  actualMovePct: number;
  direction: "up" | "down" | "flat";
};

type MinimalQuote = { regularMarketPrice?: number; marketCap?: number };

type HistoricalRow = {
  date: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

type QuoteSummaryResult = {
  earningsHistory?: { history?: Array<{ quarter?: string | number | Date }> };
  assetProfile?: { sector?: string; industry?: string };
  summaryProfile?: { sector?: string; industry?: string };
  summaryDetail?: { marketCap?: number };
  price?: { marketCap?: number };
  earnings?: {
    earningsChart?: {
      quarterly?: Array<{
        date?: string;
        periodEndDate?: number;
        reportedDate?: number; // unix seconds — the actual announcement timestamp
      }>;
    };
  };
};

export type YahooProfile = {
  sector: string | null;
  industry: string | null;
  marketCap: number | null;
};

type RawQuote = Record<string, unknown>;

// ---------- Typed façades over yahoo-finance2 ----------
// Methods must be called on the instance so `this` binds correctly. Pulling
// them off into a local variable drops `this` and breaks internal _notices.

type YFClient = {
  quote: (
    s: string,
    q?: Record<string, unknown>,
    m?: { validateResult?: boolean },
  ) => Promise<unknown>;
  historical: (
    s: string,
    opts: { period1: Date; period2: Date; interval: "1d" },
    m?: { validateResult?: boolean },
  ) => Promise<HistoricalRow[]>;
  quoteSummary: (
    s: string,
    opts: { modules: string[] },
    m?: { validateResult?: boolean },
  ) => Promise<QuoteSummaryResult>;
  search: (
    s: string,
    opts: { newsCount?: number; quotesCount?: number },
    m?: { validateResult?: boolean },
  ) => Promise<unknown>;
};

const yf = yahooFinance as unknown as YFClient;

function logYahooFailure(label: string, e: unknown): void {
  const msg = e instanceof Error ? e.message : String(e);
  console.warn(`[yahoo] ${label} failed: ${msg}`);
}

// ---------- Raw quote ----------

async function quoteRaw(symbol: string): Promise<RawQuote | null> {
  try {
    const result = await yf.quote(symbol, {}, MODULE_OPTS);
    if (result === null || result === undefined) {
      console.warn(`[yahoo] quote(${symbol}) returned ${result === null ? "null" : "undefined"}`);
      return null;
    }
    const record = (Array.isArray(result) ? result[0] : result) as RawQuote | null | undefined;
    if (!record) {
      console.warn(
        `[yahoo] quote(${symbol}) returned empty ${Array.isArray(result) ? "array" : "object"}`,
      );
      return null;
    }
    return record;
  } catch (e) {
    logYahooFailure(`quote(${symbol})`, e);
    return null;
  }
}

function pickNumber(obj: RawQuote, key: string): number | null {
  const v = obj[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function pickString(obj: RawQuote, key: string): string | null {
  const v = obj[key];
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

async function quoteMinimal(symbol: string): Promise<MinimalQuote | null> {
  const record = await quoteRaw(symbol);
  if (!record) return null;
  return {
    regularMarketPrice: pickNumber(record, "regularMarketPrice") ?? undefined,
    marketCap: pickNumber(record, "marketCap") ?? undefined,
  };
}

// ---------- Multi-field quote enrichment (swing discover) ----------

export type QuoteEnrichment = {
  regularMarketPrice: number | null;
  fiftyTwoWeekLow: number | null;
  fiftyTwoWeekHigh: number | null;
  forwardPE: number | null;
  targetMeanPrice: number | null;
  regularMarketChangePercent: number | null;
  fiftyDayAverage: number | null;
  twoHundredDayAverage: number | null;
  marketCap: number | null;
  companyName: string | null;
};

// Single quote pull for the swing discover flow — price + 52-week range
// + fundamentals + today's change %. Yahoo exposes all of these on the
// default v7 quote payload, so one call is enough. Returns null on
// failure; callers decide whether to skip the symbol or render a stub.
export async function getQuoteEnrichment(
  symbol: string,
): Promise<QuoteEnrichment | null> {
  const record = await quoteRaw(symbol);
  if (!record) return null;
  return {
    regularMarketPrice: pickNumber(record, "regularMarketPrice"),
    fiftyTwoWeekLow: pickNumber(record, "fiftyTwoWeekLow"),
    fiftyTwoWeekHigh: pickNumber(record, "fiftyTwoWeekHigh"),
    forwardPE: pickNumber(record, "forwardPE"),
    targetMeanPrice: pickNumber(record, "targetMeanPrice"),
    regularMarketChangePercent: pickNumber(record, "regularMarketChangePercent"),
    fiftyDayAverage: pickNumber(record, "fiftyDayAverage"),
    twoHundredDayAverage: pickNumber(record, "twoHundredDayAverage"),
    marketCap: pickNumber(record, "marketCap"),
    companyName: pickString(record, "shortName") ?? pickString(record, "longName"),
  };
}

// ---------- Research snapshot (Deep Dive) ----------

// Used by /api/swings/discover/research. Pulled via quoteSummary so
// fields like analyst recommendations + ownership are reliable. Kept
// separate from getQuoteEnrichment because the bulk-scan path doesn't
// need them and a quoteSummary call is heavier than a plain quote.
export type ResearchSnapshot = {
  revenueGrowth: number | null;
  earningsGrowth: number | null;
  numberOfAnalystOpinions: number | null;
  recommendationMean: number | null;
  recommendationKey: string | null;
  targetHighPrice: number | null;
  targetLowPrice: number | null;
  targetMeanPrice: number | null;
  heldPercentInsiders: number | null;
  heldPercentInstitutions: number | null;
  shortPercentOfFloat: number | null;
  trailingEps: number | null;
  forwardEps: number | null;
};

// yahoo-finance2 sometimes returns numbers wrapped as { raw, fmt }.
// Unwrap defensively before coercing.
function unwrapNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (v && typeof v === "object" && "raw" in (v as Record<string, unknown>)) {
    const raw = (v as { raw?: unknown }).raw;
    if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  }
  return null;
}

function unwrapString(v: unknown): string | null {
  if (typeof v === "string" && v.trim().length > 0) return v.trim();
  return null;
}

export async function getResearchSnapshot(
  symbol: string,
): Promise<ResearchSnapshot | null> {
  try {
    const result = await yf.quoteSummary(
      symbol,
      { modules: ["financialData", "defaultKeyStatistics"] },
      MODULE_OPTS,
    );
    const r = result as unknown as Record<string, unknown>;
    const fd = (r.financialData ?? {}) as Record<string, unknown>;
    const dks = (r.defaultKeyStatistics ?? {}) as Record<string, unknown>;
    return {
      revenueGrowth: unwrapNumber(fd.revenueGrowth),
      earningsGrowth: unwrapNumber(fd.earningsGrowth),
      numberOfAnalystOpinions: unwrapNumber(fd.numberOfAnalystOpinions),
      recommendationMean: unwrapNumber(fd.recommendationMean),
      recommendationKey: unwrapString(fd.recommendationKey),
      targetHighPrice: unwrapNumber(fd.targetHighPrice),
      targetLowPrice: unwrapNumber(fd.targetLowPrice),
      targetMeanPrice: unwrapNumber(fd.targetMeanPrice),
      heldPercentInsiders: unwrapNumber(dks.heldPercentInsiders),
      heldPercentInstitutions: unwrapNumber(dks.heldPercentInstitutions),
      shortPercentOfFloat: unwrapNumber(dks.shortPercentOfFloat),
      trailingEps: unwrapNumber(dks.trailingEps),
      forwardEps: unwrapNumber(dks.forwardEps),
    };
  } catch (e) {
    logYahooFailure(`research(${symbol})`, e);
    return null;
  }
}

// ---------- News search ----------

export type YahooNewsItem = {
  title: string;
  link: string;
  publisher: string;
  publishedAt: number; // unix seconds
};

// yahoo-finance2's search endpoint returns both `news` and `quotes`
// items; we only want news for the research panel.
export async function getYahooNews(
  symbol: string,
  count = 7,
): Promise<YahooNewsItem[]> {
  try {
    const result = await yf.search(
      symbol,
      { newsCount: count, quotesCount: 0 },
      MODULE_OPTS,
    );
    const news = (result as { news?: unknown }).news;
    if (!Array.isArray(news)) return [];
    return (news as Array<Record<string, unknown>>)
      .map((n) => ({
        title: typeof n.title === "string" ? n.title : "",
        link: typeof n.link === "string" ? n.link : "",
        publisher: typeof n.publisher === "string" ? n.publisher : "",
        publishedAt:
          typeof n.providerPublishTime === "number"
            ? (n.providerPublishTime as number)
            : 0,
      }))
      .filter((n) => n.title.length > 0 && n.link.length > 0);
  } catch (e) {
    logYahooFailure(`search(${symbol})`, e);
    return [];
  }
}

export async function getCurrentPrice(symbol: string): Promise<number | null> {
  try {
    const record = await quoteRaw(symbol);
    if (!record) return null;

    const priceFields = [
      "regularMarketPrice",
      "postMarketPrice",
      "preMarketPrice",
      "regularMarketPreviousClose",
      "bid",
      "ask",
    ] as const;
    for (const field of priceFields) {
      const v = pickNumber(record, field);
      if (v !== null && v > 0) {
        if (field !== "regularMarketPrice") {
          console.warn(`[yahoo] getCurrentPrice(${symbol}) fell back to ${field}=${v}`);
        }
        return v;
      }
    }

    console.warn(
      `[yahoo] getCurrentPrice(${symbol}) no usable price field. Top-level keys:`,
      Object.keys(record),
    );
    const debug: Record<string, unknown> = {};
    for (const key of [
      "symbol",
      "quoteType",
      "marketState",
      "regularMarketPrice",
      "regularMarketPreviousClose",
      "postMarketPrice",
      "preMarketPrice",
      "bid",
      "ask",
      "marketCap",
      "currency",
      "exchange",
      "quoteSourceName",
    ]) {
      debug[key] = record[key];
    }
    console.warn(`[yahoo] quote(${symbol}) debug fields:`, debug);
    return null;
  } catch (e) {
    logYahooFailure(`getCurrentPrice(${symbol})`, e);
    return null;
  }
}

// Debug-only: returns the raw quote record plus which price field was picked.
// Used by lib/price.ts to log detailed info for the first few symbols on a run
// when Yahoo appears to be returning 0 for everything.
export async function getPriceDebug(symbol: string): Promise<{
  price: number | null;
  fieldUsed: string | null;
  raw: Record<string, unknown> | null;
}> {
  const record = await quoteRaw(symbol);
  if (!record) return { price: null, fieldUsed: null, raw: null };
  const priceFields = [
    "regularMarketPrice",
    "postMarketPrice",
    "preMarketPrice",
    "regularMarketPreviousClose",
    "bid",
    "ask",
  ] as const;
  for (const field of priceFields) {
    const v = pickNumber(record, field);
    if (v !== null && v > 0) return { price: v, fieldUsed: field, raw: record };
  }
  return { price: null, fieldUsed: null, raw: record };
}

export async function getMarketCap(symbol: string): Promise<number | null> {
  try {
    const q = await quoteMinimal(symbol);
    return q?.marketCap ?? null;
  } catch (e) {
    logYahooFailure(`getMarketCap(${symbol})`, e);
    return null;
  }
}

// ---------- Historical bars ----------

export async function getHistoricalPrices(
  symbol: string,
  from: Date,
  to: Date,
): Promise<HistoricalRow[]> {
  try {
    const rows = await yf.historical(
      symbol,
      { period1: from, period2: to, interval: "1d" },
      MODULE_OPTS,
    );
    return Array.isArray(rows) ? rows : [];
  } catch (e) {
    logYahooFailure(`historical(${symbol})`, e);
    return [];
  }
}

// ---------- Quote summary ----------

async function quoteSummary(symbol: string, modules: string[]): Promise<QuoteSummaryResult | null> {
  try {
    const res = await yf.quoteSummary(symbol, { modules }, MODULE_OPTS);
    return res ?? null;
  } catch (e) {
    logYahooFailure(`quoteSummary(${symbol}, [${modules.join(",")}])`, e);
    return null;
  }
}

export async function getCompanyProfile(symbol: string): Promise<YahooProfile | null> {
  try {
    const summary = await quoteSummary(symbol, [
      "assetProfile",
      "summaryProfile",
      "summaryDetail",
      "price",
    ]);
    if (!summary) return null;
    const sector = summary.assetProfile?.sector ?? summary.summaryProfile?.sector ?? null;
    const industry = summary.assetProfile?.industry ?? summary.summaryProfile?.industry ?? null;
    const marketCap = summary.summaryDetail?.marketCap ?? summary.price?.marketCap ?? null;
    if (!sector && !industry && !marketCap) return null;
    return { sector, industry, marketCap };
  } catch (e) {
    logYahooFailure(`getCompanyProfile(${symbol})`, e);
    return null;
  }
}

// yahoo-finance2 sometimes unwraps { raw, fmt } objects into the raw value,
// sometimes not. Accept every shape we've seen in the wild.
function parseYahooDate(v: unknown): Date | null {
  if (v == null) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v === "string") {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof v === "number") {
    const ms = v < 1e12 ? v * 1000 : v; // treat small numbers as unix seconds
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof v === "object") {
    const obj = v as { raw?: unknown; fmt?: unknown };
    if (typeof obj.raw === "number") {
      const ms = obj.raw < 1e12 ? obj.raw * 1000 : obj.raw;
      const d = new Date(ms);
      if (!Number.isNaN(d.getTime())) return d;
    }
    if (typeof obj.raw === "string") {
      const d = new Date(obj.raw);
      if (!Number.isNaN(d.getTime())) return d;
    }
    if (typeof obj.fmt === "string") {
      const d = new Date(obj.fmt);
      if (!Number.isNaN(d.getTime())) return d;
    }
  }
  return null;
}

// Retained for debugging only — getHistoricalEarningsMovements now sources
// dates from Finnhub since yahoo-finance2's earningsHistory module was
// returning empty payloads in production.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function getPastEarningsDates(symbol: string): Promise<Date[]> {
  try {
    const summary = await quoteSummary(symbol, ["earningsHistory"]);
    const history = summary?.earningsHistory?.history ?? [];
    if (history.length > 0) {
      const sample = history[0]?.quarter;
      console.log(
        `[yahoo] getPastEarningsDates(${symbol}) history length=${history.length} sample.quarter type=${typeof sample} value=${JSON.stringify(sample)}`,
      );
    } else {
      console.warn(`[yahoo] getPastEarningsDates(${symbol}) earningsHistory.history is empty or missing`);
    }
    const parsed = history
      .map((h) => parseYahooDate(h?.quarter))
      .filter((d): d is Date => d !== null)
      .filter((d) => d.getTime() < Date.now())
      .sort((a, b) => b.getTime() - a.getTime())
      .slice(0, 8);
    console.log(
      `[yahoo] getPastEarningsDates(${symbol}) parsed ${parsed.length} valid dates: ${parsed.map((d) => d.toISOString().slice(0, 10)).join(", ")}`,
    );
    return parsed;
  } catch (e) {
    logYahooFailure(`getPastEarningsDates(${symbol})`, e);
    return [];
  }
}

// Fetch past earnings ANNOUNCEMENT timestamps from Yahoo's `earnings` module
// (earningsChart.quarterly[].reportedDate, unix seconds). This is the real
// press-release moment, not the fiscal quarter end. Finnhub's
// /calendar/earnings is forward-only on the free tier, so we don't use it.
type Announcement = { tsMs: number; iso: string };

async function getYahooPastAnnouncements(symbol: string): Promise<Announcement[]> {
  const summary = await quoteSummary(symbol, ["earnings"]);
  const quarterly = summary?.earnings?.earningsChart?.quarterly ?? [];
  const announcements = quarterly
    .map<Announcement | null>((q) => {
      const rd = q?.reportedDate;
      if (typeof rd !== "number" || rd <= 0) return null;
      const tsMs = rd < 1e12 ? rd * 1000 : rd;
      if (!Number.isFinite(tsMs)) return null;
      return { tsMs, iso: new Date(tsMs).toISOString().slice(0, 10) };
    })
    .filter((x): x is Announcement => x !== null)
    .filter((x) => x.tsMs < Date.now())
    .sort((a, b) => b.tsMs - a.tsMs)
    .slice(0, 8);
  console.log(
    `[yahoo-earnings] getYahooPastAnnouncements(${symbol}) quarters=${quarterly.length} kept=${announcements.length}: ${announcements.map((a) => a.iso).join(", ")}`,
  );
  return announcements;
}

// Largest single-session overnight gap between consecutive bars whose
// "open-after" bar falls inside [startMs, endMs]. Used to locate an earnings
// announcement when we only know the fiscal quarter end, not the press date.
function findLargestOvernightGap(
  bars: HistoricalRow[],
  startMs: number,
  endMs: number,
): { closeBar: HistoricalRow; openBar: HistoricalRow; pct: number } | null {
  let best: { closeBar: HistoricalRow; openBar: HistoricalRow; pct: number } | null = null;
  for (let i = 1; i < bars.length; i++) {
    const prev = bars[i - 1];
    const cur = bars[i];
    const t = cur.date.getTime();
    if (t < startMs || t > endMs) continue;
    if (!(prev.close > 0) || !Number.isFinite(cur.open)) continue;
    const pct = (cur.open - prev.close) / prev.close;
    if (!best || Math.abs(pct) > Math.abs(best.pct)) {
      best = { closeBar: prev, openBar: cur, pct };
    }
  }
  return best;
}

// Historical overnight earnings moves. Yahoo returns bar.date at the market
// OPEN time (13:30 UTC in summer, 14:30 UTC in winter — i.e. 9:30 ET), not at
// midnight. Session close is bar.date + 6.5h.
//
// Comparison is done against the actual announcement unix timestamp so
// timezone/BMO/AMC/DMH falls out naturally:
//   close-before = last bar where bar.date + 6.5h < announcementTs
//                  (i.e. bar's session closed before the announcement)
//   open-after   = first bar where bar.date > announcementTs
//                  (i.e. bar's session opened after the announcement)
//
// When Yahoo's `earnings` module returns fewer than 3 quarters (thin coverage
// on some tickers), we fall back to Finnhub /stock/earnings for additional
// fiscal quarter-end dates and infer each announcement by scanning for the
// largest overnight gap in the 2-6 week window after quarter end.
export async function getHistoricalEarningsMovements(symbol: string): Promise<EarningsMove[]> {
  try {
    const yahooAnnouncements = await getYahooPastAnnouncements(symbol);

    const DAY_MS = 24 * 60 * 60 * 1000;
    let finnhubPeriods: string[] = [];
    if (yahooAnnouncements.length < 3) {
      console.log(
        `[moves:${symbol}] Yahoo returned ${yahooAnnouncements.length} quarters (<3) — attempting Finnhub /stock/earnings fallback`,
      );
      finnhubPeriods = await getFinnhubEarningsPeriods(symbol);
    }

    if (yahooAnnouncements.length === 0 && finnhubPeriods.length === 0) {
      console.warn(`[moves:${symbol}] no announcements from Yahoo OR Finnhub`);
      return [];
    }

    // Earliest date we need price bars for: min of Yahoo earliest announcement
    // and Finnhub earliest period (periods sort newest-first, so last entry).
    let earliestMs = Date.now();
    if (yahooAnnouncements.length > 0) {
      earliestMs = Math.min(earliestMs, yahooAnnouncements[yahooAnnouncements.length - 1].tsMs);
    }
    if (finnhubPeriods.length > 0) {
      const oldestPeriod = finnhubPeriods[finnhubPeriods.length - 1];
      const t = new Date(oldestPeriod + "T00:00:00Z").getTime();
      if (Number.isFinite(t)) earliestMs = Math.min(earliestMs, t);
    }

    const from = new Date(earliestMs - 10 * DAY_MS);
    const to = new Date(Date.now() + 5 * DAY_MS);

    const prices = await getHistoricalPrices(symbol, from, to);
    console.log(
      `[moves:${symbol}] fetched ${prices.length} price bars from ${from.toISOString().slice(0, 10)} to ${to.toISOString().slice(0, 10)}`,
    );
    if (prices.length === 0) {
      console.warn(`[moves:${symbol}] Yahoo historical() returned zero bars`);
      return [];
    }

    const sortedBars = [...prices].sort((a, b) => a.date.getTime() - b.date.getTime());
    const sessionLengthMs = Math.round(6.5 * 60 * 60 * 1000);

    type TaggedMove = EarningsMove & { source: "yahoo" | "finnhub" };
    const moves: TaggedMove[] = [];
    const details: string[] = [];

    // --- 1. Yahoo-sourced moves (authoritative: real reportedDate) ---
    for (const ann of yahooAnnouncements) {
      let closeBar: HistoricalRow | null = null;
      for (const b of sortedBars) {
        if (b.date.getTime() + sessionLengthMs < ann.tsMs) closeBar = b;
        else break;
      }
      let openBar: HistoricalRow | null = null;
      for (const b of sortedBars) {
        if (b.date.getTime() > ann.tsMs) {
          openBar = b;
          break;
        }
      }
      if (closeBar && openBar && closeBar.close > 0) {
        const pct = (openBar.open - closeBar.close) / closeBar.close;
        moves.push({
          date: ann.iso,
          actualMovePct: Math.abs(pct),
          direction: pct > 0.001 ? "up" : pct < -0.001 ? "down" : "flat",
          source: "yahoo",
        });
        details.push(
          `[yahoo] ${ann.iso}: close(${closeBar.date.toISOString().slice(0, 10)})=${closeBar.close.toFixed(2)} → ` +
            `open(${openBar.date.toISOString().slice(0, 10)})=${openBar.open.toFixed(2)} (${(pct * 100).toFixed(2)}%)`,
        );
      } else {
        details.push(
          `[yahoo] ${ann.iso}: closeBar=${closeBar ? closeBar.date.toISOString().slice(0, 10) : "null"} openBar=${openBar ? openBar.date.toISOString().slice(0, 10) : "null"} (skipped)`,
        );
      }
    }

    // --- 2. Finnhub fallback: infer move from largest overnight gap in the
    // 2-6 week window after each fiscal quarter end. Skip any inferred
    // announcement that falls within ±5 days of an existing Yahoo move.
    for (const qeIso of finnhubPeriods) {
      const qeMs = new Date(qeIso + "T00:00:00Z").getTime();
      if (!Number.isFinite(qeMs)) continue;
      const windowStart = qeMs + 14 * DAY_MS;
      const windowEnd = qeMs + 42 * DAY_MS;

      const gap = findLargestOvernightGap(sortedBars, windowStart, windowEnd);
      if (!gap) {
        details.push(`[finnhub] qe=${qeIso}: no gap in 2-6w window`);
        continue;
      }

      const annIso = gap.closeBar.date.toISOString().slice(0, 10);
      const annMs = gap.closeBar.date.getTime();
      const overlapsYahoo = moves.some((m) => {
        if (m.source !== "yahoo") return false;
        const t = new Date(m.date + "T00:00:00Z").getTime();
        return Math.abs(t - annMs) <= 5 * DAY_MS;
      });
      if (overlapsYahoo) {
        details.push(`[finnhub] qe=${qeIso}: inferred ${annIso} overlaps Yahoo (skip)`);
        continue;
      }

      moves.push({
        date: annIso,
        actualMovePct: Math.abs(gap.pct),
        direction: gap.pct > 0.001 ? "up" : gap.pct < -0.001 ? "down" : "flat",
        source: "finnhub",
      });
      details.push(
        `[finnhub] qe=${qeIso}: largest-gap ${gap.closeBar.date.toISOString().slice(0, 10)}→${gap.openBar.date.toISOString().slice(0, 10)} (${(gap.pct * 100).toFixed(2)}%)`,
      );
    }

    // Sort newest first, dedupe on ISO date, cap at 8.
    const seen = new Set<string>();
    const deduped: TaggedMove[] = [];
    moves.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    for (const m of moves) {
      if (seen.has(m.date)) continue;
      seen.add(m.date);
      deduped.push(m);
      if (deduped.length >= 8) break;
    }

    const yahooCount = deduped.filter((m) => m.source === "yahoo").length;
    const finnhubCount = deduped.filter((m) => m.source === "finnhub").length;
    console.log(
      `[moves:${symbol}] produced ${deduped.length} moves (yahoo=${yahooCount} finnhub=${finnhubCount}) — ${details.join(" | ")}`,
    );

    return deduped.map((m) => ({
      date: m.date,
      actualMovePct: m.actualMovePct,
      direction: m.direction,
    }));
  } catch (e) {
    logYahooFailure(`getHistoricalEarningsMovements(${symbol})`, e);
    return [];
  }
}

export async function getSectorIndustry(
  symbol: string,
): Promise<{ sector: string | null; industry: string | null }> {
  try {
    const summary = await quoteSummary(symbol, ["assetProfile", "summaryProfile"]);
    const profile = summary?.assetProfile ?? summary?.summaryProfile ?? null;
    return {
      sector: profile?.sector ?? null,
      industry: profile?.industry ?? null,
    };
  } catch (e) {
    logYahooFailure(`getSectorIndustry(${symbol})`, e);
    return { sector: null, industry: null };
  }
}

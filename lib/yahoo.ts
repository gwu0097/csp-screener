// All yahoo-finance2 access goes through this module. A single failed symbol
// must never throw out — every public function catches and returns a safe
// default (null / [] / undefined) so the screener loop keeps running across
// the remaining candidates.
//
// IMPORTANT: the correct yahoo-finance2 usage in Next.js serverless is the
// default import. Do NOT `new YahooFinance()`. Do NOT `require()`. Every call
// must pass `{ validateResult: false }` as the module-options argument so Yahoo
// payload drift does not trip the library's Zod validator.

import yahooFinance from "yahoo-finance2";

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
};

export type YahooProfile = {
  sector: string | null;
  industry: string | null;
  marketCap: number | null;
};

type RawQuote = Record<string, unknown>;

// ---------- Typed façades over yahoo-finance2 ----------

type QuoteFn = (
  s: string,
  q?: Record<string, unknown>,
  m?: { validateResult?: boolean },
) => Promise<unknown>;

type HistoricalFn = (
  s: string,
  opts: { period1: Date; period2: Date; interval: "1d" },
  m?: { validateResult?: boolean },
) => Promise<HistoricalRow[]>;

type QuoteSummaryFn = (
  s: string,
  opts: { modules: string[] },
  m?: { validateResult?: boolean },
) => Promise<QuoteSummaryResult>;

function yfQuote(): QuoteFn {
  return (yahooFinance as unknown as { quote: QuoteFn }).quote;
}
function yfHistorical(): HistoricalFn {
  return (yahooFinance as unknown as { historical: HistoricalFn }).historical;
}
function yfQuoteSummary(): QuoteSummaryFn {
  return (yahooFinance as unknown as { quoteSummary: QuoteSummaryFn }).quoteSummary;
}

function logYahooFailure(label: string, e: unknown): void {
  const msg = e instanceof Error ? e.message : String(e);
  console.warn(`[yahoo] ${label} failed: ${msg}`);
}

// ---------- Raw quote ----------

async function quoteRaw(symbol: string): Promise<RawQuote | null> {
  try {
    const result = await yfQuote()(symbol, {}, MODULE_OPTS);
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

async function quoteMinimal(symbol: string): Promise<MinimalQuote | null> {
  const record = await quoteRaw(symbol);
  if (!record) return null;
  return {
    regularMarketPrice: pickNumber(record, "regularMarketPrice") ?? undefined,
    marketCap: pickNumber(record, "marketCap") ?? undefined,
  };
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
    const rows = await yfHistorical()(
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
    const res = await yfQuoteSummary()(symbol, { modules }, MODULE_OPTS);
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

async function getPastEarningsDates(symbol: string): Promise<Date[]> {
  try {
    const summary = await quoteSummary(symbol, ["earningsHistory"]);
    const history = summary?.earningsHistory?.history ?? [];
    return history
      .map((h) => (h?.quarter ? new Date(h.quarter as string | number | Date) : null))
      .filter((d): d is Date => d !== null && !Number.isNaN(d.getTime()))
      .filter((d) => d.getTime() < Date.now())
      .sort((a, b) => b.getTime() - a.getTime())
      .slice(0, 8);
  } catch (e) {
    logYahooFailure(`getPastEarningsDates(${symbol})`, e);
    return [];
  }
}

export async function getHistoricalEarningsMovements(symbol: string): Promise<EarningsMove[]> {
  try {
    const earningsDates = await getPastEarningsDates(symbol);
    if (earningsDates.length === 0) return [];

    const earliest = earningsDates[earningsDates.length - 1];
    const from = new Date(earliest.getTime() - 10 * 24 * 60 * 60 * 1000);
    const to = new Date();
    const prices = await getHistoricalPrices(symbol, from, to);
    if (prices.length === 0) return [];

    const moves: EarningsMove[] = [];
    for (const ed of earningsDates) {
      const target = ed.getTime();
      let closeBefore: number | null = null;
      let closeBeforeTs = 0;
      let openAfter: number | null = null;

      for (const row of prices) {
        const t = row.date.getTime();
        if (t < target && t > closeBeforeTs) {
          closeBefore = row.close;
          closeBeforeTs = t;
        }
        if (t >= target && openAfter === null) {
          openAfter = row.open;
        }
      }

      if (closeBefore && openAfter && closeBefore > 0) {
        const pct = (openAfter - closeBefore) / closeBefore;
        moves.push({
          date: ed.toISOString().slice(0, 10),
          actualMovePct: Math.abs(pct),
          direction: pct > 0.001 ? "up" : pct < -0.001 ? "down" : "flat",
        });
      }
    }
    return moves;
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

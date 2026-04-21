import yahooFinance from "yahoo-finance2";

try {
  // Suppress the first-run Yahoo survey banner where supported.
  (yahooFinance as unknown as { suppressNotices?: (keys: string[]) => void }).suppressNotices?.([
    "yahooSurvey",
  ]);
} catch {
  // ignore
}

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
};

async function quoteMinimal(symbol: string): Promise<MinimalQuote | null> {
  try {
    // yahoo-finance2 runs Zod validation on the response by default. Yahoo
    // regularly adds new fields, causing validation to throw. Disable it so
    // we still get the price payload.
    const fn = (yahooFinance as unknown as {
      quote: (
        s: string,
        q?: Record<string, unknown>,
        m?: { validateResult?: boolean },
      ) => Promise<unknown>;
    }).quote;
    const result = await fn(symbol, {}, { validateResult: false });
    if (!result) return null;
    const record = (Array.isArray(result) ? result[0] : result) as MinimalQuote | null | undefined;
    return record ?? null;
  } catch (e) {
    console.error(`[yahoo] quote(${symbol}) failed:`, e instanceof Error ? e.message : e);
    return null;
  }
}

export async function getCurrentPrice(symbol: string): Promise<number | null> {
  const q = await quoteMinimal(symbol);
  const price = q?.regularMarketPrice;
  if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) {
    console.warn(`[yahoo] no regularMarketPrice for ${symbol}`);
    return null;
  }
  return price;
}

export async function getMarketCap(symbol: string): Promise<number | null> {
  const q = await quoteMinimal(symbol);
  return q?.marketCap ?? null;
}

export async function getHistoricalPrices(
  symbol: string,
  from: Date,
  to: Date,
): Promise<HistoricalRow[]> {
  try {
    const rows = (await (
      yahooFinance as unknown as {
        historical: (
          symbol: string,
          opts: { period1: Date; period2: Date; interval: "1d" },
        ) => Promise<HistoricalRow[]>;
      }
    ).historical(symbol, { period1: from, period2: to, interval: "1d" })) as HistoricalRow[];
    return rows;
  } catch {
    return [];
  }
}

async function quoteSummary(symbol: string, modules: string[]): Promise<QuoteSummaryResult | null> {
  try {
    const res = (await (
      yahooFinance as unknown as {
        quoteSummary: (s: string, opts: { modules: string[] }) => Promise<QuoteSummaryResult>;
      }
    ).quoteSummary(symbol, { modules })) as QuoteSummaryResult;
    return res;
  } catch {
    return null;
  }
}

async function getPastEarningsDates(symbol: string): Promise<Date[]> {
  const summary = await quoteSummary(symbol, ["earningsHistory"]);
  const history = summary?.earningsHistory?.history ?? [];
  return history
    .map((h) => (h?.quarter ? new Date(h.quarter as string | number | Date) : null))
    .filter((d): d is Date => d !== null && !Number.isNaN(d.getTime()))
    .filter((d) => d.getTime() < Date.now())
    .sort((a, b) => b.getTime() - a.getTime())
    .slice(0, 8);
}

export async function getHistoricalEarningsMovements(symbol: string): Promise<EarningsMove[]> {
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
}

export async function getSectorIndustry(symbol: string): Promise<{ sector: string | null; industry: string | null }> {
  const summary = await quoteSummary(symbol, ["assetProfile", "summaryProfile"]);
  const profile = summary?.assetProfile ?? summary?.summaryProfile ?? null;
  return {
    sector: profile?.sector ?? null,
    industry: profile?.industry ?? null,
  };
}

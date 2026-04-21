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
export async function getHistoricalEarningsMovements(symbol: string): Promise<EarningsMove[]> {
  try {
    const announcements = await getYahooPastAnnouncements(symbol);
    if (announcements.length === 0) {
      console.warn(`[moves:${symbol}] no past announcements from Yahoo earnings module`);
      return [];
    }

    const earliest = announcements[announcements.length - 1];
    const from = new Date(earliest.tsMs - 10 * 24 * 60 * 60 * 1000);
    const to = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);

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

    const moves: EarningsMove[] = [];
    const details: string[] = [];
    for (const ann of announcements) {
      let closeBar: (typeof prices)[number] | null = null;
      for (const b of sortedBars) {
        // bar's session close = bar.date + 6.5h; keep walking while that
        // close was strictly before the announcement.
        if (b.date.getTime() + sessionLengthMs < ann.tsMs) closeBar = b;
        else break;
      }
      let openBar: (typeof prices)[number] | null = null;
      for (const b of sortedBars) {
        // bar.date IS the session open; the first bar whose open was after
        // the announcement is our "open after" bar.
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
        });
        details.push(
          `${ann.iso}: close(${closeBar.date.toISOString().slice(0, 10)})=${closeBar.close.toFixed(2)} → ` +
            `open(${openBar.date.toISOString().slice(0, 10)})=${openBar.open.toFixed(2)} (${(pct * 100).toFixed(2)}%)`,
        );
      } else {
        details.push(
          `${ann.iso}: closeBar=${closeBar ? closeBar.date.toISOString().slice(0, 10) : "null"} openBar=${openBar ? openBar.date.toISOString().slice(0, 10) : "null"} (skipped)`,
        );
      }
    }
    console.log(`[moves:${symbol}] produced ${moves.length} moves — ${details.join(" | ")}`);
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

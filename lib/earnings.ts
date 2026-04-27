const FINNHUB_BASE = "https://finnhub.io/api/v1";
const FINNHUB_KEY = process.env.FINNHUB_API_KEY ?? "";

export type EarningsCalendarItem = {
  symbol: string;
  date: string;
  timing: "BMO" | "AMC" | "DMH"; // during market hours = excluded upstream
  estimatedEPS: number | null;
  actualEPS: number | null;
};

type FinnhubCalendarEntry = {
  symbol: string;
  date: string;
  hour?: string; // "bmo" | "amc" | "dmh"
  epsEstimate?: number | null;
  epsActual?: number | null;
};

export async function finnhubGet<T>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
  if (!FINNHUB_KEY) throw new Error("FINNHUB_API_KEY is not set");
  const url = new URL(`${FINNHUB_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    url.searchParams.set(k, String(v));
  }
  url.searchParams.set("token", FINNHUB_KEY);

  const res = await fetch(url.toString(), { cache: "no-store" });
  if (!res.ok) {
    const text = await res.text();
    console.error(`[finnhub] ${path} HTTP ${res.status}: ${text.slice(0, 200)}`);
    throw new Error(`Finnhub ${path} failed: ${res.status} ${text}`);
  }
  return (await res.json()) as T;
}

// Returns the current calendar date as YYYY-MM-DD in the US Eastern
// (America/New_York) time zone — the market's local date.
function todayInEastern(): string {
  // "en-CA" locale formats dates as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function addOneDayIso(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + 1);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

// Only returns the earnings a trader can act on TODAY:
//   - today's AMC (after market close)
//   - tomorrow's BMO (before market open)
// Dates are compared in US Eastern (market) time.
export async function getTodayEarnings(): Promise<EarningsCalendarItem[]> {
  const today = todayInEastern();
  const tomorrow = addOneDayIso(today);

  try {
    const data = await finnhubGet<{ earningsCalendar: FinnhubCalendarEntry[] }>("/calendar/earnings", {
      from: today,
      to: tomorrow,
    });
    const rows = data.earningsCalendar ?? [];

    const parsed: EarningsCalendarItem[] = [];
    for (const r of rows) {
      const hour = (r.hour ?? "").toLowerCase();
      const timing: EarningsCalendarItem["timing"] | null =
        hour === "bmo" ? "BMO" : hour === "amc" ? "AMC" : hour === "dmh" ? "DMH" : null;
      if (!timing) continue;
      parsed.push({
        symbol: r.symbol,
        date: r.date,
        timing,
        estimatedEPS: r.epsEstimate ?? null,
        actualEPS: r.epsActual ?? null,
      });
    }

    return parsed.filter(
      (x) =>
        (x.date === today && x.timing === "AMC") ||
        (x.date === tomorrow && x.timing === "BMO"),
    );
  } catch (e) {
    console.error("[earnings] getTodayEarnings failed:", e instanceof Error ? e.message : e);
    return [];
  }
}

export type AnalystEstimate = {
  consensus: number | null;
  high: number | null;
  low: number | null;
  dispersionPct: number | null;
  analystCount: number | null;
};

// Finnhub's free tier does not expose estimate ranges for most symbols,
// so we approximate dispersion from the stddev of recent surprise magnitudes.
export async function getAnalystEstimates(symbol: string): Promise<AnalystEstimate> {
  try {
    const rec = await finnhubGet<Array<{ buy: number; hold: number; sell: number; strongBuy: number; strongSell: number }>>(
      "/stock/recommendation",
      { symbol },
    );
    if (rec.length === 0) return { consensus: null, high: null, low: null, dispersionPct: null, analystCount: null };
    const latest = rec[0];
    const total = latest.buy + latest.hold + latest.sell + latest.strongBuy + latest.strongSell;
    if (total === 0) return { consensus: null, high: null, low: null, dispersionPct: null, analystCount: total };
    const largestShare = Math.max(latest.buy + latest.strongBuy, latest.hold, latest.sell + latest.strongSell) / total;
    // Higher agreement => lower dispersion. Map agreement [0.33..1.0] to dispersion [25%..0%].
    const dispersionPct = Math.max(0, Math.round((1 - largestShare) * 40 * 10) / 10);
    return {
      consensus: null,
      high: null,
      low: null,
      dispersionPct,
      analystCount: total,
    };
  } catch {
    return { consensus: null, high: null, low: null, dispersionPct: null, analystCount: null };
  }
}

export type EarningsSurprise = {
  surpriseScore: number; // 0..4
  beatsWithin5Pct: number;
  quartersExamined: number;
};

// Finnhub /quote — lightweight fallback for price when Yahoo returns 0.
// Returns 0 on failure. Shape: { c: current, pc: previousClose, d, dp, h, l, o, t }.
export async function getFinnhubQuotePrice(symbol: string): Promise<number> {
  try {
    const data = await finnhubGet<{
      c?: number;
      pc?: number;
      h?: number;
      l?: number;
      o?: number;
    }>("/quote", { symbol: symbol.toUpperCase() });
    if (typeof data.c === "number" && data.c > 0) return data.c;
    if (typeof data.pc === "number" && data.pc > 0) return data.pc;
    if (typeof data.o === "number" && data.o > 0) return data.o;
    console.warn(
      `[finnhub] quote(${symbol}) returned no usable price: c=${data.c} pc=${data.pc} o=${data.o}`,
    );
    return 0;
  } catch (e) {
    console.warn(`[finnhub] quote(${symbol}) failed:`, e instanceof Error ? e.message : e);
    return 0;
  }
}

// Historical earnings announcements for a single symbol from Finnhub's
// /calendar/earnings endpoint, filtered by symbol and the last ~400 days.
// Returns { date, timing } pairs — timing is needed to compute overnight moves
// correctly (BMO uses close(D-1)→open(D); AMC uses close(D)→open(D+1)).
export type PastEarningsAnnouncement = {
  date: string; // YYYY-MM-DD
  timing: "BMO" | "AMC" | "DMH" | "unknown";
};

export async function getFinnhubPastEarningsDates(
  symbol: string,
): Promise<PastEarningsAnnouncement[]> {
  const to = new Date();
  const from = new Date(to.getTime() - 400 * 24 * 60 * 60 * 1000);
  const fromIso = from.toISOString().slice(0, 10);
  const toIso = to.toISOString().slice(0, 10);

  try {
    const data = await finnhubGet<{ earningsCalendar: FinnhubCalendarEntry[] }>(
      "/calendar/earnings",
      { symbol: symbol.toUpperCase(), from: fromIso, to: toIso },
    );
    const rows = data.earningsCalendar ?? [];
    // Defense: if Finnhub ever ignores the symbol param, filter client-side.
    const matching = rows.filter(
      (r) => (r.symbol ?? "").toUpperCase() === symbol.toUpperCase(),
    );
    const announcements = matching
      .map<PastEarningsAnnouncement | null>((r) => {
        if (!r.date) return null;
        const d = new Date(r.date + "T00:00:00Z");
        if (Number.isNaN(d.getTime())) return null;
        if (d.getTime() > Date.now()) return null;
        const h = (r.hour ?? "").toLowerCase();
        const timing: PastEarningsAnnouncement["timing"] =
          h === "bmo" ? "BMO" : h === "amc" ? "AMC" : h === "dmh" ? "DMH" : "unknown";
        return { date: r.date, timing };
      })
      .filter((x): x is PastEarningsAnnouncement => x !== null)
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
      .slice(0, 8);
    return announcements;
  } catch (e) {
    console.warn(
      `[finnhub] getFinnhubPastEarningsDates(${symbol}) failed:`,
      e instanceof Error ? e.message : e,
    );
    return [];
  }
}

// Insider transactions for a single symbol from Finnhub's
// /stock/insider-transactions endpoint. Returns the raw rows trimmed to
// the requested window so the swing screener can classify them downstream.
// Finnhub /stock/insider-transactions row shape (free tier — verified against
// live API as of 2026-Q1). `share` is the insider's total holdings AFTER the
// transaction, NOT the transaction direction. `change` is the signed delta
// (positive = acquired shares, negative = disposed). The free tier does NOT
// expose officer titles or roles — there is no `title`, `position`,
// `officerTitle`, etc. field. Use `transactionCode` to distinguish open-
// market purchases (P) from grants (A), option exercises (M), etc.
export type FinnhubInsiderTx = {
  name: string;
  share: number;
  change: number;
  filingDate: string;
  transactionDate: string;
  transactionCode: string;
  transactionPrice: number;
};

export async function getFinnhubInsiderTransactions(
  symbol: string,
  windowDays = 45,
): Promise<FinnhubInsiderTx[]> {
  const to = new Date();
  const from = new Date(to.getTime() - windowDays * 24 * 60 * 60 * 1000);
  const fromIso = from.toISOString().slice(0, 10);
  const toIso = to.toISOString().slice(0, 10);

  try {
    const data = await finnhubGet<{ data?: FinnhubInsiderTx[]; symbol?: string }>(
      "/stock/insider-transactions",
      { symbol: symbol.toUpperCase(), from: fromIso, to: toIso },
    );
    const rows = data.data ?? [];
    return rows;
  } catch (e) {
    console.warn(
      `[finnhub] getFinnhubInsiderTransactions(${symbol}) failed:`,
      e instanceof Error ? e.message : e,
    );
    return [];
  }
}

// Next future earnings announcement for a single symbol within ~120 days,
// pulled from Finnhub's /calendar/earnings endpoint. Returns null if the
// window is empty (Finnhub typically only schedules ~1 quarter ahead, so
// dropping the window past 120 days yields no extra signal).
export type NextEarningsAnnouncement = {
  date: string; // YYYY-MM-DD (Eastern calendar day)
  timing: "BMO" | "AMC" | "DMH" | "unknown";
};

export async function getFinnhubNextEarningsDate(
  symbol: string,
): Promise<NextEarningsAnnouncement | null> {
  const todayIso = todayInEastern();
  const to = new Date();
  to.setUTCDate(to.getUTCDate() + 120);
  const toIso = `${to.getUTCFullYear()}-${String(to.getUTCMonth() + 1).padStart(2, "0")}-${String(to.getUTCDate()).padStart(2, "0")}`;

  try {
    const data = await finnhubGet<{ earningsCalendar: FinnhubCalendarEntry[] }>(
      "/calendar/earnings",
      { symbol: symbol.toUpperCase(), from: todayIso, to: toIso },
    );
    const rows = data.earningsCalendar ?? [];
    const matching = rows
      .filter((r) => (r.symbol ?? "").toUpperCase() === symbol.toUpperCase())
      .filter((r) => typeof r.date === "string" && r.date >= todayIso)
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const next = matching[0];
    if (!next) return null;
    const h = (next.hour ?? "").toLowerCase();
    const timing: NextEarningsAnnouncement["timing"] =
      h === "bmo" ? "BMO" : h === "amc" ? "AMC" : h === "dmh" ? "DMH" : "unknown";
    return { date: next.date, timing };
  } catch (e) {
    console.warn(
      `[finnhub] getFinnhubNextEarningsDate(${symbol}) failed:`,
      e instanceof Error ? e.message : e,
    );
    return null;
  }
}

// Finnhub /stock/earnings fallback source: returns fiscal quarter-end dates
// (ISO YYYY-MM-DD). The fiscal quarter end is NOT the announcement date —
// announcements happen ~2-6 weeks later — so callers must map period → likely
// announcement window before using these for overnight-move computation.
export async function getFinnhubEarningsPeriods(symbol: string): Promise<string[]> {
  try {
    const rows = await finnhubGet<Array<{ period?: string }>>("/stock/earnings", {
      symbol: symbol.toUpperCase(),
    });
    return rows
      .map((r) => r.period)
      .filter((p): p is string => typeof p === "string" && /^\d{4}-\d{2}-\d{2}$/.test(p))
      .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  } catch (e) {
    console.warn(
      `[finnhub] getFinnhubEarningsPeriods(${symbol}) failed:`,
      e instanceof Error ? e.message : e,
    );
    return [];
  }
}

export async function getEarningsSurpriseHistory(symbol: string): Promise<EarningsSurprise> {
  try {
    const rows = await finnhubGet<Array<{ actual: number | null; estimate: number | null; period: string }>>(
      "/stock/earnings",
      { symbol },
    );
    const recent = rows.slice(0, 8);
    let beatsInBand = 0;
    let counted = 0;
    for (const r of recent) {
      if (r.actual === null || r.estimate === null || r.estimate === 0) continue;
      counted += 1;
      const surprisePct = (r.actual - r.estimate) / Math.abs(r.estimate);
      if (surprisePct >= 0 && surprisePct <= 0.05) beatsInBand += 1;
    }
    const score = Math.min(4, Math.round((beatsInBand / Math.max(1, counted)) * 4));
    return { surpriseScore: score, beatsWithin5Pct: beatsInBand, quartersExamined: counted };
  } catch (e) {
    console.warn(
      `[finnhub] getEarningsSurpriseHistory(${symbol}) failed:`,
      e instanceof Error ? e.message : e,
    );
    return { surpriseScore: 0, beatsWithin5Pct: 0, quartersExamined: 0 };
  }
}

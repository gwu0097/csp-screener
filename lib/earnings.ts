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

async function finnhubGet<T>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
  if (!FINNHUB_KEY) throw new Error("FINNHUB_API_KEY is not set");
  const url = new URL(`${FINNHUB_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    url.searchParams.set(k, String(v));
  }
  url.searchParams.set("token", FINNHUB_KEY);

  // Log the URL without the token so we can confirm the exact date range.
  const safe = new URL(url.toString());
  safe.searchParams.set("token", "***");
  console.log(`[finnhub] GET ${safe.toString()}`);

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

  console.log(`[earnings] window today=${today} tomorrow=${tomorrow}`);

  try {
    const data = await finnhubGet<{ earningsCalendar: FinnhubCalendarEntry[] }>("/calendar/earnings", {
      from: today,
      to: tomorrow,
    });
    const rows = data.earningsCalendar ?? [];

    // Breakdown of the raw Finnhub payload by date and by timing so we can see
    // exactly what the calendar returned before any filtering.
    const byDate = new Map<string, number>();
    const byTiming = { bmo: 0, amc: 0, dmh: 0, other: 0, missing: 0 };
    for (const r of rows) {
      byDate.set(r.date, (byDate.get(r.date) ?? 0) + 1);
      const h = (r.hour ?? "").toLowerCase();
      if (h === "bmo") byTiming.bmo += 1;
      else if (h === "amc") byTiming.amc += 1;
      else if (h === "dmh") byTiming.dmh += 1;
      else if (!h) byTiming.missing += 1;
      else byTiming.other += 1;
    }
    const dateBreakdown = Array.from(byDate.entries())
      .map(([d, n]) => `${d}=${n}`)
      .join(", ");
    console.log(
      `[earnings] raw rows=${rows.length} dates={${dateBreakdown}} timing=${JSON.stringify(byTiming)}`,
    );

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

    const kept = parsed.filter(
      (x) =>
        (x.date === today && x.timing === "AMC") ||
        (x.date === tomorrow && x.timing === "BMO"),
    );

    console.log(
      `[earnings] parsed=${parsed.length} kept=${kept.length} ` +
        `(today=${today} AMC + tomorrow=${tomorrow} BMO) ` +
        `symbols=${kept.map((k) => `${k.symbol}/${k.date}/${k.timing}`).join(",")}`,
    );

    return kept;
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
  } catch {
    return { surpriseScore: 0, beatsWithin5Pct: 0, quartersExamined: 0 };
  }
}

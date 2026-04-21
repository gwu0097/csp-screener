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
  const res = await fetch(url.toString(), { cache: "no-store" });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Finnhub ${path} failed: ${res.status} ${text}`);
  }
  return (await res.json()) as T;
}

function toISODate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export async function getTodayEarnings(): Promise<EarningsCalendarItem[]> {
  const today = new Date();
  const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000);
  const from = toISODate(today);
  const to = toISODate(tomorrow);

  try {
    const data = await finnhubGet<{ earningsCalendar: FinnhubCalendarEntry[] }>("/calendar/earnings", { from, to });
    const rows = data.earningsCalendar ?? [];
    return rows
      .map<EarningsCalendarItem | null>((r) => {
        const hour = (r.hour ?? "").toLowerCase();
        const timing: EarningsCalendarItem["timing"] | null =
          hour === "bmo" ? "BMO" : hour === "amc" ? "AMC" : hour === "dmh" ? "DMH" : null;
        if (!timing) return null;
        return {
          symbol: r.symbol,
          date: r.date,
          timing,
          estimatedEPS: r.epsEstimate ?? null,
          actualEPS: r.epsActual ?? null,
        };
      })
      .filter((x): x is EarningsCalendarItem => x !== null)
      .filter((x) => x.timing === "BMO" || x.timing === "AMC");
  } catch {
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

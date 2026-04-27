import { NextRequest, NextResponse } from "next/server";
import { getHistoricalPrices } from "@/lib/yahoo";

export const dynamic = "force-dynamic";
// Yahoo historical for 6 months runs ~1-2s per symbol — well under the
// 60s default. Lazy-fetched per row only when the user expands it.

export type ChartPoint = {
  date: string; // YYYY-MM-DD
  close: number;
  volume: number;
  ma50: number | null;
  ma200: number | null;
};

// Rolling mean over the trailing `window` close values. Returns null until
// at least one bar is available; once windowed is set, computes from the
// available subset (so the 200d MA still draws a value even before 200 bars
// of history have built up — the user sees a degraded MA rather than blank
// space at the left edge of the chart).
function rollingMean(closes: number[], window: number): Array<number | null> {
  const out: Array<number | null> = new Array(closes.length).fill(null);
  let sum = 0;
  for (let i = 0; i < closes.length; i += 1) {
    sum += closes[i];
    if (i >= window) sum -= closes[i - window];
    const denom = Math.min(i + 1, window);
    out[i] = denom > 0 ? sum / denom : null;
  }
  return out;
}

function isoDay(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const symbol = (req.nextUrl.searchParams.get("symbol") ?? "")
    .trim()
    .toUpperCase();
  if (!symbol || !/^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol)) {
    return NextResponse.json({ error: "Invalid symbol" }, { status: 400 });
  }

  const to = new Date();
  const from = new Date(to.getTime() - 190 * 24 * 60 * 60 * 1000);
  const rows = await getHistoricalPrices(symbol, from, to);
  if (rows.length === 0) {
    return NextResponse.json({ symbol, data: [] satisfies ChartPoint[] });
  }

  const closes = rows.map((r) => r.close);
  const ma50 = rollingMean(closes, 50);
  const ma200 = rollingMean(closes, 200);

  const data: ChartPoint[] = rows.map((r, i) => ({
    date: isoDay(r.date),
    close: Number.isFinite(r.close) ? r.close : 0,
    volume: Number.isFinite(r.volume) ? r.volume : 0,
    ma50: ma50[i],
    ma200: ma200[i],
  }));

  return NextResponse.json({ symbol, data });
}

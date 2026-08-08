import { NextRequest, NextResponse } from "next/server";
import { requireUserId, authErrorResponse } from "@/lib/auth";
import { getOrRefreshSnapshot } from "@/lib/market-snapshot";
import { getOrFetchDailyBars } from "@/lib/daily-bars-cache";
import { computeATR, computeADRPercent } from "@/lib/indicators";

export const dynamic = "force-dynamic";

// Entry-form context pre-fill. Reuses the same caches the rest of the app
// already maintains (symbol_market_snapshot for price/SMAs, daily_bars_cache
// for ATR14/ADR%) — no new data source, no direct Yahoo call from here.
export async function GET(req: NextRequest) {
  try {
    await requireUserId();
  } catch (e) {
    return authErrorResponse(e);
  }
  const symbol = (req.nextUrl.searchParams.get("symbol") ?? "").trim().toUpperCase();
  if (!symbol) {
    return NextResponse.json({ error: "Missing symbol" }, { status: 400 });
  }

  const [snapshot, bars] = await Promise.all([
    getOrRefreshSnapshot(symbol).catch(() => null),
    getOrFetchDailyBars(symbol).catch(() => []),
  ]);

  const atr14 = computeATR(bars, 14);
  const adrPct = computeADRPercent(bars, 20);

  return NextResponse.json({
    symbol,
    price: snapshot?.price ?? null,
    sma20: snapshot?.sma20 ?? null,
    sma50: snapshot?.sma50 ?? null,
    sma200: snapshot?.sma200 ?? null,
    atr14,
    adr_pct: adrPct,
  });
}

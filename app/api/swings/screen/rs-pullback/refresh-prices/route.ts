import { NextRequest, NextResponse } from "next/server";
import { getCurrentPrice } from "@/lib/yahoo";
import { requireUserId, authErrorResponse } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Price-only refresh for the RS Pullback tab — deliberately NOT
// /api/swings/quotes, which prefers getOrRefreshSnapshot() and can fall
// through to a real bars fetch + symbol_market_snapshot write on a cold
// cache. This route calls getCurrentPrice() directly: one Yahoo quote()
// per symbol, no bars, no cache write, no DB write of any kind — and
// sequentially, not the concurrent Promise.all /api/swings/quotes uses,
// per this feature's own "sequential, non-concurrent" requirement.
//
// Recomputing extension/target-distance/R:R/bucket from the returned
// prices happens entirely client-side (see refreshRsPullbackPrices in
// components/swing-screen-view.tsx) against each candidate's already-
// cached SMA50/ATR14/target/stop — this route's only job is prices.
export async function GET(req: NextRequest) {
  try {
    await requireUserId();
  } catch (e) {
    return authErrorResponse(e);
  }

  const raw = req.nextUrl.searchParams.get("symbols") ?? "";
  const symbols = Array.from(
    new Set(
      raw
        .split(",")
        .map((s) => s.trim().toUpperCase())
        .filter((s) => s.length > 0 && /^[A-Z0-9.-]{1,10}$/.test(s)),
    ),
  );
  if (symbols.length === 0) {
    return NextResponse.json({ prices: {}, refreshedAt: new Date().toISOString() });
  }

  const prices: Record<string, number | null> = {};
  for (const symbol of symbols) {
    try {
      prices[symbol] = await getCurrentPrice(symbol);
    } catch (e) {
      console.warn(`[rs-pullback/refresh-prices] ${symbol} failed:`, e);
      prices[symbol] = null;
    }
  }
  return NextResponse.json({ prices, refreshedAt: new Date().toISOString() });
}

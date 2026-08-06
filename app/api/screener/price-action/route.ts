import { NextRequest, NextResponse } from "next/server";
import { getQuoteEnrichment } from "@/lib/yahoo";
import { getOrFetchDailyBars } from "@/lib/daily-bars-cache";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// Price-action snapshot for the Analysis Dump's PRICE ACTION section —
// answers the template's runup_into_print flag, which was structurally
// UNKNOWN on every ticker before this existed (the dump carried no
// price-action data at all). Sourced entirely from Yahoo: 52-week
// high/low via getQuoteEnrichment (already used elsewhere — e.g.
// lib/swing-screener.ts, the buy-zone/longterm-watchlist routes — just
// not previously wired into the CSP screener), trailing 20-trading-day
// return from the SAME daily-bars cache Stage 3 already fetches for
// realized vol (lib/daily-bars-cache.ts, 95-calendar-day window — more
// than enough for 20 trading days). No new provider, no new fetch
// beyond what a cache-warm symbol already has.
//
// Display-only: this route only reads and computes ratios from prices
// already fetched for other purposes. Never feeds grading, strike
// selection, or any calculation.
export type PriceActionSnapshot = {
  trailing20dReturnPct: number | null;
  fiftyTwoWeekHigh: number | null;
  fiftyTwoWeekLow: number | null;
  // Both expressed as positive magnitudes — "12% below high", "30%
  // above low" — the dump's own copy supplies the direction in words.
  distFromHighPct: number | null;
  distFromLowPct: number | null;
};

export async function GET(req: NextRequest) {
  const symbol = req.nextUrl.searchParams.get("symbol")?.trim().toUpperCase();
  if (!symbol || !/^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol)) {
    return NextResponse.json({ error: "Invalid or missing symbol" }, { status: 400 });
  }
  // The dump's own captured spot (HEADER's "Spot: $X"), passed by the
  // caller — using it (rather than re-querying Yahoo for a possibly
  // slightly different live quote) keeps "12% below high" consistent
  // with the exact spot number printed a few lines above it.
  const priceParam = req.nextUrl.searchParams.get("price");
  const callerPrice = priceParam !== null ? Number(priceParam) : null;

  const [enrichment, bars] = await Promise.all([
    getQuoteEnrichment(symbol).catch(() => null),
    getOrFetchDailyBars(symbol).catch(() => []),
  ]);

  let trailing20dReturnPct: number | null = null;
  if (bars.length >= 21) {
    const last = bars[bars.length - 1];
    const prior = bars[bars.length - 21];
    if (prior.close > 0) {
      trailing20dReturnPct = (last.close - prior.close) / prior.close;
    }
  }

  const spot =
    callerPrice !== null && Number.isFinite(callerPrice) && callerPrice > 0
      ? callerPrice
      : (enrichment?.regularMarketPrice ?? null);
  const high = enrichment?.fiftyTwoWeekHigh ?? null;
  const low = enrichment?.fiftyTwoWeekLow ?? null;
  const distFromHighPct = spot !== null && high !== null && high > 0 ? (high - spot) / high : null;
  const distFromLowPct = spot !== null && low !== null && low > 0 ? (spot - low) / low : null;

  const snapshot: PriceActionSnapshot = {
    trailing20dReturnPct,
    fiftyTwoWeekHigh: high,
    fiftyTwoWeekLow: low,
    distFromHighPct,
    distFromLowPct,
  };
  return NextResponse.json(snapshot);
}

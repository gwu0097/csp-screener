import { NextRequest, NextResponse } from "next/server";
import { getCurrentPrice } from "@/lib/yahoo";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// Batch quote endpoint for ENTERED swing cards. The kanban passes a
// comma-separated list of symbols; we fan out to yahoo-finance2 in
// parallel and return a symbol → price map. Missing / unresolvable
// symbols come back as null so the client can render a dash instead
// of breaking.
export async function GET(req: NextRequest) {
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
    return NextResponse.json({ prices: {} });
  }

  const entries = await Promise.all(
    symbols.map(async (symbol) => {
      try {
        const price = await getCurrentPrice(symbol);
        return [symbol, price] as const;
      } catch (e) {
        console.warn(`[swings/quotes] ${symbol} failed:`, e);
        return [symbol, null] as const;
      }
    }),
  );
  const prices = Object.fromEntries(entries);
  return NextResponse.json({ prices });
}

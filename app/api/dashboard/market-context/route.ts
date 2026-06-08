import { NextResponse } from "next/server";
import { getQuoteEnrichment } from "@/lib/yahoo";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// Market-context tiles for the dashboard: index/sector daily change via
// Yahoo. ^TNX is the 10Y yield index quoted ×10 — the client divides by
// 10 to render a percent. Each symbol resolves independently so one
// dead quote doesn't blank the card.
const SYMBOLS = ["SPY", "QQQ", "XLK", "IWF", "^TNX"] as const;

type Tile = { price: number | null; changePct: number | null };

export async function GET() {
  const entries = await Promise.all(
    SYMBOLS.map(async (sym): Promise<readonly [string, Tile]> => {
      try {
        const q = await getQuoteEnrichment(sym);
        return [
          sym,
          {
            price: q?.regularMarketPrice ?? null,
            changePct: q?.regularMarketChangePercent ?? null,
          },
        ] as const;
      } catch (e) {
        console.warn(
          `[dashboard/market-context] ${sym} failed: ${e instanceof Error ? e.message : e}`,
        );
        return [sym, { price: null, changePct: null }] as const;
      }
    }),
  );
  const map = Object.fromEntries(entries) as Record<string, Tile>;
  return NextResponse.json({
    spy: map.SPY,
    qqq: map.QQQ,
    xlk: map.XLK,
    iwf: map.IWF,
    tnx: map["^TNX"],
  });
}

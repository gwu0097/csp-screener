import { NextResponse } from "next/server";
import { getOrRefreshSnapshot } from "@/lib/market-snapshot";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// Market-context tiles for the dashboard. Phase 2: these index/ETF
// symbols now flow through the central snapshot cache (15-min TTL) like
// every other symbol — no direct Yahoo calls. ^TNX is the 10Y yield
// index quoted ×10; the client divides by 10. Each symbol resolves
// independently so one dead quote doesn't blank the card.
const SYMBOLS = ["SPY", "QQQ", "XLK", "IWF", "^TNX"] as const;

type Tile = { price: number | null; changePct: number | null };

export async function GET() {
  const entries = await Promise.all(
    SYMBOLS.map(async (sym): Promise<readonly [string, Tile]> => {
      const snap = await getOrRefreshSnapshot(sym, 15).catch(() => null);
      return [
        sym,
        { price: snap?.price ?? null, changePct: snap?.change_pct ?? null },
      ] as const;
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

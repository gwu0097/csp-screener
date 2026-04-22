import { NextResponse } from "next/server";
import { createServerClient, TradeRow } from "@/lib/supabase";
import { getMarketContext } from "@/lib/market";

export const dynamic = "force-dynamic";

// Lightweight context for the screener daily summary line: VIX + regime, and
// the count of truly-open positions (no live greeks fetched; just DB math).
export async function GET() {
  const [market, openCount] = await Promise.all([
    getMarketContext(),
    getOpenPositionCount(),
  ]);
  return NextResponse.json({ market, openPositions: openCount });
}

async function getOpenPositionCount(): Promise<number> {
  try {
    const supabase = createServerClient();
    const { data, error } = await supabase.from("trades").select("*");
    if (error || !data) return 0;
    const rows = data as TradeRow[];
    const opens = rows.filter((t) => t.action === "open" && !t.closed_at);
    const closesByParent = new Map<string, number>();
    for (const c of rows) {
      if (c.action !== "close" || !c.parent_trade_id) continue;
      closesByParent.set(c.parent_trade_id, (closesByParent.get(c.parent_trade_id) ?? 0) + (c.contracts ?? 0));
    }
    let count = 0;
    for (const p of opens) {
      const remaining = (p.contracts ?? 1) - (closesByParent.get(p.id) ?? 0);
      if (remaining > 0) count += 1;
    }
    return count;
  } catch {
    return 0;
  }
}

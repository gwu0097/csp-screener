import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { getMarketContext } from "@/lib/market";

export const dynamic = "force-dynamic";

// Lightweight context for the screener daily-summary line: VIX + regime
// plus the count of currently-open positions. All DB-side, no Schwab calls.
export async function GET() {
  const [market, openCount] = await Promise.all([
    getMarketContext(),
    countOpenPositions(),
  ]);
  return NextResponse.json({ market, openPositions: openCount });
}

async function countOpenPositions(): Promise<number> {
  try {
    const supabase = createServerClient();
    const { data, error } = await supabase
      .from("positions")
      .select("id")
      .eq("status", "open");
    if (error || !data) return 0;
    return data.length;
  } catch {
    return 0;
  }
}

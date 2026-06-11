import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { getMarketContext } from "@/lib/market";
import { requireUserId, authErrorResponse } from "@/lib/auth";

export const dynamic = "force-dynamic";

// Lightweight context for the screener daily-summary line: VIX + regime
// plus the count of currently-open positions. All DB-side, no Schwab calls.
export async function GET() {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch (e) {
    return authErrorResponse(e);
  }
  const [market, openCount] = await Promise.all([
    getMarketContext(),
    countOpenPositions(userId),
  ]);
  return NextResponse.json({ market, openPositions: openCount });
}

async function countOpenPositions(userId: string): Promise<number> {
  try {
    const supabase = createServerClient();
    const { data, error } = await supabase
      .from("positions")
      .select("id")
      .eq("user_id", userId)
      .eq("status", "open");
    if (error || !data) return 0;
    return data.length;
  } catch {
    return 0;
  }
}

import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import type {
  EarningsHistory,
  StockEncyclopedia,
} from "@/lib/encyclopedia";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ symbol: string }> },
) {
  const { symbol } = await params;
  const sym = symbol.toUpperCase();
  const sb = createServerClient();

  const encRes = await sb
    .from("stock_encyclopedia")
    .select("*")
    .eq("symbol", sym)
    .limit(1);
  if (encRes.error) {
    return NextResponse.json({ error: encRes.error.message }, { status: 500 });
  }
  const encyclopedia = ((encRes.data ?? []) as StockEncyclopedia[])[0] ?? null;

  const histRes = await sb
    .from("earnings_history")
    .select("*")
    .eq("symbol", sym)
    .order("earnings_date", { ascending: false });
  if (histRes.error) {
    return NextResponse.json({ error: histRes.error.message }, { status: 500 });
  }
  const history = (histRes.data ?? []) as EarningsHistory[];

  // Derived crush stats — computed live from earnings_history so the
  // Overview tile always reflects current data instead of stock_encyclopedia
  // aggregates that may be stale or never populated. Only counts rows
  // where BOTH implied and actual moves are present (so an upcoming
  // event with no actual yet doesn't pollute the average).
  let crushedCount = 0;
  let totalCount = 0;
  let ratioSum = 0;
  for (const r of history) {
    const im = typeof r.implied_move_pct === "number" ? r.implied_move_pct : null;
    const am = typeof r.actual_move_pct === "number" ? r.actual_move_pct : null;
    if (im === null || am === null || !Number.isFinite(im) || im <= 0) continue;
    const ratio = Math.abs(am) / im;
    if (!Number.isFinite(ratio)) continue;
    totalCount += 1;
    ratioSum += ratio;
    if (ratio < 1.0) crushedCount += 1;
  }
  const computed = {
    totalEvents: totalCount,
    crushedCount,
    crushRate: totalCount > 0 ? crushedCount / totalCount : null,
    avgRatio: totalCount > 0 ? ratioSum / totalCount : null,
  };

  return NextResponse.json({ encyclopedia, history, computed });
}

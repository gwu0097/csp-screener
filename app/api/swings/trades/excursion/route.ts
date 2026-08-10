import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { requireUserId, authErrorResponse } from "@/lib/auth";
import { getOrFetchDailyBars } from "@/lib/daily-bars-cache";

export const dynamic = "force-dynamic";

type OpenTrade = {
  id: string;
  symbol: string;
  entry_date: string;
  entry_price: number;
  initial_stop: number;
  max_favorable_excursion_r: number | null;
  max_adverse_excursion_r: number | null;
};

// Refreshes MFE/MAE for open positions. Re-scans the FULL bar window from
// entry_date through today on every call rather than just "today's bar" —
// an on-demand refresh that only looked at the latest day would silently
// miss every excursion that happened between refreshes. daily_bars_cache
// keeps ~95 calendar days per symbol, comfortably covering swing holding
// periods; a trade held open longer than that will have its pre-window
// excursion history unavailable (the cache doesn't reach back further).
export async function POST(req: NextRequest) {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch (e) {
    return authErrorResponse(e);
  }
  let body: { id?: unknown } = {};
  try {
    body = (await req.json().catch(() => ({}))) as { id?: unknown };
  } catch {
    body = {};
  }
  const onlyId = typeof body.id === "string" && body.id.length > 0 ? body.id : null;

  const sb = createServerClient();
  let q = sb
    .from<OpenTrade>("swing_trades")
    .select("id,symbol,entry_date,entry_price,initial_stop,max_favorable_excursion_r,max_adverse_excursion_r")
    .eq("user_id", userId)
    .eq("status", "open");
  if (onlyId) q = q.eq("id", onlyId);
  const res = await q;
  if (res.error) {
    return NextResponse.json({ error: res.error.message }, { status: 500 });
  }
  const trades = (res.data ?? []) as OpenTrade[];
  if (trades.length === 0) {
    return NextResponse.json({ updated: 0, results: [] });
  }

  const results: Array<{
    id: string;
    symbol: string;
    max_favorable_excursion_r: number | null;
    max_adverse_excursion_r: number | null;
  }> = [];
  let updated = 0;

  for (const trade of trades) {
    const riskPerShare = trade.entry_price - trade.initial_stop;
    if (!(riskPerShare > 0)) continue; // shouldn't happen — initial_stop is required < entry_price

    const bars = await getOrFetchDailyBars(trade.symbol).catch(() => []);
    const windowBars = bars.filter((b) => b.date >= trade.entry_date);
    if (windowBars.length === 0) continue;

    let mfe = -Infinity;
    let mae = Infinity;
    for (const b of windowBars) {
      const rAtHigh = (b.high - trade.entry_price) / riskPerShare;
      const rAtLow = (b.low - trade.entry_price) / riskPerShare;
      if (rAtHigh > mfe) mfe = rAtHigh;
      if (rAtLow < mae) mae = rAtLow;
    }
    if (mfe === -Infinity || mae === Infinity) continue;

    const upd = await sb
      .from("swing_trades")
      .update({
        max_favorable_excursion_r: mfe,
        max_adverse_excursion_r: mae,
        updated_at: new Date().toISOString(),
      })
      .eq("id", trade.id)
      .eq("user_id", userId);
    if (upd.error) {
      console.warn(`[swings/trades/excursion] ${trade.symbol} update failed: ${upd.error.message}`);
      continue;
    }
    updated += 1;
    results.push({ id: trade.id, symbol: trade.symbol, max_favorable_excursion_r: mfe, max_adverse_excursion_r: mae });
  }

  return NextResponse.json({ updated, results });
}

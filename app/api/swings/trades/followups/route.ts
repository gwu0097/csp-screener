import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { requireUserId, authErrorResponse } from "@/lib/auth";
import { getOrFetchDailyBars } from "@/lib/daily-bars-cache";

export const dynamic = "force-dynamic";

type ClosedTrade = {
  id: string;
  symbol: string;
  exit_date: string;
  exit_price: number | null;
  r_multiple: number | null;
};

const DAY_MS = 24 * 60 * 60 * 1000;

// price_two_weeks_after_exit is the only way to learn whether an exit was
// early, late, or right — surface closed trades old enough to answer that
// and haven't been answered yet, with the price pre-filled from the cache
// so the user only has to write the note.
export async function GET() {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch (e) {
    return authErrorResponse(e);
  }
  const sb = createServerClient();
  const cutoff = new Date(Date.now() - 14 * DAY_MS).toISOString().slice(0, 10);
  const res = await sb
    .from<ClosedTrade>("swing_trades")
    .select("id,symbol,exit_date,exit_price,r_multiple")
    .eq("user_id", userId)
    .eq("status", "closed")
    .is("price_two_weeks_after_exit", null)
    // No .not("exit_date", "is", null) — lib/supabase's wrapper doesn't
    // support .not(), and it's redundant anyway: status="closed" rows
    // always have exit_date set together (see [id]/route.ts PATCH).
    .lte("exit_date", cutoff)
    .order("exit_date", { ascending: true });
  if (res.error) {
    return NextResponse.json({ error: res.error.message }, { status: 500 });
  }
  const trades = (res.data ?? []) as ClosedTrade[];

  const enriched = await Promise.all(
    trades.map(async (t) => {
      const targetDate = new Date(new Date(t.exit_date).getTime() + 14 * DAY_MS)
        .toISOString()
        .slice(0, 10);
      const bars = await getOrFetchDailyBars(t.symbol).catch(() => []);
      // Closest cached bar to exit_date + 14d (prefer on/after; fall back to
      // the nearest available if the exact date isn't a trading day or the
      // cache window doesn't reach that far back).
      let best: (typeof bars)[number] | null = null;
      let bestDiff = Infinity;
      for (const b of bars) {
        const diff = Math.abs(new Date(b.date).getTime() - new Date(targetDate).getTime());
        if (diff < bestDiff) {
          bestDiff = diff;
          best = b;
        }
      }
      return {
        id: t.id,
        symbol: t.symbol,
        exit_date: t.exit_date,
        exit_price: t.exit_price,
        r_multiple: t.r_multiple,
        target_date: targetDate,
        suggested_price: best?.close ?? null,
      };
    }),
  );

  return NextResponse.json({ trades: enriched });
}

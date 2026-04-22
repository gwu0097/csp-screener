import { NextResponse } from "next/server";
import { createServerClient, TradeRow } from "@/lib/supabase";
import {
  extractRealizedTrades,
  computeSummary,
  computeByTicker,
  computeStrikeInsight,
  computeDayInsight,
  computeHoldInsight,
  computeEquityCurve,
} from "@/lib/journal";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const supabase = createServerClient();
    const { data, error } = await supabase
      .from("trades")
      .select("*")
      .order("trade_date", { ascending: false });
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const trades = extractRealizedTrades((data ?? []) as TradeRow[]);
    const summary = computeSummary(trades);
    const byTicker = computeByTicker(trades);
    const strikeInsight = computeStrikeInsight(trades);
    const dayInsight = computeDayInsight(trades);
    const holdInsight = computeHoldInsight(trades);
    const equityCurve = computeEquityCurve(trades);

    const sortedByPnl = [...trades].sort((a, b) => b.pnl - a.pnl);
    const topWins = sortedByPnl.slice(0, 5);
    const topLosses = sortedByPnl.slice(-5).reverse();

    const recentTrades = [...trades]
      .sort((a, b) => b.closedAt.localeCompare(a.closedAt))
      .slice(0, 20);

    return NextResponse.json({
      trades,
      summary,
      byTicker,
      strikeInsight,
      dayInsight,
      holdInsight,
      equityCurve,
      topWins,
      topLosses,
      recentTrades,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "stats failed" },
      { status: 500 },
    );
  }
}

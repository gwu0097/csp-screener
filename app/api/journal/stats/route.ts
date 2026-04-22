import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import type { Fill, PositionRow } from "@/lib/positions";

export const dynamic = "force-dynamic";

// Realized-trade shape returned to the client — one row per closed
// position. Matches what components/journal-view.tsx expects.
type RealizedTrade = {
  parentId: string;
  symbol: string;
  strike: number;
  expiry: string;
  broker: string;
  tradeDate: string;
  closedAt: string;
  premiumSold: number;
  premiumBought: number;
  contracts: number;
  pnl: number;
  rocPct: number;
  holdDays: number;
  dayOfWeek: number;
  strikeMultiple: number | null;
  crushGrade: string | null;
  opportunityGrade: string | null;
  outcome: "win" | "loss";
};

function daysBetween(aIso: string, bIso: string): number {
  const a = new Date(aIso + "T00:00:00Z").getTime();
  const b = new Date(bIso + "T00:00:00Z").getTime();
  return Math.max(0, Math.round((b - a) / (24 * 60 * 60 * 1000)));
}

function sum(arr: number[]): number {
  return arr.reduce((a, b) => a + b, 0);
}

function median(sortedAsc: number[]): number {
  const n = sortedAsc.length;
  if (n === 0) return 0;
  return n % 2 ? sortedAsc[(n - 1) / 2] : (sortedAsc[n / 2 - 1] + sortedAsc[n / 2]) / 2;
}

export async function GET() {
  try {
    const supabase = createServerClient();

    const { data: posRows, error: pErr } = await supabase
      .from<PositionRow>("positions")
      .select("*")
      .eq("status", "closed")
      .order("closed_date", { ascending: true });
    if (pErr) {
      return NextResponse.json({ error: pErr.message }, { status: 500 });
    }
    const closedPositions = (posRows ?? []) as PositionRow[];

    const ids = closedPositions.map((p) => p.id);
    const fillsByPosition = new Map<string, Fill[]>();
    if (ids.length > 0) {
      const { data: fillsRows } = await supabase
        .from<Fill & { position_id: string }>("fills")
        .select("position_id, fill_type, contracts, premium, fill_date")
        .in("position_id", ids);
      for (const f of (fillsRows ?? []) as Array<Fill & { position_id: string }>) {
        const arr = fillsByPosition.get(f.position_id) ?? [];
        arr.push({
          fill_type: f.fill_type,
          contracts: f.contracts,
          premium: f.premium,
          fill_date: f.fill_date,
        });
        fillsByPosition.set(f.position_id, arr);
      }
    }

    const trades: RealizedTrade[] = closedPositions
      .map<RealizedTrade | null>((p) => {
        const fills = fillsByPosition.get(p.id) ?? [];
        const opens = fills.filter((f) => f.fill_type === "open");
        const closes = fills.filter((f) => f.fill_type === "close");
        const openContracts = sum(opens.map((f) => f.contracts));
        const closeContracts = sum(closes.map((f) => f.contracts));
        if (openContracts === 0 || closeContracts === 0) return null;
        const premiumSold = Number(p.avg_premium_sold ?? 0);
        const premiumBought =
          closeContracts > 0
            ? sum(closes.map((f) => f.premium * f.contracts)) / closeContracts
            : 0;
        const strike = Number(p.strike);
        const pnl = Number(p.realized_pnl ?? 0);
        const rocPct = strike > 0 ? ((premiumSold - premiumBought) / strike) * 100 : 0;
        const tradeDate = p.opened_date;
        const closedAt = p.closed_date ?? p.opened_date;
        const holdDays = daysBetween(tradeDate, closedAt);
        return {
          parentId: p.id,
          symbol: p.symbol,
          strike,
          expiry: p.expiry,
          broker: p.broker,
          tradeDate,
          closedAt,
          premiumSold,
          premiumBought,
          contracts: openContracts,
          pnl,
          rocPct,
          holdDays,
          dayOfWeek: new Date(tradeDate + "T00:00:00Z").getUTCDay(),
          strikeMultiple: null,
          crushGrade: null,
          opportunityGrade: null,
          outcome: pnl >= 0 ? "win" : "loss",
        };
      })
      .filter((t): t is RealizedTrade => t !== null);

    // ---- Summary ----
    const total = trades.length;
    const wins = trades.filter((t) => t.pnl > 0);
    const losses = trades.filter((t) => t.pnl <= 0);
    const winRate = total > 0 ? (wins.length / total) * 100 : 0;
    const avgWin = wins.length > 0 ? sum(wins.map((t) => t.pnl)) / wins.length : 0;
    const avgLoss = losses.length > 0 ? sum(losses.map((t) => t.pnl)) / losses.length : 0;
    const expectancy = (winRate / 100) * avgWin + ((100 - winRate) / 100) * avgLoss;

    const today = new Date().toISOString().slice(0, 10);
    const year = today.slice(0, 4);
    const month = today.slice(0, 7);
    const weekCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const ytd = trades.filter((t) => t.closedAt >= `${year}-01-01`);
    const mth = trades.filter((t) => t.closedAt >= `${month}-01`);
    const wk = trades.filter((t) => t.closedAt >= weekCutoff);
    const td = trades.filter((t) => t.closedAt === today);

    const rocs = trades.map((t) => t.rocPct).sort((a, b) => a - b);

    const summary = {
      totalTrades: total,
      wins: wins.length,
      losses: losses.length,
      winRate,
      avgWin,
      avgLoss,
      expectancy,
      realizedPnlAll: sum(trades.map((t) => t.pnl)),
      realizedPnlYtd: sum(ytd.map((t) => t.pnl)),
      realizedPnlMonth: sum(mth.map((t) => t.pnl)),
      realizedPnlWeek: sum(wk.map((t) => t.pnl)),
      realizedPnlToday: sum(td.map((t) => t.pnl)),
      avgRocPct: rocs.length > 0 ? sum(rocs) / rocs.length : 0,
      medianRocPct: median(rocs),
      bestRocPct: rocs.length > 0 ? rocs[rocs.length - 1] : 0,
      worstRocPct: rocs.length > 0 ? rocs[0] : 0,
    };

    // ---- By ticker ----
    const byTickerBuckets = new Map<string, RealizedTrade[]>();
    for (const t of trades) {
      const arr = byTickerBuckets.get(t.symbol) ?? [];
      arr.push(t);
      byTickerBuckets.set(t.symbol, arr);
    }
    const byTicker = Array.from(byTickerBuckets.entries()).map(([symbol, ts]) => {
      const w = ts.filter((t) => t.pnl > 0).length;
      const l = ts.filter((t) => t.pnl <= 0).length;
      return {
        symbol,
        pnl: sum(ts.map((t) => t.pnl)),
        wins: w,
        losses: l,
        total: ts.length,
        winRate: ts.length > 0 ? (w / ts.length) * 100 : 0,
        avgRocPct: ts.length > 0 ? sum(ts.map((t) => t.rocPct)) / ts.length : 0,
        avgHoldDays: ts.length > 0 ? sum(ts.map((t) => t.holdDays)) / ts.length : 0,
      };
    });
    byTicker.sort((a, b) => b.pnl - a.pnl);

    // ---- Insights (strike multiple / day of week / hold duration) ----
    const bucketStats = (ts: RealizedTrade[]) => ({
      count: ts.length,
      winRate: ts.length > 0 ? (ts.filter((t) => t.pnl > 0).length / ts.length) * 100 : 0,
      avgPnl: ts.length > 0 ? sum(ts.map((t) => t.pnl)) / ts.length : 0,
    });

    const strikeInsight = {
      x15: bucketStats([]),
      x20: bucketStats([]),
      recommendation: "Strike multiples not yet captured on fill ingest",
    };

    const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const dayInsight: Array<{ day: string; dayIndex: number; count: number; winRate: number; avgPnl: number }> = [];
    for (let d = 1; d <= 5; d++) {
      const bucket = bucketStats(trades.filter((t) => t.dayOfWeek === d));
      if (bucket.count > 0) dayInsight.push({ day: DAY_NAMES[d], dayIndex: d, ...bucket });
    }

    const holdInsight = [
      { bucket: "same-day" as const, ...bucketStats(trades.filter((t) => t.holdDays === 0)) },
      { bucket: "1 day" as const, ...bucketStats(trades.filter((t) => t.holdDays === 1)) },
      { bucket: "2+ days" as const, ...bucketStats(trades.filter((t) => t.holdDays >= 2)) },
    ];

    // ---- Equity curve (daily aggregated cumulative pnl) ----
    const byDate = new Map<string, number>();
    for (const t of trades) {
      byDate.set(t.closedAt, (byDate.get(t.closedAt) ?? 0) + t.pnl);
    }
    const dates = Array.from(byDate.keys()).sort();
    let running = 0;
    const equityCurve: Array<{ date: string; pnl: number; cumPnl: number }> = [];
    for (const date of dates) {
      const p = byDate.get(date) ?? 0;
      running += p;
      equityCurve.push({ date, pnl: p, cumPnl: running });
    }

    // ---- Top 5 / recent 20 ----
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

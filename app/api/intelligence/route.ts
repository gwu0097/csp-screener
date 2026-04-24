import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type Window = "today" | "week" | "month" | "ytd" | "all";
const VALID_WINDOWS: readonly Window[] = ["today", "week", "month", "ytd", "all"];

type PositionRow = {
  id: string;
  symbol: string;
  strike: number;
  expiry: string;
  total_contracts: number;
  avg_premium_sold: number | null;
  opened_date: string;
  closed_date: string | null;
  realized_pnl: number | null;
  entry_final_grade: string | null;
  entry_crush_grade: string | null;
  entry_opportunity_grade: string | null;
  entry_iv_edge: number | null;
  entry_em_pct: number | null;
  entry_vix: number | null;
  status: string;
};

type RecRow = {
  position_id: string;
  recommendation: string;
  confidence: string;
  was_system_aligned: boolean | null;
  analysis_date: string;
};

// Returns the inclusive start date (YYYY-MM-DD) of the requested window.
// null means "no lower bound" — used for "all".
function windowStart(w: Window): string | null {
  if (w === "all") return null;
  const now = new Date();
  if (w === "today") return now.toISOString().slice(0, 10);
  if (w === "week") {
    const day = now.getUTCDay();
    const mondayOffset = (day + 6) % 7; // Sun=0 -> 6, Mon=1 -> 0, ...
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - mondayOffset);
    return d.toISOString().slice(0, 10);
  }
  if (w === "month") {
    return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
  }
  if (w === "ytd") {
    return `${now.getUTCFullYear()}-01-01`;
  }
  return null;
}

// ROC = realized_pnl / (strike × contracts × 100). Returns a decimal
// fraction (0.0042 = 0.42%). null when any input is missing or the
// denominator is zero.
function computeROC(
  realizedPnl: number | null,
  strike: number | null,
  contracts: number | null,
): number | null {
  if (realizedPnl === null || strike === null || contracts === null) return null;
  const capital = Number(strike) * Number(contracts) * 100;
  if (!Number.isFinite(capital) || capital <= 0) return null;
  return realizedPnl / capital;
}

// Day-of-week index (0 = Sunday) in UTC for a YYYY-MM-DD date.
function dayOfWeek(iso: string): number {
  return new Date(iso + "T00:00:00Z").getUTCDay();
}

function vixBucket(vix: number | null): "calm" | "elevated" | "panic" | null {
  if (vix === null || !Number.isFinite(vix)) return null;
  if (vix > 25) return "panic";
  if (vix >= 15) return "elevated";
  return "calm";
}

export async function GET(req: NextRequest) {
  const rawWindow = (req.nextUrl.searchParams.get("window") ?? "month") as Window;
  const window: Window = VALID_WINDOWS.includes(rawWindow) ? rawWindow : "month";
  const startDate = windowStart(window);

  const sb = createServerClient();

  // Closed positions — unfiltered first (we need both the windowed set for
  // stats AND the full set for "all-time" ticker rankings per spec).
  // All completed trades regardless of how they closed: user-initiated
  // ('closed'), auto-expired worthless ('expired_worthless'), or assigned
  // ('assigned'). Win rate + expectancy + ROC all roll up over the same
  // set so the page reflects reality.
  const allClosedRes = await sb
    .from("positions")
    .select(
      "id,symbol,strike,expiry,total_contracts,avg_premium_sold,opened_date,closed_date,realized_pnl,entry_final_grade,entry_crush_grade,entry_opportunity_grade,entry_iv_edge,entry_em_pct,entry_vix,status",
    )
    .in("status", ["closed", "expired_worthless", "assigned"])
    .order("closed_date", { ascending: true });
  if (allClosedRes.error) {
    return NextResponse.json({ error: allClosedRes.error.message }, { status: 500 });
  }
  const allClosed = (allClosedRes.data ?? []) as PositionRow[];

  const windowed = startDate
    ? allClosed.filter((p) => (p.closed_date ?? "") >= startDate)
    : allClosed;

  // ---------- Section 1: stats + equity curve ----------
  const totals = windowed.reduce(
    (acc, p) => {
      const pnl = Number(p.realized_pnl ?? 0);
      acc.total_pnl += pnl;
      if (pnl > 0) {
        acc.wins += 1;
        acc.sumWinPnl += pnl;
      } else if (pnl < 0) {
        acc.losses += 1;
        acc.sumLossPnl += pnl;
      }
      const roc = computeROC(pnl, p.strike, p.total_contracts);
      if (roc !== null) {
        acc.rocSum += roc;
        acc.rocCount += 1;
      }
      if (acc.best === null || pnl > acc.best.pnl) {
        acc.best = { symbol: p.symbol, pnl, roc };
      }
      if (acc.worst === null || pnl < acc.worst.pnl) {
        acc.worst = { symbol: p.symbol, pnl, roc };
      }
      return acc;
    },
    {
      total_pnl: 0,
      wins: 0,
      losses: 0,
      sumWinPnl: 0,
      sumLossPnl: 0,
      rocSum: 0,
      rocCount: 0,
      best: null as { symbol: string; pnl: number; roc: number | null } | null,
      worst: null as { symbol: string; pnl: number; roc: number | null } | null,
    },
  );
  const totalTrades = windowed.length;
  const win_rate = totalTrades > 0 ? totals.wins / totalTrades : 0;
  const avg_roc = totals.rocCount > 0 ? totals.rocSum / totals.rocCount : 0;
  const avgWinPnl = totals.wins > 0 ? totals.sumWinPnl / totals.wins : 0;
  const avgLossPnl = totals.losses > 0 ? totals.sumLossPnl / totals.losses : 0;
  const expectancy =
    totalTrades > 0 ? win_rate * avgWinPnl + (1 - win_rate) * avgLossPnl : 0;

  // Equity curve: one point per closed position, x = closed_date,
  // cumulative_pnl = running sum. Already sorted ascending above.
  let running = 0;
  const equity_curve = windowed
    .filter((p) => p.closed_date !== null)
    .map((p) => {
      const trade_pnl = Number(p.realized_pnl ?? 0);
      running += trade_pnl;
      return {
        date: p.closed_date as string,
        symbol: p.symbol,
        trade_pnl,
        cumulative_pnl: running,
      };
    });

  // ---------- Section 2: ticker rankings (uses ALL closed, not windowed) ----------
  type TickerBucket = {
    symbol: string;
    trades: number;
    wins: number;
    rocs: number[];
    bestRoc: number | null;
    grades: Record<string, number>;
    positionIds: string[];
    closedTrades: Array<{
      opened_date: string;
      closed_date: string | null;
      avg_premium_sold: number | null;
      realized_pnl: number | null;
      roc: number | null;
      grade: string | null;
    }>;
  };
  const bySymbol = new Map<string, TickerBucket>();
  for (const p of allClosed) {
    const b = bySymbol.get(p.symbol) ?? {
      symbol: p.symbol,
      trades: 0,
      wins: 0,
      rocs: [],
      bestRoc: null,
      grades: {},
      positionIds: [],
      closedTrades: [],
    };
    b.trades += 1;
    b.positionIds.push(p.id);
    const pnl = Number(p.realized_pnl ?? 0);
    if (pnl > 0) b.wins += 1;
    const roc = computeROC(pnl, p.strike, p.total_contracts);
    if (roc !== null) {
      b.rocs.push(roc);
      if (b.bestRoc === null || roc > b.bestRoc) b.bestRoc = roc;
    }
    const g = p.entry_final_grade ?? "?";
    b.grades[g] = (b.grades[g] ?? 0) + 1;
    b.closedTrades.push({
      opened_date: p.opened_date,
      closed_date: p.closed_date,
      avg_premium_sold: p.avg_premium_sold,
      realized_pnl: p.realized_pnl,
      roc,
      grade: p.entry_final_grade,
    });
    bySymbol.set(p.symbol, b);
  }

  // Fetch all recommendation outcomes in one query, group by position_id.
  const allPositionIds = Array.from(bySymbol.values()).flatMap((b) => b.positionIds);
  const recsBySymbol = new Map<string, { aligned: number; total: number }>();
  if (allPositionIds.length > 0) {
    const recsRes = await sb
      .from("post_earnings_recommendations")
      .select("position_id,recommendation,confidence,was_system_aligned,analysis_date")
      .in("position_id", allPositionIds);
    const allRecs = (recsRes.data ?? []) as RecRow[];
    // Build positionId → symbol reverse map
    const positionIdToSymbol = new Map<string, string>();
    for (const [sym, b] of Array.from(bySymbol.entries())) {
      for (const pid of b.positionIds) positionIdToSymbol.set(pid, sym);
    }
    for (const r of allRecs) {
      if (r.was_system_aligned === null) continue;
      const sym = positionIdToSymbol.get(r.position_id);
      if (!sym) continue;
      const cur = recsBySymbol.get(sym) ?? { aligned: 0, total: 0 };
      cur.total += 1;
      if (r.was_system_aligned === true) cur.aligned += 1;
      recsBySymbol.set(sym, cur);
    }
  }

  const ticker_rankings = Array.from(bySymbol.values())
    .map((b) => {
      const avg_roc = b.rocs.length > 0 ? b.rocs.reduce((s, v) => s + v, 0) / b.rocs.length : null;
      const mostCommonGrade = Object.entries(b.grades).sort(
        (a, b2) => b2[1] - a[1],
      )[0]?.[0] ?? null;
      const recInfo = recsBySymbol.get(b.symbol) ?? null;
      return {
        symbol: b.symbol,
        trades: b.trades,
        wins: b.wins,
        win_rate: b.trades > 0 ? b.wins / b.trades : 0,
        avg_roc,
        best_roc: b.bestRoc,
        top_grade: mostCommonGrade === "?" ? null : mostCommonGrade,
        rec_aligned: recInfo?.aligned ?? null,
        rec_total: recInfo?.total ?? null,
        closed_trades: b.closedTrades.sort((a, b2) =>
          (b2.closed_date ?? "").localeCompare(a.closed_date ?? ""),
        ),
      };
    })
    .sort((a, b) => {
      const ar = a.avg_roc ?? -Infinity;
      const br = b.avg_roc ?? -Infinity;
      return br - ar;
    });

  // ---------- Section 3: pattern intelligence (10+ trade threshold) ----------
  const totalClosedAllTime = allClosed.length;
  const patternsEnabled = totalClosedAllTime >= 10;

  function bucket<K extends string>(
    rows: PositionRow[],
    key: (p: PositionRow) => K | null,
    keys: K[],
  ) {
    const out: Array<{ key: K; trades: number; wins: number; win_rate: number; avg_roc: number | null }> = [];
    for (const k of keys) {
      const subset = rows.filter((p) => key(p) === k);
      const wins = subset.filter((p) => Number(p.realized_pnl ?? 0) > 0).length;
      const rocs = subset
        .map((p) => computeROC(p.realized_pnl, p.strike, p.total_contracts))
        .filter((v): v is number => v !== null);
      const avg_roc = rocs.length > 0 ? rocs.reduce((s, v) => s + v, 0) / rocs.length : null;
      out.push({
        key: k,
        trades: subset.length,
        wins,
        win_rate: subset.length > 0 ? wins / subset.length : 0,
        avg_roc,
      });
    }
    return out;
  }

  const by_grade = bucket(
    allClosed,
    (p) => p.entry_final_grade as "A" | "B" | "C" | "F" | null,
    ["A", "B", "C", "F"],
  );
  const DOW_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
  const by_day_of_week = bucket(
    allClosed.filter((p) => p.closed_date !== null),
    (p) => DOW_LABELS[dayOfWeek(p.closed_date as string)] as (typeof DOW_LABELS)[number],
    ["Mon", "Tue", "Wed", "Thu", "Fri"],
  );
  const by_vix_regime = bucket(
    allClosed,
    (p) => vixBucket(p.entry_vix),
    ["calm", "elevated", "panic"],
  );

  // Calibration check: flag drift when higher grades don't win more.
  const gradeLookup = new Map(by_grade.map((g) => [g.key, g]));
  const a = gradeLookup.get("A");
  const b = gradeLookup.get("B");
  const calibrationDrift =
    !!a && !!b && a.trades > 0 && b.trades > 0 && a.win_rate < b.win_rate;

  // Rec accuracy — only if we have 5+ recorded outcomes.
  let rec_accuracy: {
    close_correct: number;
    close_total: number;
    hold_correct: number;
    hold_total: number;
    overall_pct: number;
  } | null = null;
  if (allPositionIds.length > 0) {
    const recsRes = await sb
      .from("post_earnings_recommendations")
      .select("recommendation,was_system_aligned")
      .in("position_id", allPositionIds);
    const allRecs = ((recsRes.data ?? []) as Array<{
      recommendation: string;
      was_system_aligned: boolean | null;
    }>).filter((r) => r.was_system_aligned !== null);
    if (allRecs.length >= 5) {
      const close = allRecs.filter((r) => r.recommendation === "CLOSE");
      const hold = allRecs.filter((r) => r.recommendation === "HOLD");
      const correct = allRecs.filter((r) => r.was_system_aligned === true).length;
      rec_accuracy = {
        close_correct: close.filter((r) => r.was_system_aligned === true).length,
        close_total: close.length,
        hold_correct: hold.filter((r) => r.was_system_aligned === true).length,
        hold_total: hold.length,
        overall_pct: correct / allRecs.length,
      };
    }
  }

  // ---------- Section 4: export payload ----------
  const vixMap = new Map(by_vix_regime.map((v) => [v.key, v]));
  const export_payload = {
    export_date: new Date().toISOString(),
    summary: {
      total_closed_trades: totalClosedAllTime,
      overall_win_rate:
        totalClosedAllTime > 0
          ? allClosed.filter((p) => Number(p.realized_pnl ?? 0) > 0).length / totalClosedAllTime
          : 0,
      overall_avg_roc: (() => {
        const rocs = allClosed
          .map((p) => computeROC(p.realized_pnl, p.strike, p.total_contracts))
          .filter((v): v is number => v !== null);
        return rocs.length > 0 ? rocs.reduce((s, v) => s + v, 0) / rocs.length : 0;
      })(),
      total_realized_pnl: allClosed.reduce((s, p) => s + Number(p.realized_pnl ?? 0), 0),
    },
    closed_positions: allClosed.map((p) => ({
      symbol: p.symbol,
      strike: Number(p.strike),
      expiry: p.expiry,
      contracts: p.total_contracts,
      avg_premium_sold: p.avg_premium_sold,
      realized_pnl: p.realized_pnl,
      roc: computeROC(p.realized_pnl, p.strike, p.total_contracts),
      opened_date: p.opened_date,
      closed_date: p.closed_date,
      entry_final_grade: p.entry_final_grade,
      entry_crush_grade: p.entry_crush_grade,
      entry_iv_edge: p.entry_iv_edge,
      entry_em_pct: p.entry_em_pct,
      entry_vix: p.entry_vix,
    })),
    grade_accuracy: Object.fromEntries(
      by_grade
        .filter((g) => g.trades > 0)
        .map((g) => [g.key, { trades: g.trades, wins: g.wins, win_rate: g.win_rate }]),
    ),
    ticker_rankings: ticker_rankings.map((t) => ({
      symbol: t.symbol,
      trades: t.trades,
      win_rate: t.win_rate,
      avg_roc: t.avg_roc,
    })),
    patterns: {
      best_day_of_week:
        by_day_of_week.length > 0 && by_day_of_week.some((d) => d.trades > 0)
          ? by_day_of_week.reduce((best, d) => (d.win_rate > best.win_rate ? d : best))
              .key
          : null,
      best_grade:
        by_grade.length > 0 && by_grade.some((g) => g.trades > 0)
          ? by_grade
              .filter((g) => g.trades > 0)
              .reduce((best, g) => (g.win_rate > best.win_rate ? g : best)).key
          : null,
      vix_calm_win_rate: vixMap.get("calm")?.win_rate ?? null,
      vix_elevated_win_rate: vixMap.get("elevated")?.win_rate ?? null,
      vix_panic_win_rate: vixMap.get("panic")?.win_rate ?? null,
    },
  };

  return NextResponse.json({
    window,
    start_date: startDate,
    stats: {
      total_pnl: totals.total_pnl,
      win_rate,
      wins: totals.wins,
      total_trades: totalTrades,
      avg_roc,
      expectancy,
      best_trade: totals.best,
      worst_trade: totals.worst,
    },
    equity_curve,
    ticker_rankings,
    patterns: {
      enabled: patternsEnabled,
      total_closed: totalClosedAllTime,
      by_grade,
      by_day_of_week,
      by_vix_regime,
      calibration: {
        drift: calibrationDrift,
        summary: calibrationDrift
          ? "⚠ Calibration drift: Grade B outperforming Grade A. Review your A-grade selection criteria."
          : a && b && a.trades > 0
            ? "Screener is calibrated: higher grades are winning at higher rates."
            : "Need more A/B trades to assess calibration.",
      },
      rec_accuracy,
    },
    export_payload,
  });
}

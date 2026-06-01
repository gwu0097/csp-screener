import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";
export const revalidate = 0;

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
  broker: string | null;
  position_type: string | null;
  assignment_source_id: string | null;
  entry_stock_price: number | null;
  direction: "short" | "long" | null;
};

type RecRow = {
  position_id: string;
  recommendation: string;
  confidence: string;
  was_system_aligned: boolean | null;
  analysis_date: string;
};

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

function dayOfWeek(iso: string): number {
  return new Date(iso + "T00:00:00Z").getUTCDay();
}

function daysBetweenInclusive(fromIso: string, toIso: string): number {
  const a = Date.parse(fromIso + "T00:00:00Z");
  const b = Date.parse(toIso + "T00:00:00Z");
  return Math.floor((b - a) / 86400000);
}

type Granularity = "day" | "week" | "month";

function granularityFor(days: number): Granularity {
  if (days <= 90) return "day";
  if (days <= 365) return "week";
  return "month";
}

// ISO week — Monday is the first day.
function startOfISOWeekIso(iso: string): string {
  const d = new Date(iso + "T00:00:00Z");
  const day = d.getUTCDay();
  const mondayOffset = (day + 6) % 7;
  d.setUTCDate(d.getUTCDate() - mondayOffset);
  return d.toISOString().slice(0, 10);
}

function startOfMonthIso(iso: string): string {
  return `${iso.slice(0, 7)}-01`;
}

function bucketKeyFor(closedDate: string, g: Granularity): string {
  if (g === "day") return closedDate;
  if (g === "week") return startOfISOWeekIso(closedDate);
  return startOfMonthIso(closedDate);
}

function labelFor(bucketKey: string, g: Granularity): string {
  const d = new Date(bucketKey + "T00:00:00Z");
  if (g === "month") {
    return d.toLocaleDateString("en-US", {
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    });
  }
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function addDaysIso(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function vixBucket(vix: number | null): "calm" | "elevated" | "panic" | null {
  if (vix === null || !Number.isFinite(vix)) return null;
  if (vix > 25) return "panic";
  if (vix >= 15) return "elevated";
  return "calm";
}

// ISO YYYY-MM-DD validation — anything else is ignored and we fall back.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
function validIsoDate(s: string | null): string | null {
  if (!s || !ISO_DATE.test(s)) return null;
  // Guard against nonsense like 2026-13-45
  const d = new Date(s + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return null;
  return s;
}

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const todayIso = new Date().toISOString().slice(0, 10);

  // Default: this month → today. Callers override via ?from=&to=.
  const fromParam = validIsoDate(params.get("from"));
  const toParam = validIsoDate(params.get("to"));
  const from = fromParam ?? `${todayIso.slice(0, 7)}-01`;
  const to = toParam ?? todayIso;

  const brokerRaw = (params.get("broker") ?? "all").toLowerCase();
  const broker = brokerRaw === "all" || brokerRaw === "" ? null : brokerRaw;

  const sb = createServerClient();

  // All closed positions (all-time), optionally broker-filtered. We need
  // both the in-range set (for window stats + equity curve) and the full
  // set (for all-time ticker rankings + pattern intelligence).
  let query = sb
    .from("positions")
    .select(
      "id,symbol,strike,expiry,total_contracts,avg_premium_sold,opened_date,closed_date,realized_pnl,entry_final_grade,entry_crush_grade,entry_opportunity_grade,entry_iv_edge,entry_em_pct,entry_vix,status,broker,position_type,assignment_source_id,entry_stock_price,direction",
    )
    .in("status", ["closed", "expired_worthless", "assigned"])
    .order("closed_date", { ascending: true });
  if (broker) query = query.eq("broker", broker);
  const allClosedRes = await query;
  if (allClosedRes.error) {
    return NextResponse.json({ error: allClosedRes.error.message }, { status: 500 });
  }
  const allClosedRaw = (allClosedRes.data ?? []) as PositionRow[];
  // Partition by position_type. Pre-migration NULL is treated as
  // option. stock_long / stock_short rows have option-shaped columns
  // populated as placeholders (strike=0, option_type='put') and would
  // poison ROC / ticker rankings if included in the option aggregates
  // — we surface them via paired_assignments[] instead.
  const allClosed: PositionRow[] = [];
  const closedStocks: PositionRow[] = [];
  for (const r of allClosedRaw) {
    if (r.position_type === "stock_long" || r.position_type === "stock_short") {
      closedStocks.push(r);
    } else {
      allClosed.push(r);
    }
  }

  // In-range: filter by closed_date within [from, to] inclusive.
  const windowed = allClosed.filter((p) => {
    const cd = p.closed_date ?? "";
    return cd >= from && cd <= to;
  });
  const windowedStocks = closedStocks.filter((p) => {
    const cd = p.closed_date ?? "";
    return cd >= from && cd <= to;
  });
  // Stock realized P&L from closed stock_long / stock_short rows in
  // window. Kept separate from `totals` (option aggregates) so
  // option-only metrics (win_rate, ROC, expectancy, best/worst,
  // ticker rankings) stay pure — stocks have different shape and
  // would distort those. Used to compute the combined headline +
  // injected into the equity curve so the curve reflects actual
  // book P&L instead of option-only.
  const stockTotalPnl = windowedStocks.reduce(
    (s, p) => s + Number(p.realized_pnl ?? 0),
    0,
  );

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

  // Equity curve is bucketed so multiple trades on the same date collapse
  // into a single data point. Granularity stretches with range length so
  // a "year" view doesn't render 250 daily ticks.
  const granularity = granularityFor(daysBetweenInclusive(from, to));
  type BucketAcc = {
    bucketKey: string;
    label: string;
    tradePnl: number;
    tradeCount: number;
    trades: Array<{ symbol: string; pnl: number }>;
  };
  const bucketMap = new Map<string, BucketAcc>();
  const pushIntoBucket = (
    closedDate: string,
    pnl: number,
    label: string,
  ) => {
    const key = bucketKeyFor(closedDate, granularity);
    let b = bucketMap.get(key);
    if (!b) {
      b = {
        bucketKey: key,
        label: labelFor(key, granularity),
        tradePnl: 0,
        tradeCount: 0,
        trades: [],
      };
      bucketMap.set(key, b);
    }
    b.tradePnl += pnl;
    b.tradeCount += 1;
    b.trades.push({ symbol: label, pnl });
  };
  // Fill-level bucketing for fully-closed option positions + stock
  // sales. Partial closes inside the window land on their OWN
  // fill_date rather than getting lumped onto the position's final
  // closed_date. expired_worthless + assigned positions stay
  // position-level because the expire / assign flows never insert
  // close fills — their P&L lives on the row, not in the fills
  // table.
  //
  // Old vs new total can diverge ONLY when a fully-closed position
  // has partial-close fills straddling the window boundary. The
  // log line below prints both so it's visible.
  const fillLevelOptionPositions = allClosed.filter((p) => p.status === "closed");
  const rowLevelOptionPositions = allClosed.filter((p) => p.status !== "closed");
  const parentById = new Map<string, PositionRow>();
  for (const p of fillLevelOptionPositions) parentById.set(p.id, p);
  for (const p of closedStocks) parentById.set(p.id, p);

  let fillLevelOptionsTotal = 0;
  let fillLevelStocksTotal = 0;
  const fillLevelIds = [
    ...fillLevelOptionPositions.map((p) => p.id),
    ...closedStocks.map((p) => p.id),
  ];
  if (fillLevelIds.length > 0) {
    const fillsRes = await sb
      .from("fills")
      .select("position_id,fill_date,contracts,premium")
      .eq("fill_type", "close")
      .in("position_id", fillLevelIds)
      .gte("fill_date", from)
      .lte("fill_date", to);
    if (fillsRes.error) {
      console.warn(
        `[intelligence] close fills fetch failed — falling back to row-level: ${fillsRes.error.message}`,
      );
    } else {
      const fillRows = (fillsRes.data ?? []) as Array<{
        position_id: string;
        fill_date: string;
        contracts: number;
        premium: number;
      }>;
      for (const f of fillRows) {
        const parent = parentById.get(f.position_id);
        if (!parent) continue;
        const isStock =
          parent.position_type === "stock_long" ||
          parent.position_type === "stock_short";
        let pnl: number;
        if (isStock) {
          // Stock per-share: (sale price − cost basis) × shares. No
          // × 100 multiplier here — premium IS the per-share dollar
          // value and contracts is the share count.
          const basis = Number(parent.entry_stock_price ?? 0);
          pnl = (Number(f.premium) - basis) * Number(f.contracts);
          fillLevelStocksTotal += pnl;
        } else {
          // Options: avg open premium against this close fill's
          // premium, sign-flipped for longs. Uses the row's stored
          // avg_premium_sold so this matches the existing
          // realizedPnl(fills, direction) math (recomputed on the
          // server every recalc).
          const avg = Number(parent.avg_premium_sold ?? 0);
          const direction = parent.direction === "long" ? "long" : "short";
          const diff =
            direction === "long"
              ? Number(f.premium) - avg
              : avg - Number(f.premium);
          pnl = diff * Number(f.contracts) * 100;
          fillLevelOptionsTotal += pnl;
        }
        pushIntoBucket(f.fill_date, pnl, isStock ? `${parent.symbol} (stock)` : parent.symbol);
      }
    }
  }

  // expired_worthless + assigned (no fills) — bucket on closed_date.
  let rowLevelTotal = 0;
  for (const p of rowLevelOptionPositions) {
    if (!p.closed_date) continue;
    if (p.closed_date < from || p.closed_date > to) continue;
    const pnl = Number(p.realized_pnl ?? 0);
    rowLevelTotal += pnl;
    pushIntoBucket(p.closed_date, pnl, p.symbol);
  }

  const oldEquityTotal =
    windowed.reduce((s, p) => s + Number(p.realized_pnl ?? 0), 0) +
    windowedStocks.reduce((s, p) => s + Number(p.realized_pnl ?? 0), 0);
  const newEquityTotal =
    fillLevelOptionsTotal + fillLevelStocksTotal + rowLevelTotal;
  const equityDelta =
    Math.round((newEquityTotal - oldEquityTotal) * 100) / 100;
  console.log(
    `[intelligence] equity_curve totals: old=${oldEquityTotal.toFixed(2)} new=${newEquityTotal.toFixed(2)} delta=${equityDelta.toFixed(2)} (delta != 0 ⇒ partial closes straddling window boundary)`,
  );

  // Zero-fill only on day granularity so the line stays continuous across
  // weekends / no-trade days. Week + month buckets skip the fill — empty
  // months would stretch the x-axis without adding information.
  if (granularity === "day") {
    let cursor = from;
    while (cursor <= to) {
      if (!bucketMap.has(cursor)) {
        bucketMap.set(cursor, {
          bucketKey: cursor,
          label: labelFor(cursor, "day"),
          tradePnl: 0,
          tradeCount: 0,
          trades: [],
        });
      }
      cursor = addDaysIso(cursor, 1);
    }
  }

  const sortedKeys = Array.from(bucketMap.keys()).sort();
  let running = 0;
  const equity_curve = sortedKeys.map((k) => {
    const b = bucketMap.get(k)!;
    running += b.tradePnl;
    return {
      bucketKey: b.bucketKey,
      label: b.label,
      tradePnl: b.tradePnl,
      cumulativePnl: running,
      tradeCount: b.tradeCount,
      trades: b.trades,
    };
  });

  // ---------- Section 2: ticker rankings (uses ALL closed within broker filter) ----------
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

  const allPositionIds = Array.from(bySymbol.values()).flatMap((b) => b.positionIds);
  const recsBySymbol = new Map<string, { aligned: number; total: number }>();
  if (allPositionIds.length > 0) {
    const recsRes = await sb
      .from("post_earnings_recommendations")
      .select("position_id,recommendation,confidence,was_system_aligned,analysis_date")
      .in("position_id", allPositionIds);
    const allRecs = (recsRes.data ?? []) as RecRow[];
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

  const gradeLookup = new Map(by_grade.map((g) => [g.key, g]));
  const a = gradeLookup.get("A");
  const b = gradeLookup.get("B");
  const calibrationDrift =
    !!a && !!b && a.trades > 0 && b.trades > 0 && a.win_rate < b.win_rate;

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
    date_range: { from, to },
    broker_filter: broker ?? "all",
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
      broker: p.broker,
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

  // ---------- Section: paired assignments ----------
  // For each closed stock_long that came from a put assignment,
  // surface the linked put + stock pair as a combined trade
  // summary. Driven by assignment_source_id. Open stocks are not
  // included — the closing P&L only crystallizes on sale.
  const putById = new Map<string, PositionRow>();
  for (const r of allClosedRaw) {
    if (r.position_type === "stock_long" || r.position_type === "stock_short") continue;
    putById.set(r.id, r);
  }
  type PairedAssignment = {
    symbol: string;
    broker: string | null;
    parent: {
      positionId: string;
      strike: number;
      expiry: string;
      contracts: number;
      avgPremiumSold: number | null;
      realizedPnl: number;
      closedDate: string | null;
    } | null;
    stock: {
      positionId: string;
      shares: number;
      costBasis: number | null;
      realizedPnl: number;
      closedDate: string | null;
    };
    totalPnl: number;
  };
  const paired_assignments: PairedAssignment[] = [];
  for (const s of closedStocks) {
    if (!s.assignment_source_id) continue;
    const parent = putById.get(s.assignment_source_id) ?? null;
    const stockPnl = Number(s.realized_pnl ?? 0);
    const parentPnl = parent ? Number(parent.realized_pnl ?? 0) : 0;
    paired_assignments.push({
      symbol: s.symbol,
      broker: s.broker,
      parent: parent
        ? {
            positionId: parent.id,
            strike: Number(parent.strike),
            expiry: parent.expiry,
            contracts: Number(parent.total_contracts ?? 0),
            avgPremiumSold:
              parent.avg_premium_sold !== null
                ? Number(parent.avg_premium_sold)
                : null,
            realizedPnl: parentPnl,
            closedDate: parent.closed_date,
          }
        : null,
      stock: {
        positionId: s.id,
        shares: Number(s.total_contracts ?? 0),
        costBasis:
          s.entry_stock_price !== null ? Number(s.entry_stock_price) : null,
        realizedPnl: stockPnl,
        closedDate: s.closed_date,
      },
      totalPnl: Math.round((stockPnl + parentPnl) * 100) / 100,
    });
  }
  paired_assignments.sort((a, b) =>
    (b.stock.closedDate ?? "").localeCompare(a.stock.closedDate ?? ""),
  );

  // ---------- Section: partial closes ----------
  // Open positions that already have a non-zero realized_pnl —
  // someone bought back / sold a portion but left the rest open.
  // Surfaced separately (NOT rolled into total_pnl / win_rate /
  // ROC) because the position hasn't fully resolved yet and the
  // realized number is provisional. Broker filter respected.
  let partialQuery = sb
    .from("positions")
    .select(
      "id,symbol,strike,broker,position_type,realized_pnl,total_contracts,updated_at,closed_date",
    )
    .eq("status", "open");
  if (broker) partialQuery = partialQuery.eq("broker", broker);
  const partialRes = await partialQuery;
  type PartialRow = {
    id: string;
    symbol: string;
    strike: number | null;
    broker: string | null;
    position_type: string | null;
    realized_pnl: number;
    total_contracts: number | null;
    updated_at: string;
    closed_date: string | null;
  };
  // Filter in JS — the custom REST client doesn't expose .not() /
  // .neq() for null + zero checks together. Match the SQL guard:
  // realized_pnl IS NOT NULL AND realized_pnl != 0 AND closed_date
  // IS NULL.
  const partialRows = ((partialRes.data ?? []) as PartialRow[]).filter(
    (p) =>
      p.closed_date === null &&
      p.realized_pnl !== null &&
      Math.abs(Number(p.realized_pnl)) > 0.001,
  );

  // Compute remaining contracts (or shares) per position from fills.
  const remainingByPosition = new Map<string, number>();
  if (partialRows.length > 0) {
    const ids = partialRows.map((p) => p.id);
    const fillsRes = await sb
      .from("fills")
      .select("position_id,fill_type,contracts")
      .in("position_id", ids);
    type FillProbe = {
      position_id: string;
      fill_type: string;
      contracts: number;
    };
    const byPos = new Map<string, FillProbe[]>();
    for (const f of (fillsRes.data ?? []) as FillProbe[]) {
      const arr = byPos.get(f.position_id) ?? [];
      arr.push(f);
      byPos.set(f.position_id, arr);
    }
    for (const id of ids) {
      const fills = byPos.get(id) ?? [];
      const opened = fills
        .filter((f) => f.fill_type === "open")
        .reduce((s, f) => s + Number(f.contracts), 0);
      const closed = fills
        .filter((f) => f.fill_type === "close")
        .reduce((s, f) => s + Number(f.contracts), 0);
      remainingByPosition.set(id, Math.max(0, opened - closed));
    }
  }

  type PartialClose = {
    positionId: string;
    symbol: string;
    strike: number;
    broker: string | null;
    positionType: "option" | "stock_long" | "stock_short";
    realizedPnl: number;
    remainingContracts: number;
    updatedAt: string;
  };
  const partial_closes: PartialClose[] = partialRows
    .map((p) => {
      const remaining = remainingByPosition.get(p.id) ?? 0;
      const pt =
        p.position_type === "stock_long" || p.position_type === "stock_short"
          ? (p.position_type as "stock_long" | "stock_short")
          : ("option" as const);
      return {
        positionId: p.id,
        symbol: p.symbol,
        strike: Number(p.strike ?? 0),
        broker: p.broker,
        positionType: pt,
        realizedPnl: Number(p.realized_pnl),
        remainingContracts: remaining,
        updatedAt: p.updated_at,
      };
    })
    .filter((p) => p.remainingContracts > 0)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const total_partial_pnl =
    Math.round(
      partial_closes.reduce((s, p) => s + p.realizedPnl, 0) * 100,
    ) / 100;

  return NextResponse.json({
    date_range: { from, to },
    broker: broker ?? "all",
    granularity,
    stats: {
      total_pnl: totals.total_pnl,
      // Combined headline includes closed stock_long realized so the
      // Realized P&L card reflects actual book P&L. Option-only
      // metrics (win_rate, avg_roc, expectancy, best/worst) stay
      // option-only — stocks have a different shape and would skew
      // them.
      stock_total_pnl: stockTotalPnl,
      combined_realized_pnl:
        Math.round((totals.total_pnl + stockTotalPnl) * 100) / 100,
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
    paired_assignments,
    partial_closes,
    total_partial_pnl,
    export_payload,
  });
}

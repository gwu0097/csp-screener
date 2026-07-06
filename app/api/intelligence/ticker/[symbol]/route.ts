import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { requireUserId, authErrorResponse } from "@/lib/auth";
import { gradeFromRatio } from "@/lib/earnings-history-table";
import { getCompanyProfile } from "@/lib/yahoo";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// GET /api/intelligence/ticker/[symbol]
//
// Point-of-decision intelligence for one ticker, rendered by the
// TickerIntelligenceStrip in the screener expanded row and the Deep
// Research page. Four data points in one call:
//   1. history      — the caller's closed trades on this symbol
//   2. sector       — the caller's performance across the symbol's industry
//   3. calibration  — actual-vs-implied earnings move (ticker, or the
//                     industry universe when the ticker has <3 pairs)
//   4. crush        — encyclopedia crush grade (gradeFromRatio bands)
//
// Cached in-process for 15 minutes per (user, symbol) — none of these
// inputs change trade-to-trade. Cache-Control mirrors that client-side.

type Payload = {
  symbol: string;
  history: { trades: number; wins: number; win_rate: number; avg_roc: number | null } | null;
  sector: {
    industry: string;
    trades: number;
    wins: number;
    win_rate: number;
    avg_roc: number | null;
  } | null;
  calibration: {
    scope: "ticker" | "sector";
    events: number;
    avg_ratio: number;
    within_implied_pct: number;
  } | null;
  crush: { grade: string; avg_move_ratio: number; events: number } | null;
};

const CACHE_TTL_MS = 15 * 60 * 1000;
const cache = new Map<string, { at: number; payload: Payload }>();

function computeROC(pnl: number, strike: number, contracts: number): number | null {
  const capital = strike * contracts * 100;
  if (!Number.isFinite(capital) || capital <= 0) return null;
  return pnl / capital;
}

type PosRow = {
  symbol: string;
  strike: number;
  total_contracts: number;
  realized_pnl: number | null;
  position_type: string | null;
};

function aggregate(rows: PosRow[]): {
  trades: number;
  wins: number;
  win_rate: number;
  avg_roc: number | null;
} | null {
  if (rows.length === 0) return null;
  let wins = 0;
  const rocs: number[] = [];
  for (const p of rows) {
    const pnl = Number(p.realized_pnl ?? 0);
    if (pnl > 0) wins += 1;
    const roc = computeROC(pnl, Number(p.strike), Number(p.total_contracts));
    if (roc !== null) rocs.push(roc);
  }
  return {
    trades: rows.length,
    wins,
    win_rate: wins / rows.length,
    avg_roc: rocs.length > 0 ? rocs.reduce((s, v) => s + v, 0) / rocs.length : null,
  };
}

type EmPair = { symbol: string; implied_move_pct: number | string; actual_move_pct: number | string | null };

function calibrationFrom(pairs: EmPair[]): {
  events: number;
  avg_ratio: number;
  within_implied_pct: number;
} | null {
  const ratios: number[] = [];
  let within = 0;
  for (const r of pairs) {
    const implied = Number(r.implied_move_pct);
    const actual = r.actual_move_pct === null ? NaN : Math.abs(Number(r.actual_move_pct));
    if (!Number.isFinite(implied) || implied <= 0 || !Number.isFinite(actual)) continue;
    ratios.push(actual / implied);
    if (actual < implied) within += 1;
  }
  if (ratios.length === 0) return null;
  return {
    events: ratios.length,
    avg_ratio: ratios.reduce((s, v) => s + v, 0) / ratios.length,
    within_implied_pct: within / ratios.length,
  };
}

export async function GET(
  _req: NextRequest,
  { params }: { params: { symbol: string } },
) {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch (e) {
    return authErrorResponse(e);
  }
  const symbol = (params.symbol ?? "").trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(symbol)) {
    return NextResponse.json({ error: "Invalid symbol" }, { status: 400 });
  }

  const cacheKey = `${userId}:${symbol}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return NextResponse.json(hit.payload, {
      headers: { "Cache-Control": "private, max-age=900" },
    });
  }

  const sb = createServerClient();

  // Parallel base reads: symbol's closed history, its stock_profiles
  // row, its earnings pairs, and its encyclopedia row.
  const [histRes, profRes, emRes, encRes] = await Promise.all([
    sb
      .from("positions")
      .select("symbol,strike,total_contracts,realized_pnl,position_type")
      .eq("user_id", userId)
      .eq("symbol", symbol)
      .in("status", ["closed", "expired_worthless", "assigned"]),
    sb.from("stock_profiles").select("symbol,industry").eq("symbol", symbol).limit(1),
    sb
      .from("earnings_history")
      .select("symbol,implied_move_pct,actual_move_pct")
      .eq("symbol", symbol)
      .gt("implied_move_pct", 0),
    sb
      .from("stock_encyclopedia")
      .select("avg_move_ratio,total_earnings_records")
      .eq("symbol", symbol)
      .limit(1),
  ]);

  const optionRows = ((histRes.data ?? []) as PosRow[]).filter(
    (p) => p.position_type !== "stock_long" && p.position_type !== "stock_short",
  );
  const history = aggregate(optionRows);

  let industry =
    ((profRes.data ?? []) as Array<{ industry: string | null }>)[0]?.industry ?? null;
  // Self-healing industry: stock_profiles rows predate the industry
  // column being reliably populated. First view of a symbol fills it
  // from Yahoo and persists, so the sector section works for any
  // ticker — not only ones a screener run happened to profile.
  if (!industry) {
    const prof = await getCompanyProfile(symbol).catch(() => null);
    if (prof?.industry) {
      industry = prof.industry;
      const up = await sb
        .from("stock_profiles")
        .upsert({ symbol, industry }, { onConflict: "symbol" });
      if (up.error) {
        console.warn(`[ticker-intel] industry persist(${symbol}) failed: ${up.error.message}`);
      }
    }
  }

  // Sector context: the caller's closed trades across every symbol in
  // this industry (including this one).
  let sector: Payload["sector"] = null;
  let industrySymbols: string[] = [];
  if (industry) {
    const symsRes = await sb
      .from("stock_profiles")
      .select("symbol")
      .eq("industry", industry)
      .limit(300);
    industrySymbols = ((symsRes.data ?? []) as Array<{ symbol: string }>).map((r) =>
      r.symbol.toUpperCase(),
    );
    if (industrySymbols.length > 0) {
      const secRes = await sb
        .from("positions")
        .select("symbol,strike,total_contracts,realized_pnl,position_type")
        .eq("user_id", userId)
        .in("symbol", industrySymbols)
        .in("status", ["closed", "expired_worthless", "assigned"]);
      const rows = ((secRes.data ?? []) as PosRow[]).filter(
        (p) => p.position_type !== "stock_long" && p.position_type !== "stock_short",
      );
      const agg = aggregate(rows);
      if (agg) sector = { industry, ...agg };
      else sector = { industry, trades: 0, wins: 0, win_rate: 0, avg_roc: null };
    } else {
      sector = { industry, trades: 0, wins: 0, win_rate: 0, avg_roc: null };
    }
  }

  // Calibration: ticker-scoped when it has 3+ pairs, otherwise the
  // industry universe.
  let calibration: Payload["calibration"] = null;
  const tickerCal = calibrationFrom((emRes.data ?? []) as EmPair[]);
  if (tickerCal && tickerCal.events >= 3) {
    calibration = { scope: "ticker", ...tickerCal };
  } else if (industrySymbols.length > 0) {
    const sectorEmRes = await sb
      .from("earnings_history")
      .select("symbol,implied_move_pct,actual_move_pct")
      .in("symbol", industrySymbols)
      .gt("implied_move_pct", 0);
    const sectorCal = calibrationFrom((sectorEmRes.data ?? []) as EmPair[]);
    if (sectorCal && sectorCal.events >= 3) {
      calibration = { scope: "sector", ...sectorCal };
    }
  }
  // A thin ticker sample (1-2 events) is still better than nothing when
  // the sector has no data either.
  if (!calibration && tickerCal) calibration = { scope: "ticker", ...tickerCal };

  const encRow = ((encRes.data ?? []) as Array<{
    avg_move_ratio: number | string | null;
    total_earnings_records: number | null;
  }>)[0];
  let crush: Payload["crush"] = null;
  if (encRow && encRow.avg_move_ratio !== null) {
    const ratio = Number(encRow.avg_move_ratio);
    const grade = gradeFromRatio(ratio);
    if (grade) {
      crush = {
        grade,
        avg_move_ratio: ratio,
        events: Number(encRow.total_earnings_records ?? 0),
      };
    }
  }
  // Encyclopedia aggregates only cover symbols the maintenance sweep
  // has ingested. Same quantity, same bands — derive the grade from
  // the ticker's own calibration pairs when the encyclopedia row is
  // missing or hollow.
  if (!crush && tickerCal && tickerCal.events >= 2) {
    const grade = gradeFromRatio(tickerCal.avg_ratio);
    if (grade) {
      crush = {
        grade,
        avg_move_ratio: tickerCal.avg_ratio,
        events: tickerCal.events,
      };
    }
  }

  const payload: Payload = { symbol, history, sector, calibration, crush };
  cache.set(cacheKey, { at: Date.now(), payload });
  // Opportunistic sweep so a long-lived instance doesn't grow unbounded.
  if (cache.size > 500) {
    const cutoff = Date.now() - CACHE_TTL_MS;
    for (const [k, v] of Array.from(cache.entries())) {
      if (v.at < cutoff) cache.delete(k);
    }
  }
  return NextResponse.json(payload, {
    headers: { "Cache-Control": "private, max-age=900" },
  });
}

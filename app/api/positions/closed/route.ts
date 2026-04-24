import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import {
  remainingContracts,
  type Fill,
  type PositionRow,
} from "@/lib/positions";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// Lightweight closed-positions endpoint. Parallels /api/positions/open
// but skips the Schwab chain + Yahoo batch fetch — closed positions have
// no live price/Greeks to resolve. Used by the Positions page's
// collapsed "closed" section, fetched lazily when the user expands it.
type ClosedPositionView = {
  id: string;
  symbol: string;
  broker: string;
  strike: number;
  expiry: string;
  optionType: "put" | "call";
  totalContracts: number;
  remainingContracts: number;
  avgPremiumSold: number | null;
  openedDate: string;
  closedDate: string | null;
  realizedPnl: number | null;
  status: "closed" | "expired_worthless" | "assigned";
  entryFinalGrade: string | null;
  entryCrushGrade: string | null;
  entryOpportunityGrade: string | null;
  entryIndustryGrade: string | null;
  entryRegimeGrade: string | null;
  entryIvEdge: number | null;
  entryEmPct: number | null;
  entryVix: number | null;
  entryStockPrice: number | null;
  fills: Fill[];
  postEarningsRec: {
    recommendation: "CLOSE" | "HOLD" | "PARTIAL" | "MONITOR";
    confidence: "HIGH" | "MEDIUM" | "LOW";
    reasoning: string;
    ruleFired: string;
    analysisDate: string;
    moveRatio: number | null;
    ivCrushed: boolean | null;
    ivCrushMagnitude: number | null;
    breachedTwoXem: boolean | null;
    analystSentiment: string | null;
    recoveryLikelihood: string | null;
    stockPctFromStrike: number | null;
  } | null;
};

type PositionRowFull = PositionRow & {
  option_type?: "put" | "call";
  entry_final_grade: string | null;
  entry_crush_grade: string | null;
  entry_opportunity_grade: string | null;
  entry_industry_grade: string | null;
  entry_regime_grade: string | null;
  entry_iv_edge: number | null;
  entry_em_pct: number | null;
  entry_vix: number | null;
  entry_stock_price: number | null;
};

export async function GET() {
  const supabase = createServerClient();

  // Includes auto-expired-worthless and assigned positions so the
  // closed section surfaces every completed trade, not just the ones
  // the user explicitly closed.
  const { data: posRows, error } = await supabase
    .from<PositionRowFull>("positions")
    .select("*")
    .in("status", ["closed", "expired_worthless", "assigned"])
    .order("closed_date", { ascending: false });
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  const positions = (posRows ?? []) as PositionRowFull[];
  if (positions.length === 0) {
    return NextResponse.json({ positions: [] });
  }

  const positionIds = positions.map((p) => p.id);

  const fillsByPosition = new Map<string, Fill[]>();
  const { data: fillsRows } = await supabase
    .from<Fill & { position_id: string }>("fills")
    .select("position_id, fill_type, contracts, premium, fill_date")
    .in("position_id", positionIds);
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

  // Entry-grade fallback — mirrors the open route. Positions opened
  // before the grade-merge feature land with null entry_final_grade;
  // fall back to the most recent tracked_tickers entry for that symbol
  // so the closed-positions UI shows a badge consistent with the open
  // side.
  const gradeFallbackBySymbol = new Map<string, string | null>();
  {
    const symbols = Array.from(new Set(positions.map((p) => p.symbol.toUpperCase())));
    if (symbols.length > 0) {
      const trRes = await supabase
        .from("tracked_tickers")
        .select("symbol,entry_final_grade,screened_date")
        .in("symbol", symbols)
        .order("screened_date", { ascending: false });
      const trRows = (trRes.data ?? []) as Array<{
        symbol: string;
        entry_final_grade: string | null;
      }>;
      for (const r of trRows) {
        const sym = r.symbol.toUpperCase();
        if (gradeFallbackBySymbol.has(sym)) continue;
        if (r.entry_final_grade) gradeFallbackBySymbol.set(sym, r.entry_final_grade);
      }
    }
  }

  // Latest recommendation per position — same pattern as the open route.
  const recsByPosition = new Map<string, ClosedPositionView["postEarningsRec"]>();
  const recRes = await supabase
    .from("post_earnings_recommendations")
    .select(
      "position_id,analysis_date,move_ratio,iv_crushed,iv_crush_magnitude,breached_two_x_em,analyst_sentiment,recovery_likelihood,stock_pct_from_strike,recommendation,confidence,reasoning,rule_fired",
    )
    .in("position_id", positionIds)
    .order("analysis_date", { ascending: false });
  for (const r of (recRes.data ?? []) as Array<{
    position_id: string;
    analysis_date: string;
    move_ratio: number | null;
    iv_crushed: boolean | null;
    iv_crush_magnitude: number | null;
    breached_two_x_em: boolean | null;
    analyst_sentiment: string | null;
    recovery_likelihood: string | null;
    stock_pct_from_strike: number | null;
    recommendation: "CLOSE" | "HOLD" | "PARTIAL" | "MONITOR";
    confidence: "HIGH" | "MEDIUM" | "LOW";
    reasoning: string;
    rule_fired: string;
  }>) {
    if (recsByPosition.has(r.position_id)) continue;
    recsByPosition.set(r.position_id, {
      recommendation: r.recommendation,
      confidence: r.confidence,
      reasoning: r.reasoning,
      ruleFired: r.rule_fired,
      analysisDate: r.analysis_date,
      moveRatio: r.move_ratio,
      ivCrushed: r.iv_crushed,
      ivCrushMagnitude: r.iv_crush_magnitude,
      breachedTwoXem: r.breached_two_x_em,
      analystSentiment: r.analyst_sentiment,
      recoveryLikelihood: r.recovery_likelihood,
      stockPctFromStrike: r.stock_pct_from_strike,
    });
  }

  const out: ClosedPositionView[] = positions.map((p) => {
    const fills = fillsByPosition.get(p.id) ?? [];
    return {
      id: p.id,
      symbol: p.symbol,
      broker: p.broker,
      strike: Number(p.strike),
      expiry: p.expiry,
      optionType: (p.option_type ?? "put") as "put" | "call",
      totalContracts: p.total_contracts,
      remainingContracts: remainingContracts(fills),
      avgPremiumSold: p.avg_premium_sold !== null ? Number(p.avg_premium_sold) : null,
      openedDate: p.opened_date,
      closedDate: p.closed_date,
      realizedPnl: p.realized_pnl,
      status:
        (p.status as "closed" | "expired_worthless" | "assigned" | undefined) ??
        "closed",
      entryFinalGrade:
        p.entry_final_grade ??
        gradeFallbackBySymbol.get(p.symbol.toUpperCase()) ??
        null,
      entryCrushGrade: p.entry_crush_grade,
      entryOpportunityGrade: p.entry_opportunity_grade,
      entryIndustryGrade: p.entry_industry_grade,
      entryRegimeGrade: p.entry_regime_grade,
      entryIvEdge: p.entry_iv_edge,
      entryEmPct: p.entry_em_pct,
      entryVix: p.entry_vix,
      entryStockPrice: p.entry_stock_price,
      fills: fills.sort((a, b) => a.fill_date.localeCompare(b.fill_date)),
      postEarningsRec: recsByPosition.get(p.id) ?? null,
    };
  });

  return NextResponse.json({ positions: out });
}

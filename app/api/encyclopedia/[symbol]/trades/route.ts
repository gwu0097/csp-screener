import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// Closed positions for a single symbol — drives the My Trades tab on
// /encyclopedia/[symbol]. Distinct from /api/positions/closed in that
// it's symbol-scoped and returns only the fields the per-stock page
// renders (no fills, no post-earnings recs, no entry-grade fallback).

type ClosedRow = {
  id: string;
  symbol: string;
  strike: number;
  expiry: string;
  option_type: string | null;
  broker: string | null;
  total_contracts: number | null;
  avg_premium_sold: number | string | null;
  status: string;
  opened_date: string;
  closed_date: string | null;
  realized_pnl: number | string | null;
  notes: string | null;
};

type Outcome = "expired_worthless" | "assigned" | "closed";

type TradeView = {
  id: string;
  openedDate: string;
  closedDate: string | null;
  strike: number;
  expiry: string;
  optionType: string | null;
  broker: string | null;
  contracts: number | null;
  premiumSold: number | null;
  realizedPnl: number | null;
  outcome: Outcome;
  notes: string | null;
};

type Summary = {
  totalTrades: number;
  totalPnl: number;
  winRate: number | null; // 0..1, null when no trades had a non-zero pnl
  expiredWorthless: number;
  assigned: number;
  closed: number;
};

function toNum(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim().length > 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: { symbol: string } },
): Promise<NextResponse> {
  const symbol = (params.symbol ?? "").trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol)) {
    return NextResponse.json({ error: "Invalid symbol" }, { status: 400 });
  }
  const sb = createServerClient();
  const r = await sb
    .from("positions")
    .select(
      "id,symbol,strike,expiry,option_type,broker,total_contracts,avg_premium_sold,status,opened_date,closed_date,realized_pnl,notes",
    )
    .eq("symbol", symbol)
    .in("status", ["closed", "expired_worthless", "assigned"])
    .order("closed_date", { ascending: false });
  if (r.error) {
    return NextResponse.json({ error: r.error.message }, { status: 500 });
  }
  const rows = (r.data ?? []) as ClosedRow[];

  const trades: TradeView[] = rows.map((row) => ({
    id: row.id,
    openedDate: row.opened_date,
    closedDate: row.closed_date,
    strike: Number(row.strike),
    expiry: row.expiry,
    optionType: row.option_type,
    broker: row.broker,
    contracts: row.total_contracts,
    premiumSold: toNum(row.avg_premium_sold),
    realizedPnl: toNum(row.realized_pnl),
    outcome: row.status as Outcome,
    notes: row.notes,
  }));

  const wins = trades.filter((t) => (t.realizedPnl ?? 0) > 0).length;
  const losses = trades.filter((t) => (t.realizedPnl ?? 0) < 0).length;
  const decided = wins + losses;
  const summary: Summary = {
    totalTrades: trades.length,
    totalPnl: trades.reduce((acc, t) => acc + (t.realizedPnl ?? 0), 0),
    winRate: decided > 0 ? wins / decided : null,
    expiredWorthless: trades.filter((t) => t.outcome === "expired_worthless")
      .length,
    assigned: trades.filter((t) => t.outcome === "assigned").length,
    closed: trades.filter((t) => t.outcome === "closed").length,
  };

  return NextResponse.json({ trades, summary });
}

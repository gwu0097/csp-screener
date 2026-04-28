import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// GET /api/research/[symbol]/earnings-releases
//
// Returns every earnings_releases row stored for this symbol, ordered
// by reported_date DESC (newest first). The 10-K tab consumes this
// straight into the SEC Filings card; the POST sibling at /fetch-8k
// is what actually populates rows.

export type EarningsReleaseRow = {
  id: string;
  symbol: string;
  quarter: string;
  period_end: string;
  reported_date: string;
  accession_number: string | null;
  revenue: number | null;
  revenue_growth_pct: number | null;
  op_income: number | null;
  op_margin_pct: number | null;
  net_income: number | null;
  net_margin_pct: number | null;
  eps_diluted: number | null;
  guidance_notes: string | null;
  raw_metrics: Record<string, unknown> | null;
  source: string | null;
  created_at: string | null;
};

function validSymbol(s: string): boolean {
  return /^[A-Z][A-Z0-9.-]{0,9}$/.test(s);
}

export async function GET(
  _req: NextRequest,
  { params }: { params: { symbol: string } },
): Promise<NextResponse> {
  const symbol = (params.symbol ?? "").trim().toUpperCase();
  if (!validSymbol(symbol)) {
    return NextResponse.json({ error: "Invalid symbol" }, { status: 400 });
  }
  const sb = createServerClient();
  const r = await sb
    .from("earnings_releases")
    .select(
      "id,symbol,quarter,period_end,reported_date,accession_number,revenue,revenue_growth_pct,op_income,op_margin_pct,net_income,net_margin_pct,eps_diluted,guidance_notes,raw_metrics,source,created_at",
    )
    .eq("symbol", symbol)
    .order("reported_date", { ascending: false });
  if (r.error) {
    return NextResponse.json({ error: r.error.message }, { status: 500 });
  }
  return NextResponse.json({ releases: (r.data ?? []) as EarningsReleaseRow[] });
}

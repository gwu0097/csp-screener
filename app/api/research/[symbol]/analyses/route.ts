import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// Pasted Claude analyses per filing (filing_analyses table).
//   GET  → all rows for the symbol, newest filing first
//   POST → save a new analysis { filing_type, period, filing_date?, analysis_text }

export type FilingAnalysisRow = {
  id: string;
  symbol: string;
  filing_type: string;
  period: string;
  filing_date: string | null;
  analysis_text: string;
  reviewed_at: string;
  notes: string | null;
};

const FILING_TYPES = new Set(["8-K", "10-Q", "10-K"]);

function validSymbol(raw: string): string | null {
  const sym = raw.trim().toUpperCase();
  return /^[A-Z][A-Z0-9.-]{0,9}$/.test(sym) ? sym : null;
}

type Params = { params: { symbol: string } };

export async function GET(_req: NextRequest, { params }: Params) {
  const symbol = validSymbol(params.symbol);
  if (!symbol) {
    return NextResponse.json({ error: "Invalid symbol" }, { status: 400 });
  }
  const sb = createServerClient();
  const r = await sb
    .from("filing_analyses")
    .select("*")
    .eq("symbol", symbol)
    .order("filing_date", { ascending: false })
    .order("reviewed_at", { ascending: false });
  if (r.error) {
    return NextResponse.json({ error: r.error.message }, { status: 500 });
  }
  return NextResponse.json({ analyses: (r.data ?? []) as FilingAnalysisRow[] });
}

export async function POST(req: NextRequest, { params }: Params) {
  const symbol = validSymbol(params.symbol);
  if (!symbol) {
    return NextResponse.json({ error: "Invalid symbol" }, { status: 400 });
  }
  let body: {
    filing_type?: unknown;
    period?: unknown;
    filing_date?: unknown;
    analysis_text?: unknown;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const filingType =
    typeof body.filing_type === "string" ? body.filing_type.trim() : "";
  if (!FILING_TYPES.has(filingType)) {
    return NextResponse.json(
      { error: "filing_type must be one of 8-K, 10-Q, 10-K" },
      { status: 400 },
    );
  }
  const period = typeof body.period === "string" ? body.period.trim() : "";
  if (!period || period.length > 20) {
    return NextResponse.json(
      { error: "period is required (max 20 chars, e.g. 'Q1 2026')" },
      { status: 400 },
    );
  }
  const filingDate =
    typeof body.filing_date === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(body.filing_date)
      ? body.filing_date
      : null;
  const analysisText =
    typeof body.analysis_text === "string" ? body.analysis_text.trim() : "";
  if (!analysisText) {
    return NextResponse.json(
      { error: "analysis_text is required" },
      { status: 400 },
    );
  }
  if (analysisText.length > 200_000) {
    return NextResponse.json(
      { error: "analysis_text too large (200k char limit)" },
      { status: 400 },
    );
  }

  const sb = createServerClient();
  const r = await sb
    .from("filing_analyses")
    .insert({
      symbol,
      filing_type: filingType,
      period,
      filing_date: filingDate,
      analysis_text: analysisText,
    })
    .select("*");
  if (r.error) {
    return NextResponse.json({ error: r.error.message }, { status: 500 });
  }
  return NextResponse.json({ analysis: r.data?.[0] as FilingAnalysisRow });
}

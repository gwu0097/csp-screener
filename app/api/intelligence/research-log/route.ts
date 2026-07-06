import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { requireUserId, authErrorResponse } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// GET /api/intelligence/research-log
//
// Every saved filing analysis across every symbol, for the Research
// Log page. filing_analyses is a SHARED table by design (Deep Research
// is shared knowledge — no user_id column), so authentication is
// required but rows are not user-scoped. Company names are joined in
// from stock_profiles with a symbol_market_snapshot fallback.

type AnalysisRow = {
  id: string;
  symbol: string;
  filing_type: string | null;
  period: string | null;
  filing_date: string | null;
  analysis_text: string | null;
  reviewed_at: string | null;
  notes: string | null;
};

export async function GET() {
  try {
    await requireUserId();
  } catch (e) {
    return authErrorResponse(e);
  }
  const sb = createServerClient();
  const res = await sb
    .from("filing_analyses")
    .select("id,symbol,filing_type,period,filing_date,analysis_text,reviewed_at,notes")
    .order("reviewed_at", { ascending: false })
    .limit(500);
  if (res.error) {
    return NextResponse.json({ error: res.error.message }, { status: 500 });
  }
  const rows = (res.data ?? []) as AnalysisRow[];

  const symbols = Array.from(new Set(rows.map((r) => r.symbol.toUpperCase())));
  const nameBySymbol = new Map<string, string>();
  if (symbols.length > 0) {
    const [profRes, snapRes] = await Promise.all([
      sb.from("stock_profiles").select("symbol,company_name").in("symbol", symbols),
      sb.from("symbol_market_snapshot").select("symbol,company_name").in("symbol", symbols),
    ]);
    // Snapshot first so profile names (usually cleaner) win the second pass.
    for (const r of (snapRes.data ?? []) as Array<{ symbol: string; company_name: string | null }>) {
      if (r.company_name) nameBySymbol.set(r.symbol.toUpperCase(), r.company_name);
    }
    for (const r of (profRes.data ?? []) as Array<{ symbol: string; company_name: string | null }>) {
      if (r.company_name) nameBySymbol.set(r.symbol.toUpperCase(), r.company_name);
    }
  }

  return NextResponse.json({
    analyses: rows.map((r) => ({
      id: r.id,
      symbol: r.symbol.toUpperCase(),
      company_name: nameBySymbol.get(r.symbol.toUpperCase()) ?? null,
      filing_type: r.filing_type,
      period: r.period,
      filing_date: r.filing_date,
      reviewed_at: r.reviewed_at,
      preview: (r.analysis_text ?? "").slice(0, 120),
      // Full text ships too so client-side keyword search covers the
      // whole analysis, not just the preview. Volume is small (<500
      // rows, capped).
      analysis_text: r.analysis_text ?? "",
      has_notes: r.notes !== null && r.notes.trim().length > 0,
    })),
  });
}

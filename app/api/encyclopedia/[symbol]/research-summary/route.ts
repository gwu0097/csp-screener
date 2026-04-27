import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// Research-summary feed for the Research tab on /encyclopedia/[symbol].
// Returns the latest run of each research module type for the symbol
// — just the headline (grade / one-line summary / runAt), not the full
// module payload. The encyclopedia tab links out to /research/[symbol]
// for the full content.
//
// Output shape per module is intentionally lossy: we sniff a few common
// fields ("overall_grade", "summary", "headline", "blurb", "verdict")
// because each module's payload schema is owned by its own route
// handler and they don't share a base type.

const MODULE_TYPES = [
  "business_overview",
  "fundamental_health",
  "catalyst_scanner",
  "valuation_model",
  "10k_deep_read",
  "risk_assessment",
  "sentiment",
  "technical",
] as const;

const MODULE_LABEL: Record<string, string> = {
  business_overview: "Business Overview",
  fundamental_health: "Fundamental Health",
  catalyst_scanner: "Catalyst Scanner",
  valuation_model: "Valuation",
  "10k_deep_read": "10-K Deep Read",
  risk_assessment: "Risk",
  sentiment: "Sentiment",
  technical: "Technical",
};

type StockRow = {
  symbol: string;
  company_name: string | null;
  overall_grade: string | null;
  grade_reasoning: string | null;
  last_researched_at: string | null;
};

type ModuleRow = {
  symbol: string;
  module_type: string;
  output: unknown;
  is_customized: boolean | null;
  run_at: string;
  expires_at: string | null;
};

type ModuleSummary = {
  type: string;
  label: string;
  grade: string | null;
  headline: string | null;
  runAt: string;
  isExpired: boolean;
};

function pickStr(o: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  return null;
}

function summariseOutput(output: unknown): {
  grade: string | null;
  headline: string | null;
} {
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    return { grade: null, headline: null };
  }
  const o = output as Record<string, unknown>;
  const grade = pickStr(o, [
    "overall_grade",
    "grade",
    "letter_grade",
    "health_grade",
  ]);
  const headline = pickStr(o, [
    "summary",
    "headline",
    "one_liner",
    "blurb",
    "verdict",
    "thesis",
    "catalyst_summary",
  ]);
  return { grade, headline };
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

  const [stockRes, modRes] = await Promise.all([
    sb
      .from("research_stocks")
      // sector / industry / market_cap don't exist on this table — the
      // existing /api/research/[symbol] route also avoids them and
      // sources market_cap live from Yahoo when needed. Keep this
      // SELECT in sync with the actual schema or PostgREST 400s.
      .select(
        "symbol,company_name,overall_grade,grade_reasoning,last_researched_at",
      )
      .eq("symbol", symbol)
      .limit(1),
    sb
      .from("research_modules")
      .select("*")
      .eq("symbol", symbol)
      .order("run_at", { ascending: false }),
  ]);
  if (stockRes.error) {
    return NextResponse.json(
      { error: stockRes.error.message },
      { status: 500 },
    );
  }
  if (modRes.error) {
    return NextResponse.json({ error: modRes.error.message }, { status: 500 });
  }

  const stock = ((stockRes.data ?? []) as StockRow[])[0] ?? null;
  const allModuleRows = (modRes.data ?? []) as ModuleRow[];

  // First (newest) row per module_type, since the SELECT is already
  // sorted by run_at desc.
  const latestByType = new Map<string, ModuleRow>();
  for (const row of allModuleRows) {
    if (!latestByType.has(row.module_type)) {
      latestByType.set(row.module_type, row);
    }
  }

  const now = Date.now();
  const modules: ModuleSummary[] = MODULE_TYPES.flatMap((type) => {
    const row = latestByType.get(type);
    if (!row) return [];
    const { grade, headline } = summariseOutput(row.output);
    const summary: ModuleSummary = {
      type,
      label: MODULE_LABEL[type] ?? type,
      grade,
      headline,
      runAt: row.run_at,
      isExpired:
        row.expires_at !== null && new Date(row.expires_at).getTime() < now,
    };
    return [summary];
  });

  return NextResponse.json({ stock, modules });
}

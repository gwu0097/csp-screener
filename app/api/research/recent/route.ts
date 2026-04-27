import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

type StockRow = {
  symbol: string;
  company_name: string | null;
  sector: string | null;
  overall_grade: string | null;
  last_researched_at: string | null;
};

type ModuleRow = {
  symbol: string;
  module_type: string;
};

export type ModuleCounts = {
  business_overview: number;
  fundamental_health: number;
  catalyst_scanner: number;
  valuation_model: number;
  "10k_deep_read": number;
  risk_assessment: number;
  sentiment: number;
  technical: number;
};

const EMPTY_COUNTS: ModuleCounts = {
  business_overview: 0,
  fundamental_health: 0,
  catalyst_scanner: 0,
  valuation_model: 0,
  "10k_deep_read": 0,
  risk_assessment: 0,
  sentiment: 0,
  technical: 0,
};

export type RecentStockRow = StockRow & { modules: ModuleCounts };

export async function GET(): Promise<NextResponse> {
  const sb = createServerClient();
  // Pull every researched stock — the home page now lists all of them
  // grouped by last_researched_at desc, not just the top 10.
  const stocksRes = await sb
    .from("research_stocks")
    .select("symbol,company_name,sector,overall_grade,last_researched_at")
    .order("last_researched_at", { ascending: false });
  if (stocksRes.error) {
    return NextResponse.json({ error: stocksRes.error.message }, { status: 500 });
  }
  const stocks = (stocksRes.data ?? []) as StockRow[];
  if (stocks.length === 0) {
    return NextResponse.json({ stocks: [] });
  }

  const symbols = stocks.map((s) => s.symbol);
  const modulesRes = await sb
    .from("research_modules")
    .select("symbol,module_type")
    .in("symbol", symbols);
  if (modulesRes.error) {
    // Modules query failure is non-fatal — render stocks with zero
    // counts rather than a 500 for the whole page.
    console.warn(`[research/recent] modules fetch failed: ${modulesRes.error.message}`);
  }
  const moduleRows = (modulesRes.data ?? []) as ModuleRow[];

  const countsBySymbol = new Map<string, ModuleCounts>();
  for (const row of moduleRows) {
    const key = row.symbol;
    let counts = countsBySymbol.get(key);
    if (!counts) {
      counts = { ...EMPTY_COUNTS };
      countsBySymbol.set(key, counts);
    }
    if (row.module_type in counts) {
      counts[row.module_type as keyof ModuleCounts] += 1;
    }
  }

  const out: RecentStockRow[] = stocks.map((s) => ({
    ...s,
    modules: countsBySymbol.get(s.symbol) ?? { ...EMPTY_COUNTS },
  }));
  return NextResponse.json({ stocks: out });
}

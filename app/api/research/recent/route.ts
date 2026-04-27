import { NextResponse } from "next/server";
import YahooFinance from "yahoo-finance2";
import { createServerClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";
// Yahoo batch quote across every researched symbol + two Supabase
// fetches. Single round-trip for quotes, but a slow day or a user
// with 100+ stocks can crawl. 60s is plenty.
export const maxDuration = 60;

const yahooFinance = new (
  YahooFinance as unknown as new () => Record<string, unknown>
)();
type YFClient = {
  quote: (
    symbols: string[] | string,
    q?: Record<string, unknown>,
    m?: { validateResult?: boolean },
  ) => Promise<unknown>;
};
const yf = yahooFinance as unknown as YFClient;
const QUOTE_OPTS = { validateResult: false } as const;

type StockRow = {
  symbol: string;
  company_name: string | null;
  overall_grade: string | null;
  grade_reasoning: string | null;
  last_researched_at: string | null;
};

type ModuleCountRow = {
  symbol: string;
  module_type: string;
};

type LatestModuleRow = {
  symbol: string;
  module_type: string;
  output: unknown;
  run_at: string | null;
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

export type RecentStockRow = StockRow & {
  modules: ModuleCounts;
  // Pulled from the most recent module of each type so the home page
  // can show a one-line summary without having to open the stock.
  valuation_base_target: number | null;
  catalyst_score: "rich" | "moderate" | "sparse" | null;
  current_price: number | null;
  change_percent: number | null;
};

function unwrapNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (v && typeof v === "object" && "raw" in (v as Record<string, unknown>)) {
    const raw = (v as { raw?: unknown }).raw;
    if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  }
  return null;
}

async function fetchQuotes(
  symbols: string[],
): Promise<Map<string, { price: number; changePct: number | null }>> {
  const out = new Map<string, { price: number; changePct: number | null }>();
  if (symbols.length === 0) return out;
  try {
    const result = (await yf.quote(symbols, undefined, QUOTE_OPTS)) as
      | unknown[]
      | unknown;
    const arr: Record<string, unknown>[] = Array.isArray(result)
      ? (result as Record<string, unknown>[])
      : [result as Record<string, unknown>];
    for (const q of arr) {
      const sym = typeof q.symbol === "string" ? (q.symbol as string) : null;
      const price = unwrapNumber(q.regularMarketPrice);
      const changePct = unwrapNumber(q.regularMarketChangePercent);
      if (sym && price !== null) {
        out.set(sym.toUpperCase(), { price, changePct });
      }
    }
  } catch (err) {
    console.warn(
      `[research/recent] Yahoo quote batch failed: ${err instanceof Error ? err.message : err}`,
    );
  }
  return out;
}

export async function GET(): Promise<NextResponse> {
  const sb = createServerClient();
  // research_stocks doesn't carry sector — we leave it off the home
  // page rather than join to business_overview output for a single
  // column that isn't sortable anyway.
  const stocksRes = await sb
    .from("research_stocks")
    .select(
      "symbol,company_name,overall_grade,grade_reasoning,last_researched_at",
    )
    .order("last_researched_at", { ascending: false });
  if (stocksRes.error) {
    return NextResponse.json({ error: stocksRes.error.message }, { status: 500 });
  }
  const stocks = (stocksRes.data ?? []) as StockRow[];
  if (stocks.length === 0) {
    return NextResponse.json({ stocks: [] });
  }

  const symbols = stocks.map((s) => s.symbol);

  // Counts: cheap projection (no output JSON) so we can tally every
  // module type per stock without dragging the heavy payloads.
  const countsRes = await sb
    .from("research_modules")
    .select("symbol,module_type")
    .in("symbol", symbols);
  if (countsRes.error) {
    console.warn(`[research/recent] counts fetch failed: ${countsRes.error.message}`);
  }
  const countRows = (countsRes.data ?? []) as ModuleCountRow[];
  const countsBySymbol = new Map<string, ModuleCounts>();
  for (const row of countRows) {
    let c = countsBySymbol.get(row.symbol);
    if (!c) {
      c = { ...EMPTY_COUNTS };
      countsBySymbol.set(row.symbol, c);
    }
    if (row.module_type in c) {
      c[row.module_type as keyof ModuleCounts] += 1;
    }
  }

  // Latest catalyst + valuation + business_overview outputs — we need
  // a few summary fields off each, plus business_overview gives us a
  // companyName fallback for older rows where the upsert didn't land.
  const latestRes = await sb
    .from("research_modules")
    .select("symbol,module_type,output,run_at")
    .in("symbol", symbols)
    .in("module_type", ["catalyst_scanner", "valuation_model", "business_overview"])
    .order("run_at", { ascending: false });
  const latestRows = (latestRes.data ?? []) as LatestModuleRow[];
  if (latestRes.error) {
    console.warn(`[research/recent] latest fetch failed: ${latestRes.error.message}`);
  }
  const latestBy = new Map<string, LatestModuleRow>();
  for (const r of latestRows) {
    const key = `${r.symbol}|${r.module_type}`;
    if (!latestBy.has(key)) latestBy.set(key, r);
  }

  function pickValuationTarget(output: unknown): number | null {
    if (!output || typeof output !== "object") return null;
    const o = output as Record<string, unknown>;
    if (o.schema_version === 2) {
      const tier1 = o.tier1 as { outputs?: { base?: { price_target?: number } } };
      const v = tier1?.outputs?.base?.price_target;
      return typeof v === "number" && Number.isFinite(v) ? v : null;
    }
    const v1 = (o as { outputs?: { base?: { price_target?: number } } }).outputs
      ?.base?.price_target;
    return typeof v1 === "number" && Number.isFinite(v1) ? v1 : null;
  }

  function pickCatalystScore(output: unknown): "rich" | "moderate" | "sparse" | null {
    if (!output || typeof output !== "object") return null;
    const o = output as { overall_catalyst_score?: unknown };
    if (
      o.overall_catalyst_score === "rich" ||
      o.overall_catalyst_score === "moderate" ||
      o.overall_catalyst_score === "sparse"
    ) {
      return o.overall_catalyst_score;
    }
    return null;
  }

  function pickCompanyName(output: unknown): string | null {
    if (!output || typeof output !== "object") return null;
    const o = output as { companyName?: unknown };
    return typeof o.companyName === "string" && o.companyName.trim().length > 0
      ? o.companyName
      : null;
  }

  // Live prices in parallel with the rest. Failure is non-fatal — we
  // just leave price/change as null on rows we couldn't quote.
  const quotes = await fetchQuotes(symbols);

  const out: RecentStockRow[] = stocks.map((s) => {
    const val = latestBy.get(`${s.symbol}|valuation_model`);
    const cat = latestBy.get(`${s.symbol}|catalyst_scanner`);
    const bo = latestBy.get(`${s.symbol}|business_overview`);
    const fallbackName = bo ? pickCompanyName(bo.output) : null;
    const q = quotes.get(s.symbol.toUpperCase()) ?? null;
    return {
      ...s,
      company_name: s.company_name ?? fallbackName,
      modules: countsBySymbol.get(s.symbol) ?? { ...EMPTY_COUNTS },
      valuation_base_target: val ? pickValuationTarget(val.output) : null,
      catalyst_score: cat ? pickCatalystScore(cat.output) : null,
      current_price: q?.price ?? null,
      change_percent: q?.changePct ?? null,
    };
  });
  return NextResponse.json({ stocks: out });
}

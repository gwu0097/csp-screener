import { NextRequest, NextResponse } from "next/server";
import YahooFinance from "yahoo-finance2";
import { createServerClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const yahooFinance = new (
  YahooFinance as unknown as new () => Record<string, unknown>
)();
type YFClient = {
  quote: (
    s: string,
    q?: Record<string, unknown>,
    m?: { validateResult?: boolean },
  ) => Promise<unknown>;
};
const yf = yahooFinance as unknown as YFClient;
const MODULE_OPTS = { validateResult: false } as const;

function pickNum(o: Record<string, unknown>, k: string): number | null {
  const v = o[k];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return null;
}
function pickStr(o: Record<string, unknown>, k: string): string | null {
  const v = o[k];
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

function marketCapCategory(cap: number | null): "large" | "mid" | "small" | null {
  if (cap === null) return null;
  if (cap >= 10_000_000_000) return "large";
  if (cap >= 2_000_000_000) return "mid";
  return "small";
}

type StockInfo = {
  symbol: string;
  companyName: string | null;
  sector: string | null;
  industry: string | null;
  marketCap: number | null;
  marketCapCategory: "large" | "mid" | "small" | null;
  currentPrice: number | null;
  priceChange1d: number | null;
  overallGrade: string | null;
  gradeReasoning: string | null;
  lastResearchedAt: string | null;
};

export async function GET(
  _req: NextRequest,
  { params }: { params: { symbol: string } },
): Promise<NextResponse> {
  const symbol = (params.symbol ?? "").trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol)) {
    return NextResponse.json({ error: "Invalid symbol" }, { status: 400 });
  }

  const sb = createServerClient();
  const stockRes = await sb
    .from("research_stocks")
    .select(
      "symbol,company_name,sector,industry,market_cap,overall_grade,grade_reasoning,last_researched_at",
    )
    .eq("symbol", symbol)
    .maybeSingle();
  const stockRow = (stockRes.data as
    | {
        symbol: string;
        company_name: string | null;
        sector: string | null;
        industry: string | null;
        market_cap: number | null;
        overall_grade: string | null;
        grade_reasoning: string | null;
        last_researched_at: string | null;
      }
    | null) ?? null;

  // Live quote — separate from research_stocks so the price stays fresh
  // even if the user hasn't re-run a module today.
  let quote: Record<string, unknown> | null = null;
  try {
    const r = await yf.quote(symbol, {}, MODULE_OPTS);
    quote = (Array.isArray(r) ? r[0] : r) as Record<string, unknown> | null;
  } catch {
    quote = null;
  }
  const currentPrice = quote ? pickNum(quote, "regularMarketPrice") : null;
  const priceChange1d = quote ? pickNum(quote, "regularMarketChangePercent") : null;
  const liveCap = quote ? pickNum(quote, "marketCap") : null;
  const liveName = quote
    ? pickStr(quote, "shortName") ?? pickStr(quote, "longName")
    : null;

  const marketCap = stockRow?.market_cap ?? liveCap ?? null;
  const out: StockInfo = {
    symbol,
    companyName: stockRow?.company_name ?? liveName,
    sector: stockRow?.sector ?? null,
    industry: stockRow?.industry ?? null,
    marketCap,
    marketCapCategory: marketCapCategory(marketCap),
    currentPrice,
    priceChange1d,
    overallGrade: stockRow?.overall_grade ?? null,
    gradeReasoning: stockRow?.grade_reasoning ?? null,
    lastResearchedAt: stockRow?.last_researched_at ?? null,
  };
  return NextResponse.json({ stock: out });
}

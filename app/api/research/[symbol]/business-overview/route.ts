import { NextRequest, NextResponse } from "next/server";
import YahooFinance from "yahoo-finance2";
import { askPerplexityRaw } from "@/lib/perplexity";
import {
  getLatestModule,
  recomputeOverallGrade,
  saveModule,
  tryParseObject,
} from "@/lib/research-modules";
import { createServerClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const yahooFinance = new (
  YahooFinance as unknown as new () => Record<string, unknown>
)();
type YFClient = {
  quote: (
    s: string,
    q?: Record<string, unknown>,
    m?: { validateResult?: boolean },
  ) => Promise<unknown>;
  quoteSummary: (
    s: string,
    o: { modules: string[] },
    m?: { validateResult?: boolean },
  ) => Promise<unknown>;
};
const yf = yahooFinance as unknown as YFClient;
const MODULE_OPTS = { validateResult: false } as const;

type BusinessOverview = {
  // Yahoo profile
  companyName: string | null;
  sector: string | null;
  industry: string | null;
  marketCap: number | null;
  employees: number | null;
  website: string | null;
  longBusinessSummary: string | null;
  // Perplexity output (verbatim shape from prompt)
  business_model: string | null;
  revenue_streams: string[];
  moat_type: string | null;
  moat_description: string | null;
  competitors: Array<{ name: string; ticker: string; comparison: string }>;
  growth_drivers: string[];
  management_notes: string | null;
  bull_summary: string | null;
  bear_summary: string | null;
};

function pickNum(o: Record<string, unknown>, k: string): number | null {
  const v = o[k];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (v && typeof v === "object" && "raw" in (v as Record<string, unknown>)) {
    const raw = (v as { raw?: unknown }).raw;
    if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  }
  return null;
}

function pickStr(o: Record<string, unknown>, k: string): string | null {
  const v = o[k];
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

function validSymbol(symbol: string): boolean {
  return /^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol);
}

async function fetchYahooProfile(symbol: string): Promise<{
  companyName: string | null;
  sector: string | null;
  industry: string | null;
  marketCap: number | null;
  employees: number | null;
  website: string | null;
  longBusinessSummary: string | null;
}> {
  const [quoteRaw, summaryRaw] = await Promise.all([
    yf.quote(symbol, {}, MODULE_OPTS).catch(() => null),
    yf
      .quoteSummary(symbol, { modules: ["assetProfile", "summaryProfile"] }, MODULE_OPTS)
      .catch(() => null),
  ]);
  const q = (Array.isArray(quoteRaw) ? quoteRaw[0] : quoteRaw) as
    | Record<string, unknown>
    | null;
  const s = (summaryRaw ?? {}) as Record<string, unknown>;
  const profile = ((s.assetProfile as Record<string, unknown>) ??
    (s.summaryProfile as Record<string, unknown>) ??
    {}) as Record<string, unknown>;
  return {
    companyName:
      (q && (pickStr(q, "shortName") ?? pickStr(q, "longName"))) ?? null,
    sector: pickStr(profile, "sector"),
    industry: pickStr(profile, "industry"),
    marketCap: q ? pickNum(q, "marketCap") : null,
    employees: pickNum(profile, "fullTimeEmployees"),
    website: pickStr(profile, "website"),
    longBusinessSummary: pickStr(profile, "longBusinessSummary"),
  };
}

function buildOverviewPrompt(symbol: string, companyName: string): string {
  return `Research ${symbol} (${companyName}).

Provide a comprehensive business overview:

1. BUSINESS MODEL: How does this company make money? What are its main revenue streams?
2. COMPETITIVE MOAT: What protects this business from competitors? (network effects / switching costs / brand / cost advantage / IP)
3. COMPETITORS: Who are the top 3-5 direct competitors? How does ${symbol} compare?
4. GROWTH DRIVERS: What are the 2-3 biggest factors that could drive growth?
5. MANAGEMENT: Any notable things about leadership quality, recent changes, or track record?

Return ONLY this JSON, no markdown:
{
  "business_model": "2-3 sentences",
  "revenue_streams": ["stream1", "stream2"],
  "moat_type": "network_effects|switching_costs|brand|cost_advantage|ip|none",
  "moat_description": "1-2 sentences",
  "competitors": [
    {"name": "...", "ticker": "...", "comparison": "1 sentence"}
  ],
  "growth_drivers": ["driver1", "driver2"],
  "management_notes": "1-2 sentences or null",
  "bull_summary": "1 sentence why bulls like it",
  "bear_summary": "1 sentence why bears are cautious"
}`;
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function toCompetitors(
  v: unknown,
): Array<{ name: string; ticker: string; comparison: string }> {
  return asArray(v).flatMap((x) => {
    if (!x || typeof x !== "object") return [];
    const o = x as Record<string, unknown>;
    return [
      {
        name: typeof o.name === "string" ? o.name : "",
        ticker: typeof o.ticker === "string" ? o.ticker : "",
        comparison: typeof o.comparison === "string" ? o.comparison : "",
      },
    ];
  });
}

function toStringArray(v: unknown): string[] {
  return asArray(v)
    .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
    .map((x) => x.trim());
}

export async function GET(
  _req: NextRequest,
  { params }: { params: { symbol: string } },
): Promise<NextResponse> {
  const symbol = (params.symbol ?? "").trim().toUpperCase();
  if (!validSymbol(symbol)) {
    return NextResponse.json({ error: "Invalid symbol" }, { status: 400 });
  }
  const mod = await getLatestModule<BusinessOverview>(symbol, "business_overview");
  return NextResponse.json({ module: mod });
}

export async function POST(
  _req: NextRequest,
  { params }: { params: { symbol: string } },
): Promise<NextResponse> {
  const symbol = (params.symbol ?? "").trim().toUpperCase();
  if (!validSymbol(symbol)) {
    return NextResponse.json({ error: "Invalid symbol" }, { status: 400 });
  }

  try {
    const profile = await fetchYahooProfile(symbol);

    // Backfill the parent stocks row with the profile fields so the home
    // page can render them without re-querying Yahoo per row.
    const sb = createServerClient();
    await sb
      .from("research_stocks")
      .upsert(
        {
          symbol,
          company_name: profile.companyName,
          sector: profile.sector,
          industry: profile.industry,
          market_cap: profile.marketCap,
        },
        { onConflict: "symbol" },
      );

    // Perplexity. Failure is non-fatal — we still save the Yahoo profile so
    // the user sees something (and the cache lasts 30 days).
    let parsed: Record<string, unknown> | null = null;
    if (profile.companyName) {
      const raw = await askPerplexityRaw(
        buildOverviewPrompt(symbol, profile.companyName),
        { label: `research-overview:${symbol}`, maxTokens: 1200 },
      );
      if (raw?.text) parsed = tryParseObject(raw.text);
    }

    const output: BusinessOverview = {
      ...profile,
      business_model:
        typeof parsed?.business_model === "string" ? parsed.business_model : null,
      revenue_streams: toStringArray(parsed?.revenue_streams),
      moat_type:
        typeof parsed?.moat_type === "string" ? parsed.moat_type : null,
      moat_description:
        typeof parsed?.moat_description === "string"
          ? parsed.moat_description
          : null,
      competitors: toCompetitors(parsed?.competitors),
      growth_drivers: toStringArray(parsed?.growth_drivers),
      management_notes:
        typeof parsed?.management_notes === "string"
          ? parsed.management_notes
          : null,
      bull_summary:
        typeof parsed?.bull_summary === "string" ? parsed.bull_summary : null,
      bear_summary:
        typeof parsed?.bear_summary === "string" ? parsed.bear_summary : null,
    };

    const saved = await saveModule(symbol, "business_overview", output);
    await recomputeOverallGrade(symbol);
    return NextResponse.json({ module: saved });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[business-overview] POST(${symbol}) failed:`, err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

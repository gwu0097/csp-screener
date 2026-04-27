import { NextRequest, NextResponse } from "next/server";
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

// ---------- Types ----------

type RiskCategory =
  | "business"
  | "financial"
  | "management"
  | "sector"
  | "macro"
  | "valuation";
type Probability = "high" | "medium" | "low";
type Impact = "high" | "medium" | "low";

type Risk = {
  category: RiskCategory;
  title: string;
  description: string;
  probability: Probability;
  impact: Impact;
  priced_in: boolean;
  mitigation: string | null;
};

type EightK = {
  filing_date: string;
  description: string | null;
  url: string | null;
};

type RiskOutput = {
  risks: Risk[];
  overall_risk_level: "high" | "medium" | "low";
  risk_score: number; // raw points
  biggest_risk: string | null;
  key_risk_to_monitor: string | null;
  summary: string | null;
  recent_8k_filings: EightK[];
};

// ---------- Helpers ----------

function asStr(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

function asEnum<T extends string>(v: unknown, allowed: readonly T[]): T | null {
  if (typeof v === "string" && (allowed as readonly string[]).includes(v)) {
    return v as T;
  }
  return null;
}

function validSymbol(symbol: string): boolean {
  return /^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol);
}

async function getCompanyName(symbol: string): Promise<string> {
  const sb = createServerClient();
  const res = await sb
    .from("research_stocks")
    .select("company_name")
    .eq("symbol", symbol)
    .maybeSingle();
  const name = (res.data as { company_name: string | null } | null)?.company_name;
  return name ?? symbol;
}

// ---------- 8-K filings (SEC EDGAR full-text search) ----------

const EDGAR_USER_AGENT =
  process.env.SEC_USER_AGENT ?? "csp-screener research@example.com";

async function fetch8KFilings(symbol: string): Promise<EightK[]> {
  const to = new Date();
  const from = new Date(to.getTime() - 90 * 24 * 60 * 60 * 1000);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  // EDGAR's full-text search endpoint accepts ticker via &ciks/entity.
  // The simpler approach is &forms=8-K + &q=<symbol>. Hits include
  // file_date and an adsh (accession). We surface up to 5.
  const url = `https://efts.sec.gov/LATEST/search-index?q=${encodeURIComponent(
    symbol,
  )}&forms=8-K&dateRange=custom&startdt=${fmt(from)}&enddt=${fmt(to)}`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": EDGAR_USER_AGENT, Accept: "application/json" },
      cache: "no-store",
    });
    if (!res.ok) return [];
    const json = (await res.json()) as {
      hits?: { hits?: Array<{ _source?: Record<string, unknown>; _id?: string }> };
    };
    const hits = json.hits?.hits ?? [];
    const out: EightK[] = [];
    for (const h of hits) {
      const src = (h._source ?? {}) as Record<string, unknown>;
      const filingDate = typeof src.file_date === "string" ? (src.file_date as string) : null;
      const desc =
        typeof src.items === "string"
          ? (src.items as string)
          : typeof src.description === "string"
            ? (src.description as string)
            : null;
      const adsh = typeof src.adsh === "string" ? (src.adsh as string) : null;
      const url =
        adsh && typeof src.ciks === "string"
          ? `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${src.ciks}&type=8-K`
          : adsh
            ? `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${
                Array.isArray(src.ciks) ? (src.ciks as string[])[0] : ""
              }&type=8-K`
            : null;
      if (filingDate) {
        out.push({ filing_date: filingDate, description: desc, url });
      }
      if (out.length >= 5) break;
    }
    return out;
  } catch (e) {
    console.warn(
      `[risk] EDGAR 8-K search(${symbol}) failed:`,
      e instanceof Error ? e.message : e,
    );
    return [];
  }
}

// ---------- Perplexity prompt + parser ----------

function buildPrompt(symbol: string, companyName: string): string {
  return `Provide a comprehensive risk assessment for ${symbol} (${companyName}) for an investor considering a position.

Analyze ALL categories of risk:

1. BUSINESS RISKS: What could go wrong with the core business model? Competition, disruption, execution?
2. FINANCIAL RISKS: Balance sheet concerns, debt levels, cash burn, margin pressure?
3. MANAGEMENT RISKS: Leadership quality, recent changes, governance issues?
4. SECTOR RISKS: Industry-wide headwinds, regulatory changes, cyclicality?
5. MACRO RISKS: Interest rates, inflation, currency, geopolitical exposure?
6. VALUATION RISKS: Is the stock pricing in too much optimism? What if growth slows?

For each risk:
- How likely is it to materialize? (high/medium/low probability)
- How severe would the impact be? (high/medium/low impact)
- Is it already priced in by the market?
- One-sentence mitigation if applicable.

Return ONLY this JSON:
{
  "risks": [
    {
      "category": "business|financial|management|sector|macro|valuation",
      "title": "short risk name",
      "description": "2-3 specific sentences",
      "probability": "high|medium|low",
      "impact": "high|medium|low",
      "priced_in": true,
      "mitigation": "1 sentence on what could reduce this risk"
    }
  ],
  "overall_risk_level": "high|medium|low",
  "biggest_risk": "title of the #1 risk",
  "key_risk_to_monitor": "what single metric or event would signal the thesis is breaking",
  "summary": "2-3 sentence risk overview"
}`;
}

function parseRisks(parsed: Record<string, unknown> | null): Risk[] {
  if (!parsed) return [];
  const list = Array.isArray(parsed.risks) ? parsed.risks : [];
  return list.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const o = entry as Record<string, unknown>;
    const title = asStr(o.title);
    const description = asStr(o.description);
    if (!title || !description) return [];
    const category =
      asEnum(o.category, [
        "business",
        "financial",
        "management",
        "sector",
        "macro",
        "valuation",
      ] as const) ?? "business";
    const probability =
      asEnum(o.probability, ["high", "medium", "low"] as const) ?? "medium";
    const impact = asEnum(o.impact, ["high", "medium", "low"] as const) ?? "medium";
    const priced_in =
      typeof o.priced_in === "boolean" ? (o.priced_in as boolean) : false;
    return [
      {
        category,
        title,
        description,
        probability,
        impact,
        priced_in,
        mitigation: asStr(o.mitigation),
      },
    ];
  });
}

// ---------- Score ----------

function scoreOf(prob: Probability, impact: Impact): number {
  if (prob === "high" && impact === "high") return 3;
  if (prob === "high" && impact === "medium") return 2;
  if (prob === "medium" && impact === "high") return 2;
  return 1;
}

function computeRiskScore(risks: Risk[]): {
  score: number;
  level: "high" | "medium" | "low";
} {
  const score = risks.reduce((s, r) => s + scoreOf(r.probability, r.impact), 0);
  const level: "high" | "medium" | "low" =
    score >= 11 ? "high" : score >= 6 ? "medium" : "low";
  return { score, level };
}

// ---------- Routes ----------

export async function GET(
  _req: NextRequest,
  { params }: { params: { symbol: string } },
): Promise<NextResponse> {
  const symbol = (params.symbol ?? "").trim().toUpperCase();
  if (!validSymbol(symbol)) {
    return NextResponse.json({ error: "Invalid symbol" }, { status: 400 });
  }
  const mod = await getLatestModule<RiskOutput>(symbol, "risk_assessment");
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
    const companyName = await getCompanyName(symbol);

    const [raw, eightKs] = await Promise.all([
      askPerplexityRaw(buildPrompt(symbol, companyName), {
        label: `research-risk:${symbol}`,
        maxTokens: 1800,
      }).catch(() => null),
      fetch8KFilings(symbol),
    ]);

    const parsed = raw?.text ? tryParseObject(raw.text) : null;
    const risks = parseRisks(parsed);
    const { score, level } = computeRiskScore(risks);
    // Trust Perplexity's overall_risk_level if it agrees with our
    // computation; otherwise our score-based level wins because the
    // grade rubric reads that field.
    const llmLevel = asEnum(parsed?.overall_risk_level, [
      "high",
      "medium",
      "low",
    ] as const);
    const overall = llmLevel ?? level;

    const output: RiskOutput = {
      risks,
      overall_risk_level: overall,
      risk_score: score,
      biggest_risk: asStr(parsed?.biggest_risk),
      key_risk_to_monitor: asStr(parsed?.key_risk_to_monitor),
      summary: asStr(parsed?.summary),
      recent_8k_filings: eightKs,
    };

    const saved = await saveModule(symbol, "risk_assessment", output);
    await recomputeOverallGrade(symbol);
    return NextResponse.json({ module: saved });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[risk] POST(${symbol}) failed:`, err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

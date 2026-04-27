import { NextRequest, NextResponse } from "next/server";
import { askPerplexityRaw } from "@/lib/perplexity";
import { getFinnhubNextEarningsDate } from "@/lib/earnings";
import {
  getLatestModule,
  recomputeOverallGrade,
  saveModule,
  tryParseObject,
} from "@/lib/research-modules";
import { createServerClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type CatalystEntry = {
  title: string;
  type: string;
  description: string;
  expected_date: string | null;
  impact_direction: "bullish" | "bearish" | "neutral";
  impact_magnitude: "high" | "medium" | "low";
  confidence: "high" | "medium" | "low";
  source_context: string | null;
};

type CatalystScanner = {
  catalysts: CatalystEntry[];
  overall_catalyst_score: "rich" | "moderate" | "sparse";
  summary: string | null;
  next_earnings: { date: string; daysAway: number | null } | null;
};

function validSymbol(symbol: string): boolean {
  return /^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol);
}

function buildPrompt(symbol: string, companyName: string): string {
  return `You are researching ${symbol} (${companyName}) for a swing/long-term investor.

Find ALL specific upcoming catalysts in the next 6 months that could cause a significant price move (positive or negative).

For each catalyst be SPECIFIC:
- What exactly is happening?
- When exactly (date or quarter)?
- What's the expected price impact?
- How confident are you this will happen?

Categories to look for:
- Product launches or major releases
- FDA/regulatory approval decisions
- Government contract awards
- Major partnership/licensing deals
- Analyst/investor day events
- Index inclusion/exclusion
- Activist investor activity
- M&A or strategic review
- Macro events directly impacting this stock
- Management changes or guidance updates

Do NOT include:
- Regular quarterly earnings
- Normal dividends

Return ONLY this JSON:
{
  "catalysts": [
    {
      "title": "short name",
      "type": "product_launch|fda|contract|partnership|regulatory|management|macro|ma|other",
      "description": "2-3 specific sentences",
      "expected_date": "YYYY-MM-DD or 'Q2 2026' or 'H2 2026'",
      "impact_direction": "bullish|bearish|neutral",
      "impact_magnitude": "high|medium|low",
      "confidence": "high|medium|low",
      "source_context": "what you found that indicates this catalyst"
    }
  ],
  "overall_catalyst_score": "rich|moderate|sparse",
  "summary": "1-2 sentence overview of catalyst landscape"
}`;
}

function asStr(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

function asEnum<T extends string>(v: unknown, allowed: readonly T[]): T | null {
  if (typeof v === "string" && (allowed as readonly string[]).includes(v)) {
    return v as T;
  }
  return null;
}

function parseCatalysts(parsed: Record<string, unknown> | null): CatalystEntry[] {
  if (!parsed) return [];
  const list = Array.isArray(parsed.catalysts) ? parsed.catalysts : [];
  return list.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const o = entry as Record<string, unknown>;
    const title = asStr(o.title);
    const description = asStr(o.description);
    if (!title || !description) return [];
    const direction =
      asEnum(o.impact_direction, ["bullish", "bearish", "neutral"] as const) ??
      "neutral";
    const magnitude =
      asEnum(o.impact_magnitude, ["high", "medium", "low"] as const) ?? "low";
    const confidence =
      asEnum(o.confidence, ["high", "medium", "low"] as const) ?? "low";
    return [
      {
        title,
        type: asStr(o.type) ?? "other",
        description,
        expected_date: asStr(o.expected_date),
        impact_direction: direction,
        impact_magnitude: magnitude,
        confidence,
        source_context: asStr(o.source_context),
      },
    ];
  });
}

function daysFromTodayUtc(dateIso: string): number | null {
  const [y, m, d] = dateIso.split("-").map(Number);
  if (!y || !m || !d) return null;
  const t = new Date();
  const a = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate());
  const b = Date.UTC(y, m - 1, d);
  return Math.round((b - a) / (24 * 60 * 60 * 1000));
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

export async function GET(
  _req: NextRequest,
  { params }: { params: { symbol: string } },
): Promise<NextResponse> {
  const symbol = (params.symbol ?? "").trim().toUpperCase();
  if (!validSymbol(symbol)) {
    return NextResponse.json({ error: "Invalid symbol" }, { status: 400 });
  }
  const mod = await getLatestModule<CatalystScanner>(symbol, "catalyst_scanner");
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

  const companyName = await getCompanyName(symbol);

  // Catalysts + earnings in parallel — they hit different APIs.
  const [raw, earn] = await Promise.all([
    askPerplexityRaw(buildPrompt(symbol, companyName), {
      label: `research-catalyst:${symbol}`,
      maxTokens: 1500,
    }),
    getFinnhubNextEarningsDate(symbol),
  ]);

  const parsed = raw?.text ? tryParseObject(raw.text) : null;
  const catalysts = parseCatalysts(parsed);
  const score =
    asEnum(parsed?.overall_catalyst_score, [
      "rich",
      "moderate",
      "sparse",
    ] as const) ??
    (catalysts.length >= 3
      ? "rich"
      : catalysts.length >= 1
        ? "moderate"
        : "sparse");

  const output: CatalystScanner = {
    catalysts,
    overall_catalyst_score: score,
    summary: asStr(parsed?.summary),
    next_earnings: earn
      ? {
          date: earn.date,
          daysAway: daysFromTodayUtc(earn.date),
        }
      : null,
  };

  const saved = await saveModule(symbol, "catalyst_scanner", output);
  await recomputeOverallGrade(symbol);
  return NextResponse.json({ module: saved });
}

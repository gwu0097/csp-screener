import { NextRequest, NextResponse } from "next/server";
import { askPerplexityRaw } from "@/lib/perplexity";
import { getFinnhubNextEarningsDate } from "@/lib/earnings";
import {
  catalystScoreFor,
  type CatalystOutput,
  type FreshCatalyst,
  getLatestModule,
  mergeCatalystResults,
  recomputeOverallGrade,
  saveModule,
  tryParseObject,
} from "@/lib/research-modules";
import { createServerClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function validSymbol(symbol: string): boolean {
  return /^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol);
}

function buildPrompt(symbol: string, companyName: string): string {
  return `You are researching ${symbol} (${companyName}) for a swing/long-term investor.

Find ALL specific catalysts in the next 1-3 years that could cause a significant price move (positive or negative). Capture near-term, medium-term, and long-term catalysts — do not restrict yourself to the next few months.

For each catalyst be SPECIFIC:
- What exactly is happening?
- When exactly (date, quarter, half, or year)?
- What's the expected price impact?
- How confident are you this will happen?
- Which horizon does it fall in?

Horizon classification:
- "near_term": 0-3 months
- "medium_term": 3-12 months
- "long_term": 1-3 years

Categories to look for:
- Product launches or major releases
- FDA/regulatory approval decisions
- Government contract awards
- Major partnership/licensing deals
- Analyst/investor day events
- Index inclusion/exclusion
- Activist investor activity
- M&A or strategic review
- China expansion / international rollouts
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
      "type": "product_launch|fda|contract|partnership|regulatory|management|macro|ma|china_expansion|other",
      "horizon": "near_term|medium_term|long_term",
      "description": "2-3 specific sentences",
      "expected_date": "YYYY-MM-DD or 'Q2 2026' or 'H2 2026' or '2027'",
      "impact_direction": "bullish|bearish|neutral",
      "impact_magnitude": "high|medium|low",
      "confidence": "high|medium|low",
      "source_context": "what you found that indicates this catalyst"
    }
  ],
  "overall_catalyst_score": "rich|moderate|sparse",
  "summary": "1-2 sentence overview of catalyst landscape across all horizons"
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

function parseCatalysts(parsed: Record<string, unknown> | null): FreshCatalyst[] {
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
    const horizon =
      asEnum(o.horizon, ["near_term", "medium_term", "long_term"] as const) ??
      "medium_term";
    return [
      {
        title,
        type: asStr(o.type) ?? "other",
        horizon,
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
  const mod = await getLatestModule<CatalystOutput>(symbol, "catalyst_scanner");
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

    // Catalysts + earnings + previous accumulated catalysts in parallel —
    // the merge needs the prior set so dismissals stay sticky and duplicates
    // collapse instead of multiplying across re-runs.
    const [raw, earn, existingMod] = await Promise.all([
      askPerplexityRaw(buildPrompt(symbol, companyName), {
        label: `research-catalyst:${symbol}`,
        maxTokens: 2000,
      }),
      getFinnhubNextEarningsDate(symbol),
      getLatestModule<CatalystOutput>(symbol, "catalyst_scanner"),
    ]);

    const parsed = raw?.text ? tryParseObject(raw.text) : null;
    const fresh = parseCatalysts(parsed);

    const merged = mergeCatalystResults(existingMod?.output ?? null, {
      catalysts: fresh,
      summary: asStr(parsed?.summary),
      next_earnings: earn
        ? { date: earn.date, daysAway: daysFromTodayUtc(earn.date) }
        : null,
    });

    const saved = await saveModule(symbol, "catalyst_scanner", merged);
    await recomputeOverallGrade(symbol);
    return NextResponse.json({ module: saved });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[catalyst-scanner] POST(${symbol}) failed:`, err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// PATCH /api/research/:symbol/catalyst-scanner
// Body: { id: string, dismissed: boolean }
// Updates the catalyst inside the most recent module row's output JSON.
// We mutate the latest row in place rather than appending — dismissals
// shouldn't pollute scan history.
export async function PATCH(
  req: NextRequest,
  { params }: { params: { symbol: string } },
): Promise<NextResponse> {
  const symbol = (params.symbol ?? "").trim().toUpperCase();
  if (!validSymbol(symbol)) {
    return NextResponse.json({ error: "Invalid symbol" }, { status: 400 });
  }

  try {
    const body = (await req.json()) as { id?: unknown; dismissed?: unknown };
    const id = typeof body.id === "string" ? body.id : null;
    const dismissed = !!body.dismissed;
    if (!id) {
      return NextResponse.json(
        { error: "Missing catalyst id" },
        { status: 400 },
      );
    }

    const sb = createServerClient();
    const latest = await sb
      .from("research_modules")
      .select("id, output")
      .eq("symbol", symbol)
      .eq("module_type", "catalyst_scanner")
      .order("run_at", { ascending: false })
      .limit(1);
    if (latest.error) {
      throw new Error(`fetch latest failed: ${latest.error.message}`);
    }
    const row = (latest.data ?? [])[0] as
      | { id: string; output: CatalystOutput }
      | undefined;
    if (!row) {
      return NextResponse.json(
        { error: "No catalyst module on file" },
        { status: 404 },
      );
    }

    const idx = row.output.catalysts.findIndex((c) => c.id === id);
    if (idx < 0) {
      return NextResponse.json(
        { error: "Catalyst not found" },
        { status: 404 },
      );
    }

    const nextCatalysts = row.output.catalysts.slice();
    nextCatalysts[idx] = { ...nextCatalysts[idx], dismissed };
    const nextOutput: CatalystOutput = {
      ...row.output,
      catalysts: nextCatalysts,
      overall_catalyst_score: catalystScoreFor(nextCatalysts),
    };

    const upd = await sb
      .from("research_modules")
      .update({ output: nextOutput })
      .eq("id", row.id);
    if (upd.error) throw new Error(`update failed: ${upd.error.message}`);

    await recomputeOverallGrade(symbol);
    return NextResponse.json({ ok: true, catalyst: nextCatalysts[idx] });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[catalyst-scanner] PATCH(${symbol}) failed:`, err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

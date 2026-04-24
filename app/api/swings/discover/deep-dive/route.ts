import { NextRequest, NextResponse } from "next/server";
import { askPerplexityRaw } from "@/lib/perplexity";

export const dynamic = "force-dynamic";
// One Perplexity call — typically 5-8s. Keep margin for slow runs.
export const maxDuration = 60;

type DeepDiveRequest = {
  symbol?: unknown;
  companyName?: unknown;
  catalyst?: unknown;
  current_price?: unknown;
  week_52_low?: unknown;
  week_52_high?: unknown;
  forward_pe?: unknown;
  analyst_target?: unknown;
};

type DeepDive = {
  recent_news: string;
  fundamental_health: string;
  catalyst_credibility: "high" | "medium" | "low";
  catalyst_timeline: string;
  retail_sentiment: "bullish" | "bearish" | "mixed";
  institutional_activity: "buying" | "selling" | "neutral";
  technical_setup: "good_entry" | "extended" | "oversold";
  entry_comment: string;
  bear_case: string[];
  verdict: "HIGH" | "MEDIUM" | "LOW";
  verdict_reasoning: string;
};

// JSON cascade — same shape as the screenshot/discover routes use.
function tryParse(text: string): unknown | undefined {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
function sanitize(text: string): string {
  return text
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/,\s*([\]}])/g, "$1")
    .replace(/[﻿​]/g, "");
}
function extractJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  const direct = tryParse(trimmed);
  if (direct && typeof direct === "object" && !Array.isArray(direct))
    return direct as Record<string, unknown>;
  const jsonFence = trimmed.match(/```json\s*([\s\S]*?)\s*```/i);
  if (jsonFence) {
    const parsed = tryParse(sanitize(jsonFence[1].trim()));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      return parsed as Record<string, unknown>;
  }
  const anyFence = trimmed.match(/```\s*([\s\S]*?)\s*```/);
  if (anyFence) {
    const parsed = tryParse(sanitize(anyFence[1].trim()));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      return parsed as Record<string, unknown>;
  }
  const objMatch = trimmed.match(/\{[\s\S]*\}/);
  if (objMatch) {
    const parsed = tryParse(objMatch[0]);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      return parsed as Record<string, unknown>;
    const sanitized = tryParse(sanitize(objMatch[0]));
    if (sanitized && typeof sanitized === "object" && !Array.isArray(sanitized))
      return sanitized as Record<string, unknown>;
  }
  return null;
}

function asString(v: unknown, fallback = ""): string {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : fallback;
}

function buildPrompt(params: {
  symbol: string;
  companyName: string;
  catalyst: string;
  current_price: number | null;
  week_52_low: number | null;
  week_52_high: number | null;
  forward_pe: number | null;
  analyst_target: number | null;
}): string {
  const {
    symbol,
    companyName,
    catalyst,
    current_price,
    week_52_low,
    week_52_high,
    forward_pe,
    analyst_target,
  } = params;
  const priceLine =
    current_price !== null ? `$${current_price.toFixed(2)}` : "unknown";
  const rangeLine =
    week_52_low !== null && week_52_high !== null
      ? `$${week_52_low.toFixed(2)} - $${week_52_high.toFixed(2)}`
      : "unknown";
  const peLine = forward_pe !== null ? `${forward_pe.toFixed(1)}x` : "unknown";
  const targetLine =
    analyst_target !== null ? `$${analyst_target.toFixed(2)}` : "unknown";

  return `Research ${symbol} (${companyName || symbol}) for a swing trader considering a 1-6 month position.

Current price: ${priceLine}
52-week range: ${rangeLine}
Forward P/E: ${peLine}
Analyst target: ${targetLine}

Initial thesis: "${catalyst}"

Provide a comprehensive analysis covering:

1. RECENT NEWS (last 30 days): What has happened that's moving this stock?

2. FUNDAMENTAL HEALTH: Revenue growth trend, profit margins, debt situation, free cash flow. Is the business getting stronger or weaker?

3. CATALYST DETAIL: How credible and near-term is the stated catalyst? What's the timeline?

4. RETAIL vs INSTITUTIONAL: What is retail sentiment on X/Reddit? What are institutions doing (buying/selling)?

5. TECHNICAL SETUP: Is this a good entry point or has it already moved too much? What price levels matter?

6. BEAR CASE: What would make this thesis wrong? What are the top 2-3 risks?

7. VERDICT: Given the trader's style (quality companies, catalyst-driven, 1-6 month horizon), is this a HIGH/MEDIUM/LOW priority swing candidate right now?

Return ONLY a JSON object, no markdown:
{
  "recent_news": "2-3 sentence summary",
  "fundamental_health": "2-3 sentence assessment",
  "catalyst_credibility": "high|medium|low",
  "catalyst_timeline": "specific timeframe",
  "retail_sentiment": "bullish|bearish|mixed",
  "institutional_activity": "buying|selling|neutral",
  "technical_setup": "good_entry|extended|oversold",
  "entry_comment": "one sentence on current entry point",
  "bear_case": ["risk1", "risk2", "risk3"],
  "verdict": "HIGH|MEDIUM|LOW",
  "verdict_reasoning": "2-3 sentence explanation"
}`;
}

function coerceDeepDive(raw: Record<string, unknown>): DeepDive {
  // Defensive coercion — the model occasionally drifts on the enum
  // fields. Snap each one to the legal value, fall back to a neutral
  // option, and keep the rest of the panel renderable.
  const credibility = (() => {
    const v = String(raw.catalyst_credibility ?? "").toLowerCase();
    if (v === "high" || v === "medium" || v === "low") return v;
    return "medium";
  })();
  const retail = (() => {
    const v = String(raw.retail_sentiment ?? "").toLowerCase();
    if (v === "bullish" || v === "bearish" || v === "mixed") return v;
    return "mixed";
  })();
  const institutional = (() => {
    const v = String(raw.institutional_activity ?? "").toLowerCase();
    if (v === "buying" || v === "selling" || v === "neutral") return v;
    return "neutral";
  })();
  const technical = (() => {
    const v = String(raw.technical_setup ?? "").toLowerCase();
    if (v === "good_entry" || v === "extended" || v === "oversold") return v;
    return "extended";
  })();
  const verdict = (() => {
    const v = String(raw.verdict ?? "").toUpperCase();
    if (v === "HIGH" || v === "MEDIUM" || v === "LOW") return v;
    return "MEDIUM";
  })();
  const bearCase = Array.isArray(raw.bear_case)
    ? (raw.bear_case as unknown[])
        .map((r) => (typeof r === "string" ? r.trim() : ""))
        .filter((r) => r.length > 0)
        .slice(0, 5)
    : [];

  return {
    recent_news: asString(raw.recent_news, "No recent news summary available."),
    fundamental_health: asString(
      raw.fundamental_health,
      "No fundamental assessment available.",
    ),
    catalyst_credibility: credibility as DeepDive["catalyst_credibility"],
    catalyst_timeline: asString(raw.catalyst_timeline, "unspecified"),
    retail_sentiment: retail as DeepDive["retail_sentiment"],
    institutional_activity:
      institutional as DeepDive["institutional_activity"],
    technical_setup: technical as DeepDive["technical_setup"],
    entry_comment: asString(raw.entry_comment, ""),
    bear_case: bearCase,
    verdict: verdict as DeepDive["verdict"],
    verdict_reasoning: asString(raw.verdict_reasoning, ""),
  };
}

export async function POST(req: NextRequest) {
  let body: DeepDiveRequest;
  try {
    body = (await req.json()) as DeepDiveRequest;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const symbol =
    typeof body.symbol === "string" ? body.symbol.trim().toUpperCase() : "";
  if (!symbol) {
    return NextResponse.json({ error: "Missing symbol" }, { status: 400 });
  }

  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v)
      ? v
      : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))
        ? Number(v)
        : null;

  const prompt = buildPrompt({
    symbol,
    companyName: typeof body.companyName === "string" ? body.companyName : "",
    catalyst: typeof body.catalyst === "string" ? body.catalyst : "",
    current_price: num(body.current_price),
    week_52_low: num(body.week_52_low),
    week_52_high: num(body.week_52_high),
    forward_pe: num(body.forward_pe),
    analyst_target: num(body.analyst_target),
  });

  const res = await askPerplexityRaw(prompt, {
    maxTokens: 2000,
    label: `deep-dive:${symbol}`,
  });
  if (!res) {
    return NextResponse.json(
      { error: "Perplexity unavailable" },
      { status: 502 },
    );
  }
  const obj = extractJsonObject(res.text);
  if (!obj) {
    console.warn(
      `[swings/discover/deep-dive] ${symbol}: could not extract JSON. Raw: ${res.text.slice(0, 800)}`,
    );
    return NextResponse.json(
      {
        error: "Could not parse deep dive response",
        raw: res.text.slice(0, 800),
      },
      { status: 502 },
    );
  }
  const deepDive = coerceDeepDive(obj);
  return NextResponse.json({ deep_dive: deepDive });
}

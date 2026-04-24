import { NextResponse } from "next/server";
import { askPerplexityRaw } from "@/lib/perplexity";
import { createServerClient } from "@/lib/supabase";
import { getQuoteEnrichment } from "@/lib/yahoo";

export const dynamic = "force-dynamic";
// Three Perplexity calls + Yahoo enrichment typically lands around 15-25s.
// Vercel's default Hobby limit is 10s, so we need to raise it explicitly.
export const maxDuration = 60;

// ------------------------------------------------------------
// Prompts — three passes targeting different flavors of setup.
// ------------------------------------------------------------

// Shared "less obvious" steering shipped on every prompt — pushes the
// model away from the standard mega-cap roster the trader has already
// seen everywhere.
const UNDER_THE_RADAR_NOTE = `Important: the trader already knows about mega-cap tech like NVDA, AAPL, MSFT, GOOGL, META, AMZN. Do not include these unless there is a very specific near-term catalyst that is NOT already priced in. Prioritize mid-cap and small-cap names ($1B-$50B market cap) with strong catalysts that haven't been fully covered by mainstream financial media.

Include at least 2-3 less widely-covered names that analysts are quietly upgrading or that have strong fundamental momentum not yet reflected in widespread coverage. Do not just return the most obvious large-cap names everyone already knows.`;

const PROMPT_MOMENTUM = `You are a financial analyst helping a swing trader find 1-6 month opportunities.

The trader's style:
- Quality companies temporarily mispriced
- Catalyst-driven moves (product launches, partnerships, earnings beats, sector rotation)
- Prefers beaten-down quality names with recovery potential over pure momentum chases
- 1-6 month time horizon
- Avoids: penny stocks (<$10), pure meme plays, crypto-adjacent without real business

Find 8-10 US stocks with the strongest bullish catalyst momentum RIGHT NOW. Focus on:
- Recent analyst upgrades or price target raises
- Specific near-term product/partnership catalysts
- Stocks that haven't fully priced in the narrative

${UNDER_THE_RADAR_NOTE}

Return ONLY a JSON array, no markdown, no preamble:
[{
  "symbol": "AMD",
  "catalyst": "MI350 chip launch + Microsoft partnership",
  "sentiment": "bullish",
  "timeframe": "3months",
  "thesis": "one sentence why this could move",
  "confidence": "high|medium|low",
  "risk": "one sentence main downside risk",
  "category": "momentum"
}]`;

const PROMPT_RECOVERY = `You are a financial analyst helping a swing trader.

Find 8-10 quality US stocks (market cap >$5B) that are:
- Trading significantly below 52-week highs
- Have a specific recovery catalyst in next 6 months
- Fundamental business is still strong despite price drop
- Beaten down by macro/sentiment not by broken thesis

Examples of what this trader already holds as long-term: CRM, NOW, NKE, ELF, RKT — similar quality/recovery profile preferred.

${UNDER_THE_RADAR_NOTE}

Return ONLY a JSON array, no markdown:
[{
  "symbol": "NKE",
  "catalyst": "Tariff resolution + new CEO turnaround",
  "sentiment": "bullish",
  "timeframe": "6months",
  "thesis": "one sentence recovery thesis",
  "confidence": "high|medium|low",
  "risk": "one sentence main risk",
  "category": "recovery"
}]`;

const PROMPT_THEMES = `What are the 2-3 strongest sector themes in the US market RIGHT NOW with specific stock examples that haven't fully priced in the narrative?

For each theme, give 8-10 stock examples spread across the themes (so 3-4 per theme).

${UNDER_THE_RADAR_NOTE}

Return ONLY a JSON array, no markdown:
[{
  "theme": "AI Infrastructure Buildout",
  "momentum": "strong|moderate|fading",
  "symbol": "NVDA",
  "catalyst": "specific reason this stock fits theme",
  "sentiment": "bullish|mixed|bearish",
  "timeframe": "1month|3months|6months",
  "thesis": "one sentence",
  "confidence": "high|medium|low",
  "risk": "one sentence",
  "category": "theme"
}]`;

const PROMPT_SOCIAL = `You are helping a swing trader find stocks with strong retail and social media momentum RIGHT NOW.

Search across: X/Twitter trading communities, Reddit (r/wallstreetbets, r/stocks, r/investing, r/SecurityAnalysis), YouTube financial creators, Stocktwits, financial Substacks, and trading blogs.

Find 6-8 stocks where:
- Retail traders and financial social media are showing unusual excitement or attention
- The retail thesis has REAL fundamental backing (not just a pure meme pump)
- Retail sentiment appears to be AHEAD of analyst consensus — the crowd sees something institutions haven't caught up to yet
- There is unusual options activity or volume being discussed in trading communities

Exclude: pure meme stocks with no business fundamentals, crypto tokens, stocks already up >40% in the last month with no new catalyst.

The trader's style: quality companies, catalyst-driven, 1-6 month horizon. Medium conviction in fundamentals.

Return ONLY a JSON array, no markdown, no preamble:
[{
  "symbol": "HOOD",
  "catalyst": "specific social/retail catalyst",
  "sentiment": "bullish|bearish|mixed",
  "timeframe": "1month|3months|6months",
  "thesis": "one sentence — why retail is excited",
  "confidence": "high|medium|low",
  "risk": "one sentence main risk",
  "category": "social"
}]`;

// ------------------------------------------------------------
// JSON extraction cascade. Models wrap arrays inconsistently —
// walks direct parse → ```json fence → any fence → outer [] regex.
// ------------------------------------------------------------

function tryParse(text: string): unknown | undefined {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function sanitizeJson(text: string): string {
  return text
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/,\s*([\]}])/g, "$1")
    .replace(/[﻿​]/g, "");
}

function extractJsonArray(text: string): unknown[] {
  const trimmed = text.trim();
  const direct = tryParse(trimmed);
  if (Array.isArray(direct)) return direct;
  const jsonFence = trimmed.match(/```json\s*([\s\S]*?)\s*```/i);
  if (jsonFence) {
    const parsed = tryParse(sanitizeJson(jsonFence[1].trim()));
    if (Array.isArray(parsed)) return parsed;
  }
  const anyFence = trimmed.match(/```\s*([\s\S]*?)\s*```/);
  if (anyFence) {
    const parsed = tryParse(sanitizeJson(anyFence[1].trim()));
    if (Array.isArray(parsed)) return parsed;
  }
  const arrayMatch = trimmed.match(/\[[\s\S]*\]/);
  if (arrayMatch) {
    const parsed = tryParse(arrayMatch[0]);
    if (Array.isArray(parsed)) return parsed;
    const sanitized = tryParse(sanitizeJson(arrayMatch[0]));
    if (Array.isArray(sanitized)) return sanitized;
  }
  return [];
}

// ------------------------------------------------------------
// Candidate shaping
// ------------------------------------------------------------

type Category = "momentum" | "recovery" | "theme" | "social";

type RawCandidate = {
  symbol: string;
  catalyst: string;
  sentiment: string;
  timeframe: string;
  thesis: string;
  confidence: string;
  risk: string;
  category: Category;
  theme?: string | null;
  theme_momentum?: string | null;
};

type EnrichedCandidate = RawCandidate & {
  company_name: string | null;
  current_price: number | null;
  week_52_low: number | null;
  week_52_high: number | null;
  forward_pe: number | null;
  analyst_target: number | null;
  price_change_pct: number | null;
  pct_from_52w_high: number | null;
  upside_to_target: number | null;
};

function coerceCategory(raw: unknown, fallback: Category): Category {
  if (
    raw === "momentum" ||
    raw === "recovery" ||
    raw === "theme" ||
    raw === "social"
  ) {
    return raw;
  }
  return fallback;
}

function coerceSentiment(v: unknown): string {
  const s = typeof v === "string" ? v.toLowerCase() : "";
  if (s === "bullish" || s === "bearish" || s === "mixed" || s === "neutral") return s;
  return "neutral";
}

function coerceConfidence(v: unknown): string {
  const s = typeof v === "string" ? v.toLowerCase() : "";
  if (s === "high" || s === "medium" || s === "low") return s;
  return "medium";
}

function coerceTimeframe(v: unknown): string {
  const s = typeof v === "string" ? v.toLowerCase().replace(/\s/g, "") : "";
  if (s === "1month" || s === "3months" || s === "6months") return s;
  return "3months";
}

function coerceCandidate(
  raw: unknown,
  fallbackCategory: Category,
): RawCandidate | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const symbol =
    typeof r.symbol === "string" ? r.symbol.trim().toUpperCase() : "";
  if (!symbol || !/^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol)) return null;
  return {
    symbol,
    catalyst: typeof r.catalyst === "string" ? r.catalyst.trim() : "",
    sentiment: coerceSentiment(r.sentiment),
    timeframe: coerceTimeframe(r.timeframe),
    thesis: typeof r.thesis === "string" ? r.thesis.trim() : "",
    confidence: coerceConfidence(r.confidence),
    risk: typeof r.risk === "string" ? r.risk.trim() : "",
    category: coerceCategory(r.category, fallbackCategory),
    theme: typeof r.theme === "string" ? r.theme.trim() : null,
    theme_momentum:
      typeof r.momentum === "string" ? r.momentum.toLowerCase() : null,
  };
}

async function runQuery(
  prompt: string,
  fallbackCategory: Category,
  label: string,
): Promise<RawCandidate[]> {
  const res = await askPerplexityRaw(prompt, { maxTokens: 1500, label });
  if (!res) {
    console.warn(`[swings/discover] ${label}: no response`);
    return [];
  }
  const arr = extractJsonArray(res.text);
  console.log(
    `[swings/discover] ${label} parsed ${arr.length} rows from ${res.text.length} chars`,
  );
  return arr
    .map((r) => coerceCandidate(r, fallbackCategory))
    .filter((c): c is RawCandidate => c !== null);
}

// Small deterministic sleep — Yahoo tolerates bursts but the spec asks
// for a 100ms stagger to stay polite.
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function enrichCandidates(
  candidates: RawCandidate[],
): Promise<EnrichedCandidate[]> {
  const out: EnrichedCandidate[] = [];
  for (const c of candidates) {
    const q = await getQuoteEnrichment(c.symbol);
    const current = q?.regularMarketPrice ?? null;
    const high = q?.fiftyTwoWeekHigh ?? null;
    const low = q?.fiftyTwoWeekLow ?? null;
    const target = q?.targetMeanPrice ?? null;
    const pctFromHigh =
      current !== null && high !== null && high > 0
        ? ((current - high) / high) * 100
        : null;
    const upsideToTarget =
      current !== null && target !== null && current > 0
        ? ((target - current) / current) * 100
        : null;
    out.push({
      ...c,
      company_name: q?.companyName ?? null,
      current_price: current,
      week_52_low: low,
      week_52_high: high,
      forward_pe: q?.forwardPE ?? null,
      analyst_target: target,
      price_change_pct: q?.regularMarketChangePercent ?? null,
      pct_from_52w_high: pctFromHigh,
      upside_to_target: upsideToTarget,
    });
    await sleep(100);
  }
  return out;
}

// ------------------------------------------------------------
// POST — run a fresh scan, persist, return enriched candidates.
// ------------------------------------------------------------

export async function POST() {
  // Sequential — Perplexity rate-limits aggressively, and we're on one
  // network request at a time anyway (serverless instance).
  const momentum = await runQuery(PROMPT_MOMENTUM, "momentum", "momentum");
  const recovery = await runQuery(PROMPT_RECOVERY, "recovery", "recovery");
  const themes = await runQuery(PROMPT_THEMES, "theme", "themes");
  const social = await runQuery(PROMPT_SOCIAL, "social", "social");

  // Dedupe by symbol — first occurrence wins so the higher-priority
  // category (momentum > recovery > theme > social) gets to keep the slot.
  const seen = new Set<string>();
  const unique: RawCandidate[] = [];
  for (const bucket of [momentum, recovery, themes, social]) {
    for (const c of bucket) {
      if (seen.has(c.symbol)) continue;
      seen.add(c.symbol);
      unique.push(c);
    }
  }

  if (unique.length === 0) {
    return NextResponse.json(
      {
        error:
          "No candidates returned — Perplexity may be unavailable or the model produced no parseable output.",
      },
      { status: 502 },
    );
  }

  const enriched = await enrichCandidates(unique);

  const sb = createServerClient();
  // Single-row table semantics: wipe previous scan results before writing
  // the new one. If the delete fails we still try the insert so a scan
  // never silently drops on the floor.
  const delRes = await sb.from("swing_scan_results").delete().neq("id", "00000000-0000-0000-0000-000000000000");
  if (delRes.error) {
    console.warn(`[swings/discover] delete prev failed: ${delRes.error.message}`);
  }
  const scannedAt = new Date().toISOString();
  const insRes = await sb
    .from("swing_scan_results")
    .insert({ candidates: enriched, scanned_at: scannedAt })
    .select()
    .single();
  if (insRes.error) {
    console.warn(`[swings/discover] insert failed: ${insRes.error.message}`);
    return NextResponse.json(
      { error: insRes.error.message, candidates: enriched, scanned_at: scannedAt },
      { status: 500 },
    );
  }

  return NextResponse.json({
    candidates: enriched,
    scanned_at: scannedAt,
    counts: {
      momentum: enriched.filter((c) => c.category === "momentum").length,
      recovery: enriched.filter((c) => c.category === "recovery").length,
      theme: enriched.filter((c) => c.category === "theme").length,
      social: enriched.filter((c) => c.category === "social").length,
      total: enriched.length,
    },
  });
}

// ------------------------------------------------------------
// GET — return the most recent persisted scan (or empty).
// ------------------------------------------------------------

export async function GET() {
  const sb = createServerClient();
  const res = await sb
    .from("swing_scan_results")
    .select("scanned_at,candidates")
    .order("scanned_at", { ascending: false })
    .limit(1);
  if (res.error) {
    return NextResponse.json({ error: res.error.message }, { status: 500 });
  }
  const rows = (res.data ?? []) as Array<{
    scanned_at: string;
    candidates: EnrichedCandidate[];
  }>;
  if (rows.length === 0) {
    return NextResponse.json({ candidates: [], scanned_at: null });
  }
  const row = rows[0];
  return NextResponse.json({
    candidates: row.candidates ?? [],
    scanned_at: row.scanned_at,
  });
}

import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { askPerplexityRaw } from "@/lib/perplexity";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const maxDuration = 60;

// Morning AI brief, cached one-per-day in morning_brief_cache with a
// 4-hour freshness window. GET returns the cached brief if fresh (else
// null) for page load. POST is the explicit "Regenerate" action — it
// always calls Perplexity and overwrites the cache; the frontend
// button disables itself while loading, so no server-side debounce
// is needed here.

const CACHE_TTL_MS = 4 * 60 * 60 * 1000;

function easternToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

// Strip Perplexity citation markers like [1][2] so the brief reads
// cleanly inline.
function stripCitations(text: string): string {
  return text.replace(/\[\d+\]/g, "").replace(/[ \t]{2,}/g, " ").trim();
}

type SbClient = ReturnType<typeof createServerClient>;

async function getFresh(
  sb: SbClient,
): Promise<{ brief: string; fetched_at: string } | null> {
  const today = easternToday();
  const r = await sb
    .from("morning_brief_cache")
    .select("brief,fetched_at")
    .eq("cache_date", today)
    .limit(1);
  if (r.error || !r.data || r.data.length === 0) return null;
  const row = r.data[0] as { brief: string; fetched_at: string };
  const ts = new Date(row.fetched_at).getTime();
  if (Number.isFinite(ts) && Date.now() - ts < CACHE_TTL_MS) {
    return { brief: row.brief, fetched_at: row.fetched_at };
  }
  return null;
}

export async function GET() {
  const sb = createServerClient();
  const fresh = await getFresh(sb);
  return NextResponse.json({
    brief: fresh?.brief ?? null,
    fetched_at: fresh?.fetched_at ?? null,
    cached: fresh !== null,
  });
}

export async function POST() {
  const sb = createServerClient();
  const today = easternToday();

  const prompt =
    `Market brief for today ${today}. Structure the response as markdown ` +
    "with exactly these four bold section headings, each followed by a " +
    "short paragraph (no citations):\n\n" +
    "**Market Overnight** — what happened globally overnight: macro moves, " +
    "geopolitical events, oil, rates, Asian/European markets.\n\n" +
    "**Pre-Market** — where US futures are pointing, notable pre-market " +
    "movers and why.\n\n" +
    "**Sector Watch** — which sectors are leading or lagging and why: " +
    "rotation themes, headwinds.\n\n" +
    "**Options Traders** — what this means specifically for options " +
    "traders today: volatility environment, key events, anything that " +
    "affects IV or premium pricing.\n\n" +
    "Write each section as its own paragraph with a blank line before and " +
    "after the heading, so the sections are clearly separated. Cover each " +
    "topic as thoroughly as the day's news warrants — do not artificially " +
    "shorten sections.";
  const r = await askPerplexityRaw(prompt, {
    maxTokens: 1200,
    label: "morning-brief",
  });
  if (!r || !r.text.trim()) {
    return NextResponse.json(
      { error: "Could not generate brief — Perplexity unavailable." },
      { status: 502 },
    );
  }
  const brief = stripCitations(r.text);
  const fetched_at = new Date().toISOString();
  const up = await sb
    .from("morning_brief_cache")
    .upsert({ cache_date: today, brief, fetched_at }, { onConflict: "cache_date" });
  if (up.error) {
    console.warn(`[morning-brief] cache upsert failed: ${up.error.message}`);
  }
  return NextResponse.json({ brief, fetched_at, cached: false });
}

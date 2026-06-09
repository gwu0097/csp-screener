// Perplexity-backed catalyst analysis for the long-term watchlist's
// "Run Analysis" buttons. Cached for 24h per (symbol, timeframe) so
// repeated clicks don't keep burning through the Perplexity quota.

import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { askPerplexityRaw } from "@/lib/perplexity";
import { getOrRefreshSnapshot } from "@/lib/market-snapshot";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const ALLOWED_TIMEFRAMES = ["1d", "1w", "1m"] as const;
type Timeframe = (typeof ALLOWED_TIMEFRAMES)[number];

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

type CacheRow = {
  id: string;
  symbol: string;
  timeframe: Timeframe;
  change_pct: number | null;
  analysis: string | null;
  signal: string | null;
  fetched_at: string;
};

function isFresh(row: CacheRow): boolean {
  const ts = new Date(row.fetched_at).getTime();
  return Number.isFinite(ts) && Date.now() - ts < CACHE_TTL_MS;
}

function timeframeLabel(t: Timeframe): string {
  switch (t) {
    case "1d":
      return "last trading day";
    case "1w":
      return "last 5 trading days";
    case "1m":
      return "last month";
  }
}

// Extract a coarse hold/add/trim/cut hint from the LLM text. Looks
// for a sentence-final verb / "Action: X" pattern. Returns null when
// nothing matches — UI just shows the prose in that case.
function extractSignal(text: string): string | null {
  const match =
    /\b(HOLD|ADD|TRIM|CUT|BUY|SELL)\b/i.exec(text) ??
    /Action[:\s-]+(HOLD|ADD|TRIM|CUT|BUY|SELL)\b/i.exec(text);
  return match ? match[1].toUpperCase() : null;
}

export async function GET(req: NextRequest) {
  const symbol = (req.nextUrl.searchParams.get("symbol") ?? "").trim().toUpperCase();
  const tf = (req.nextUrl.searchParams.get("timeframe") ?? "1d") as Timeframe;
  if (!symbol) {
    return NextResponse.json({ error: "Missing symbol" }, { status: 400 });
  }
  if (!(ALLOWED_TIMEFRAMES as readonly string[]).includes(tf)) {
    return NextResponse.json({ error: "Invalid timeframe" }, { status: 400 });
  }

  const sb = createServerClient();

  // 1. Cache lookup.
  const cacheRes = await sb
    .from("catalyst_cache")
    .select("*")
    .eq("symbol", symbol)
    .eq("timeframe", tf)
    .limit(1);
  if (!cacheRes.error && cacheRes.data && cacheRes.data.length > 0) {
    const row = cacheRes.data[0] as CacheRow;
    if (isFresh(row)) {
      return NextResponse.json({
        symbol,
        timeframe: tf,
        change_pct: row.change_pct,
        analysis: row.analysis,
        signal: row.signal,
        cached: true,
        fetched_at: row.fetched_at,
      });
    }
  }

  // 2. Company name + a coarse change-pct to feed the prompt, read from
  //    the shared snapshot cache (these are watchlist symbols, almost
  //    always already warm). Null snapshot → omit price gracefully.
  const snap = await getOrRefreshSnapshot(symbol, 15).catch(() => null);
  const companyName = snap?.company_name ?? symbol;
  const change = snap?.change_pct ?? null;
  const changeText =
    change !== null && Number.isFinite(change)
      ? `${change >= 0 ? "+" : ""}${change.toFixed(2)}%`
      : "a notable %";

  // 3. Perplexity call.
  const prompt =
    `What caused ${companyName} (${symbol}) stock to move ${changeText} over the ${timeframeLabel(tf)}? ` +
    "Is this catalyst fundamental or technical? Is it temporary or structural? " +
    "What should a long-term investor do — hold, add, trim, or cut? Be concise, 3–4 sentences. " +
    "End your answer with: Action: HOLD|ADD|TRIM|CUT.";
  const pplx = await askPerplexityRaw(prompt, {
    maxTokens: 400,
    label: `catalyst(${symbol},${tf})`,
  });
  if (!pplx) {
    return NextResponse.json(
      { error: "Perplexity unavailable" },
      { status: 502 },
    );
  }
  const analysis = pplx.text.trim();
  const signal = extractSignal(analysis);

  // 4. Upsert into cache.
  const insertRow = {
    symbol,
    timeframe: tf,
    change_pct: change,
    analysis,
    signal,
    fetched_at: new Date().toISOString(),
  };
  const up = await sb
    .from("catalyst_cache")
    .upsert(insertRow, { onConflict: "symbol,timeframe" });
  if (up.error) {
    console.warn(
      `[catalyst] upsert(${symbol},${tf}) failed: ${up.error.message}`,
    );
  }

  return NextResponse.json({
    symbol,
    timeframe: tf,
    change_pct: change,
    analysis,
    signal,
    cached: false,
    fetched_at: insertRow.fetched_at,
    citations: pplx.citations,
  });
}

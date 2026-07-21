// On-demand "Research" data for an expanded Buy Zone row: insider
// activity + an upcoming-catalyst read. Both reuse existing
// infrastructure rather than a new pipeline:
//   - insider: getFinnhubInsiderTransactions + classifyInsiderTxs,
//     the same finnhub_cache-backed function/classifier used by the
//     swing screener — if the symbol was already researched anywhere
//     else in the app, this is a cache hit, zero new Finnhub calls.
//   - catalyst: the same catalyst_cache table + askPerplexityRaw call
//     already used by the long-term watchlist's "Run Analysis"
//     button, under a new 'upcoming' timeframe bucket (forward-
//     looking, vs. the existing 1d/1w/1m reactive-move buckets).
import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { requireUserId, authErrorResponse } from "@/lib/auth";
import { askPerplexityRaw } from "@/lib/perplexity";
import { getOrRefreshSnapshot } from "@/lib/market-snapshot";
import { getFinnhubInsiderTransactions } from "@/lib/earnings";
import { classifyInsiderTxs } from "@/lib/swing-screener";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const CATALYST_TTL_MS = 24 * 60 * 60 * 1000;

type CatalystCacheRow = {
  analysis: string | null;
  fetched_at: string;
};

function isFresh(row: CatalystCacheRow): boolean {
  const ts = new Date(row.fetched_at).getTime();
  return Number.isFinite(ts) && Date.now() - ts < CATALYST_TTL_MS;
}

export async function GET(req: NextRequest) {
  try {
    await requireUserId();
  } catch (e) {
    return authErrorResponse(e);
  }
  const symbol = (req.nextUrl.searchParams.get("symbol") ?? "").trim().toUpperCase();
  if (!symbol) {
    return NextResponse.json({ error: "Missing symbol" }, { status: 400 });
  }

  const sb = createServerClient();

  const [insiderRows, catalystCacheRes, snap] = await Promise.all([
    getFinnhubInsiderTransactions(symbol, 90).catch(() => []),
    sb.from("catalyst_cache").select("analysis,fetched_at").eq("symbol", symbol).eq("timeframe", "upcoming").limit(1),
    getOrRefreshSnapshot(symbol, 15).catch(() => null),
  ]);
  const { transactions, executiveBuys, signal } = classifyInsiderTxs(insiderRows);

  let catalystAnalysis: string | null = null;
  let catalystCached = false;
  let catalystFetchedAt: string | null = null;

  const cachedRow = !catalystCacheRes.error && catalystCacheRes.data?.[0]
    ? (catalystCacheRes.data[0] as CatalystCacheRow)
    : null;
  if (cachedRow && isFresh(cachedRow)) {
    catalystAnalysis = cachedRow.analysis;
    catalystCached = true;
    catalystFetchedAt = cachedRow.fetched_at;
  } else {
    const companyName = snap?.company_name ?? symbol;
    const prompt =
      `What upcoming catalysts could move ${companyName} (${symbol}) stock over the next 1-3 months — ` +
      "next earnings date, pending product launches, regulatory decisions, litigation, or other scheduled " +
      "events? Be concise, 2-4 sentences. If nothing specific is scheduled, say so plainly.";
    const pplx = await askPerplexityRaw(prompt, {
      maxTokens: 400,
      label: `buy-zone-catalyst(${symbol})`,
    });
    if (pplx) {
      catalystAnalysis = pplx.text.trim();
      catalystFetchedAt = new Date().toISOString();
      const up = await sb.from("catalyst_cache").upsert(
        {
          symbol,
          timeframe: "upcoming",
          change_pct: snap?.change_pct ?? null,
          analysis: catalystAnalysis,
          signal: null,
          fetched_at: catalystFetchedAt,
        },
        { onConflict: "symbol,timeframe" },
      );
      if (up.error) {
        console.warn(`[buy-zone-research] catalyst upsert(${symbol}) failed: ${up.error.message}`);
      }
    }
  }

  return NextResponse.json({
    symbol,
    insider: {
      signal,
      executiveBuys,
      transactions: transactions.slice(0, 8),
    },
    catalyst: {
      analysis: catalystAnalysis,
      cached: catalystCached,
      fetched_at: catalystFetchedAt,
    },
  });
}

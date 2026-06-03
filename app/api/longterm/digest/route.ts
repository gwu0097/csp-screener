// Weekly digest endpoint — surfaces the top 3 movers up + 3 movers
// down over the past week across the entire watchlist, plus a
// per-mover Perplexity catalyst. Cached for 24h in
// longterm_digest_cache so refreshing the modal is instant.

import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { askPerplexityRaw } from "@/lib/perplexity";
import { getHistoricalPrices, getQuoteEnrichment } from "@/lib/yahoo";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

type Mover = {
  symbol: string;
  companyName: string | null;
  changePct: number;
  catalyst: string | null;
};

type DigestPayload = {
  weekStart: string;
  weekEnd: string;
  upMovers: Mover[];
  downMovers: Mover[];
  cached: boolean;
  fetched_at: string;
};

function thisIsoWeekKey(): string {
  // ISO week key — Monday-start. Used as cache key so the same week's
  // digest reuses the cached payload.
  const d = new Date();
  const day = d.getUTCDay();
  const mondayOffset = (day + 6) % 7;
  d.setUTCDate(d.getUTCDate() - mondayOffset);
  return d.toISOString().slice(0, 10);
}

async function getWeekChangePct(symbol: string): Promise<number | null> {
  const to = new Date();
  const from = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  const bars = await getHistoricalPrices(symbol, from, to);
  if (bars.length === 0) return null;
  const sorted = [...bars].sort(
    (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
  );
  const earliest = sorted[0]?.close;
  const latest = sorted[sorted.length - 1]?.close;
  if (typeof earliest !== "number" || typeof latest !== "number" || earliest <= 0) {
    return null;
  }
  return ((latest - earliest) / earliest) * 100;
}

async function getPerplexityCatalyst(symbol: string, companyName: string, changePct: number): Promise<string | null> {
  const direction = changePct >= 0 ? `up ${changePct.toFixed(1)}%` : `down ${Math.abs(changePct).toFixed(1)}%`;
  const prompt =
    `${companyName} (${symbol}) is ${direction} over the past week. ` +
    "In 2 sentences, what's the most likely catalyst, and is it fundamental or technical?";
  const r = await askPerplexityRaw(prompt, {
    maxTokens: 200,
    label: `digest(${symbol})`,
  });
  return r?.text.trim() ?? null;
}

export async function GET() {
  const sb = createServerClient();
  const cacheKey = `weekly-${thisIsoWeekKey()}`;

  // 1. Cache lookup.
  const cached = await sb
    .from("longterm_digest_cache")
    .select("payload,fetched_at")
    .eq("cache_key", cacheKey)
    .limit(1);
  if (!cached.error && cached.data && cached.data.length > 0) {
    const row = cached.data[0] as { payload: DigestPayload; fetched_at: string };
    const ts = new Date(row.fetched_at).getTime();
    if (Number.isFinite(ts) && Date.now() - ts < CACHE_TTL_MS) {
      return NextResponse.json({ ...row.payload, cached: true });
    }
  }

  // 2. Pull every watchlist symbol.
  const wlRes = await sb
    .from("long_term_watchlist")
    .select("symbol");
  if (wlRes.error) {
    return NextResponse.json({ error: wlRes.error.message }, { status: 500 });
  }
  const symbols = ((wlRes.data ?? []) as Array<{ symbol: string }>).map((r) => r.symbol);
  if (symbols.length === 0) {
    return NextResponse.json({
      weekStart: thisIsoWeekKey(),
      weekEnd: new Date().toISOString().slice(0, 10),
      upMovers: [],
      downMovers: [],
      cached: false,
      fetched_at: new Date().toISOString(),
    });
  }

  // 3. Compute weekly change for every symbol in parallel.
  type Pair = { symbol: string; change: number | null };
  const pairs: Pair[] = await Promise.all(
    symbols.map(async (s) => ({ symbol: s, change: await getWeekChangePct(s) })),
  );
  const valid = pairs
    .filter((p): p is { symbol: string; change: number } => p.change !== null)
    .sort((a, b) => b.change - a.change);
  const upMoversRaw = valid.slice(0, 3);
  const downMoversRaw = valid.slice(-3).reverse();

  // 4. Pull company name + Perplexity catalyst for each mover. We
  //    only spend on the 6 stories (3 + 3) to keep latency bounded.
  async function expandMover(p: { symbol: string; change: number }): Promise<Mover> {
    const quote = await getQuoteEnrichment(p.symbol).catch(() => null);
    const companyName = quote?.companyName ?? p.symbol;
    const catalyst = await getPerplexityCatalyst(p.symbol, companyName, p.change);
    return { symbol: p.symbol, companyName, changePct: p.change, catalyst };
  }
  const [upMovers, downMovers] = await Promise.all([
    Promise.all(upMoversRaw.map(expandMover)),
    Promise.all(downMoversRaw.map(expandMover)),
  ]);

  const payload: DigestPayload = {
    weekStart: thisIsoWeekKey(),
    weekEnd: new Date().toISOString().slice(0, 10),
    upMovers,
    downMovers,
    cached: false,
    fetched_at: new Date().toISOString(),
  };

  // 5. Cache.
  await sb
    .from("longterm_digest_cache")
    .upsert(
      { cache_key: cacheKey, payload, fetched_at: payload.fetched_at },
      { onConflict: "cache_key" },
    );

  return NextResponse.json(payload);
}

export async function DELETE() {
  const sb = createServerClient();
  const cacheKey = `weekly-${thisIsoWeekKey()}`;
  const res = await sb
    .from("longterm_digest_cache")
    .delete()
    .eq("cache_key", cacheKey);
  if (res.error) {
    return NextResponse.json({ error: res.error.message }, { status: 500 });
  }
  return NextResponse.json({ cleared: cacheKey });
}

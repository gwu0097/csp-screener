import { NextRequest, NextResponse } from "next/server";
import {
  deserializePass1,
  pass2Enrich,
  pass3CatalystDiscovery,
  type Pass1Wire,
} from "@/lib/swing-screener";

export const dynamic = "force-dynamic";
// Pass 2 = Finnhub insider + earnings + Schwab options across all of
// Pass 1's survivors, then Pass 3 = Perplexity catalyst discovery in
// batches of 3. With ~30-50 survivors and a 200ms anti-burst gap on
// Finnhub, the whole route can run 60-180s — way past the default
// ceiling. Sit at the Pro-plan 300s budget the predecessor
// /swings/screen used before the split.
export const maxDuration = 300;

export async function POST(req: NextRequest): Promise<NextResponse> {
  const started = Date.now();
  let body: Pass1Wire;
  try {
    body = (await req.json()) as Pass1Wire;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!body || !Array.isArray(body.survivors)) {
    return NextResponse.json(
      { error: "Missing or invalid pass1 payload" },
      { status: 400 },
    );
  }
  const { quotes, trades, tier2ByCandidate } = deserializePass1(body);
  const enriched = await pass2Enrich(
    body.survivors,
    quotes,
    trades,
    tier2ByCandidate,
  );
  // Pass 3 — catalyst discovery via Perplexity. Runs on the post-tier-1
  // survivor set (typically 5-15 candidates × ~3s in batches of 3 with a
  // 500ms gap = ~15-30s), keeping the route well under 60s. Re-sorts
  // because catalyst bonus can shift ranking.
  const candidates = await pass3CatalystDiscovery(enriched);
  candidates.sort((a, b) => b.setupScore - a.setupScore);
  return NextResponse.json({
    candidates,
    durationMs: Date.now() - started,
  });
}

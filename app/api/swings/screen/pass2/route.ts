import { NextRequest, NextResponse } from "next/server";
import {
  deserializePass1,
  pass2Enrich,
  type Pass1Wire,
} from "@/lib/swing-screener";

export const dynamic = "force-dynamic";
// Pass 2 = Finnhub insider + earnings + Schwab options on Pass 1's
// survivors. With concurrency=5 and ~30-50 survivors, total enrichment
// runs 25-45s — comfortably under the 60s default.

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
  const candidates = await pass2Enrich(
    body.survivors,
    quotes,
    trades,
    tier2ByCandidate,
  );
  return NextResponse.json({
    candidates,
    durationMs: Date.now() - started,
  });
}

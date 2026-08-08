import { NextRequest, NextResponse } from "next/server";
import {
  deserializePass1,
  computeRsPullbackCandidates,
  DEFAULT_RS_PULLBACK_THRESHOLDS,
  type Pass1Wire,
  type RsPullbackThresholds,
} from "@/lib/swing-screener";

export const dynamic = "force-dynamic";
// Separate route from /pass2, deliberately — RS Pullback's enrichment
// (bars + earnings + sector per pregated symbol) is its own fetch/compute
// budget and doesn't need Finnhub insider data or a Schwab options chain.
// Keeping it out of /pass2 means neither route risks tipping the other
// closer to the 60s Hobby ceiling.
export const maxDuration = 60;

export async function POST(req: NextRequest): Promise<NextResponse> {
  const started = Date.now();
  let body: Pass1Wire & { forceFresh?: boolean; rsPullbackThresholds?: unknown };
  try {
    body = (await req.json()) as Pass1Wire & {
      forceFresh?: boolean;
      rsPullbackThresholds?: unknown;
    };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!body || !Array.isArray(body.survivors)) {
    return NextResponse.json(
      { error: "Missing or invalid pass1 payload" },
      { status: 400 },
    );
  }
  const thresholds: RsPullbackThresholds =
    body.rsPullbackThresholds && typeof body.rsPullbackThresholds === "object"
      ? (body.rsPullbackThresholds as RsPullbackThresholds)
      : DEFAULT_RS_PULLBACK_THRESHOLDS;
  try {
    const { quotes } = deserializePass1(body);
    const result = await computeRsPullbackCandidates(quotes, thresholds, {
      forceFresh: body.forceFresh === true,
    });
    return NextResponse.json({
      candidates: result.candidates,
      pregatedCount: result.pregatedCount,
      excludedBySma50Rising: result.excludedBySma50Rising,
      durationMs: Date.now() - started,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "pass2-rs-pullback failed";
    console.error("[swings/pass2-rs-pullback] failed:", e);
    return NextResponse.json({ error: `RS Pullback: ${msg}` }, { status: 500 });
  }
}

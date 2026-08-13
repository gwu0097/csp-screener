import { NextRequest, NextResponse } from "next/server";
import {
  deserializePass1,
  type Pass1Wire,
} from "@/lib/swing-screener";
import {
  computeBaseBreakoutCandidates,
  DEFAULT_BASE_BREAKOUT_THRESHOLDS,
  type BaseBreakoutThresholds,
} from "@/lib/base-breakout";

export const dynamic = "force-dynamic";
// Separate route from /pass2 and /pass2-rs-pullback, deliberately —
// mirrors pass2-rs-pullback/route.ts exactly. Base Breakout's enrichment
// (bars + sector + earnings per symbol) is its own fetch/compute budget
// and doesn't need Finnhub insider data or a Schwab options chain either.
//
// Processes exactly the `symbols` chunk it's given — called sequentially
// AFTER both /pass2 and /pass2-rs-pullback have fully finished, never
// concurrently with either (same Finnhub-rate-limit discipline documented
// on pass2-rs-pullback/route.ts and in swing-screen-view.tsx's runScreen).
export const maxDuration = 60;

export async function POST(req: NextRequest): Promise<NextResponse> {
  const started = Date.now();
  let body: Pass1Wire & { forceFresh?: boolean; baseBreakoutThresholds?: unknown; symbols?: unknown };
  try {
    body = (await req.json()) as Pass1Wire & {
      forceFresh?: boolean;
      baseBreakoutThresholds?: unknown;
      symbols?: unknown;
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
  if (!Array.isArray(body.symbols)) {
    return NextResponse.json(
      { error: "Missing symbols array (the chunk to enrich)" },
      { status: 400 },
    );
  }
  const symbols = body.symbols.filter((s): s is string => typeof s === "string");
  const thresholds: BaseBreakoutThresholds =
    body.baseBreakoutThresholds && typeof body.baseBreakoutThresholds === "object"
      ? (body.baseBreakoutThresholds as BaseBreakoutThresholds)
      : DEFAULT_BASE_BREAKOUT_THRESHOLDS;
  try {
    const { quotes } = deserializePass1(body);
    const result = await computeBaseBreakoutCandidates(symbols, quotes, thresholds, {
      forceFresh: body.forceFresh === true,
    });
    return NextResponse.json({
      candidates: result.candidates,
      excludedBySector: result.excludedBySector,
      excludedByInsufficientBars: result.excludedByInsufficientBars,
      excludedByEvalFailure: result.excludedByEvalFailure,
      excludedByEarningsWindow: result.excludedByEarningsWindow,
      excludedByBaseRange: result.excludedByBaseRange,
      excludedByBaseLength: result.excludedByBaseLength,
      excludedByAtrContraction: result.excludedByAtrContraction,
      excludedByNoValidTrigger: result.excludedByNoValidTrigger,
      degradedCount: result.degradedCount,
      deadlineSkipped: result.deadlineSkipped,
      durationMs: Date.now() - started,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "pass2-base-breakout failed";
    console.error("[swings/pass2-base-breakout] failed:", e);
    return NextResponse.json({ error: `Base Breakout: ${msg}` }, { status: 500 });
  }
}

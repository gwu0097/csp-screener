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
// (bars + earnings + sector per symbol) is its own fetch/compute budget
// and doesn't need Finnhub insider data or a Schwab options chain.
//
// Processes exactly the `symbols` chunk it's given — the client (see
// swing-screen-view.tsx) computes pass1's rsPullback.needsEnrichment once
// (already narrowed by the free cache-only pre-filter in pass1Filter),
// splits it into chunks sized to comfortably finish under the 60s
// ceiling, and calls this route once per chunk, sequentially, after
// /pass2 has fully finished (not concurrently — both routes would
// otherwise compete for the same Finnhub rate-limit budget, which is
// exactly what dropped the legacy tab count in the 2026-08 run).
export const maxDuration = 60;

export async function POST(req: NextRequest): Promise<NextResponse> {
  const started = Date.now();
  let body: Pass1Wire & { forceFresh?: boolean; rsPullbackThresholds?: unknown; symbols?: unknown };
  try {
    body = (await req.json()) as Pass1Wire & {
      forceFresh?: boolean;
      rsPullbackThresholds?: unknown;
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
  const thresholds: RsPullbackThresholds =
    body.rsPullbackThresholds && typeof body.rsPullbackThresholds === "object"
      ? (body.rsPullbackThresholds as RsPullbackThresholds)
      : DEFAULT_RS_PULLBACK_THRESHOLDS;
  try {
    const { quotes } = deserializePass1(body);
    const result = await computeRsPullbackCandidates(symbols, quotes, thresholds, {
      forceFresh: body.forceFresh === true,
    });
    return NextResponse.json({
      candidates: result.candidates,
      excludedBySma50Rising: result.excludedBySma50Rising,
      insufficientData: result.insufficientData,
      degradedCount: result.degradedCount,
      deadlineSkipped: result.deadlineSkipped,
      durationMs: Date.now() - started,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "pass2-rs-pullback failed";
    console.error("[swings/pass2-rs-pullback] failed:", e);
    return NextResponse.json({ error: `RS Pullback: ${msg}` }, { status: 500 });
  }
}

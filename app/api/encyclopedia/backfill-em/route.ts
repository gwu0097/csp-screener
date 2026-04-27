import { NextRequest, NextResponse } from "next/server";
import { backfillImpliedMoves } from "@/lib/backfill-implied-moves";

export const dynamic = "force-dynamic";
// Perplexity calls + 500ms gap each. We process up to ~40 rows per
// request and let the client re-trigger if more remain. The lib
// guards against the 60s ceiling internally and bails ~50s in.
export const maxDuration = 60;

type Body = { maxBackfills?: number };

export async function POST(req: NextRequest): Promise<NextResponse> {
  const startTimeMs = Date.now();
  let body: Body = {};
  try {
    body = (await req.json().catch(() => ({}))) as Body;
  } catch {
    /* empty body is fine */
  }
  // Each row = 1 Perplexity call (~3-5s) + 500ms gap. 40 rows fits in
  // the 50s budget with comfortable margin; clamp to that.
  const max = Math.min(
    typeof body.maxBackfills === "number" && body.maxBackfills > 0
      ? body.maxBackfills
      : 40,
    40,
  );
  try {
    const result = await backfillImpliedMoves({ maxBackfills: max, startTimeMs });
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[backfill-em] failed:", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

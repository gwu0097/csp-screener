import { NextRequest, NextResponse } from "next/server";
import {
  pass1Filter,
  serializePass1,
  type RsPullbackThresholds,
} from "@/lib/swing-screener";
import { SWING_UNIVERSE } from "@/lib/stock-universe";

export const dynamic = "force-dynamic";
// Pass 1 is batched Yahoo /quote + quoteSummary across the ~580-symbol
// SWING_UNIVERSE. Hobby plan caps function duration at 60s, so a cold
// run with retries can clip; the swing-screener handles partial Pass 1
// gracefully — survivors are computed from whatever Yahoo returned.
export const maxDuration = 60;

export async function POST(req: NextRequest): Promise<NextResponse> {
  const started = Date.now();
  let forceFresh = false;
  let rsPullbackThresholds: RsPullbackThresholds | undefined;
  try {
    const body = (await req.json().catch(() => ({}))) as {
      forceFresh?: unknown;
      rsPullbackThresholds?: unknown;
    };
    forceFresh = body.forceFresh === true;
    if (body.rsPullbackThresholds && typeof body.rsPullbackThresholds === "object") {
      rsPullbackThresholds = body.rsPullbackThresholds as RsPullbackThresholds;
    }
  } catch {
    forceFresh = false;
  }
  try {
    const result = await pass1Filter(SWING_UNIVERSE, { forceFresh, rsPullbackThresholds });
    const wire = serializePass1(result, SWING_UNIVERSE.length);
    return NextResponse.json({
      ...wire,
      durationMs: Date.now() - started,
    });
  } catch (e) {
    // Always JSON — an uncaught throw would otherwise surface as a
    // plain-text body the client can't parse.
    const msg = e instanceof Error ? e.message : "pass1 failed";
    console.error("[swings/pass1] failed:", e);
    return NextResponse.json({ error: `Pass 1: ${msg}` }, { status: 500 });
  }
}

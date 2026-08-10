import { NextRequest, NextResponse } from "next/server";
import {
  pass1Filter,
  serializePass1,
  type RsPullbackThresholds,
} from "@/lib/swing-screener";
import { SWING_UNIVERSE } from "@/lib/stock-universe";

export const dynamic = "force-dynamic";
// Pass 1 is batched Yahoo /quote + quoteSummary across the resolved
// universe — SWING_UNIVERSE (~580 symbols) by default, or whatever the
// client's universe selector resolved to (see app/api/swings/universe/
// resolve). Hobby plan caps function duration at 60s, so a cold run with
// retries can clip; the swing-screener handles partial Pass 1 gracefully
// — survivors are computed from whatever Yahoo returned.
export const maxDuration = 60;

export async function POST(req: NextRequest): Promise<NextResponse> {
  const started = Date.now();
  let forceFresh = false;
  let rsPullbackThresholds: RsPullbackThresholds | undefined;
  // Universe & Themes, Phase B — the client resolves+backfills the
  // selected universe (index, theme(s), or a combination) and passes the
  // resolved symbol list here. Falls back to SWING_UNIVERSE when omitted
  // so this route's default behavior is unchanged for any other caller.
  let symbols: string[] = SWING_UNIVERSE;
  try {
    const body = (await req.json().catch(() => ({}))) as {
      forceFresh?: unknown;
      rsPullbackThresholds?: unknown;
      symbols?: unknown;
    };
    forceFresh = body.forceFresh === true;
    if (body.rsPullbackThresholds && typeof body.rsPullbackThresholds === "object") {
      rsPullbackThresholds = body.rsPullbackThresholds as RsPullbackThresholds;
    }
    if (Array.isArray(body.symbols) && body.symbols.length > 0) {
      const provided = body.symbols.filter((s): s is string => typeof s === "string");
      if (provided.length > 0) symbols = provided;
    }
  } catch {
    forceFresh = false;
  }
  try {
    const result = await pass1Filter(symbols, { forceFresh, rsPullbackThresholds });
    const wire = serializePass1(result, symbols.length);
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

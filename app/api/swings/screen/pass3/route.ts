import { NextRequest, NextResponse } from "next/server";
import {
  pass3CatalystDiscovery,
  type KnownCatalyst,
  type SwingCandidate,
} from "@/lib/swing-screener";

export const dynamic = "force-dynamic";
// Pass 3 = Perplexity catalyst discovery in batches of 3 with a 500ms
// inter-batch gap, capped at 24 fresh calls per run (highest-scored
// first). knownCatalysts lets the client carry forward catalysts from
// a recent prior run so re-screens don't re-pay Perplexity.
export const maxDuration = 60;

type Body = {
  candidates?: SwingCandidate[];
  knownCatalysts?: Record<string, KnownCatalyst>;
};

export async function POST(req: NextRequest): Promise<NextResponse> {
  const started = Date.now();
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!Array.isArray(body.candidates)) {
    return NextResponse.json(
      { error: "Missing candidates array" },
      { status: 400 },
    );
  }
  try {
    const candidates = await pass3CatalystDiscovery(body.candidates, {
      knownCatalysts:
        body.knownCatalysts && typeof body.knownCatalysts === "object"
          ? body.knownCatalysts
          : undefined,
    });
    // Re-sort here because catalyst bonus shifts ranking.
    candidates.sort((a, b) => b.setupScore - a.setupScore);
    return NextResponse.json({
      candidates,
      durationMs: Date.now() - started,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "pass3 failed";
    console.error("[swings/pass3] failed:", e);
    return NextResponse.json({ error: `Pass 3: ${msg}` }, { status: 500 });
  }
}

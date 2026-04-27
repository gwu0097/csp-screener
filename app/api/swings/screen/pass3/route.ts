import { NextRequest, NextResponse } from "next/server";
import {
  pass3CatalystDiscovery,
  type SwingCandidate,
} from "@/lib/swing-screener";

export const dynamic = "force-dynamic";
// Pass 3 = Perplexity catalyst discovery in batches of 3 with a 500ms
// inter-batch gap. Per-call timeout in lib/perplexity (45s) keeps the
// total inside the 60s Hobby ceiling even with 10+ tier-1 survivors.
export const maxDuration = 60;

type Body = { candidates?: SwingCandidate[] };

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
  const candidates = await pass3CatalystDiscovery(body.candidates);
  // Re-sort here because catalyst bonus shifts ranking.
  candidates.sort((a, b) => b.setupScore - a.setupScore);
  return NextResponse.json({
    candidates,
    durationMs: Date.now() - started,
  });
}

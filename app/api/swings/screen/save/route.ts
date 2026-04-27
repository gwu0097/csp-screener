import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import type { SwingCandidate } from "@/lib/swing-screener";

export const dynamic = "force-dynamic";
// Persist-only — fast (<1s). Replaces the most-recent row in
// swing_screen_results so history doesn't accumulate.

type SaveBody = {
  candidates: SwingCandidate[];
  screened: number;
  pass1Survivors: number;
  pass2Results: number;
  durationMs: number;
};

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: SaveBody;
  try {
    body = (await req.json()) as SaveBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!body || !Array.isArray(body.candidates)) {
    return NextResponse.json(
      { error: "Missing candidates array" },
      { status: 400 },
    );
  }

  const sb = createServerClient();
  const del = await sb
    .from("swing_screen_results")
    .delete()
    .neq("id", "00000000-0000-0000-0000-000000000000");
  if (del.error) {
    console.warn(`[swings/screen/save] truncate failed: ${del.error.message}`);
  }
  const ins = await sb.from("swing_screen_results").insert({
    screened: body.screened,
    pass1_survivors: body.pass1Survivors,
    pass2_results: body.pass2Results,
    duration_ms: body.durationMs,
    candidates: body.candidates,
  });
  if (ins.error) {
    return NextResponse.json({ error: ins.error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true, screenedAt: new Date().toISOString() });
}

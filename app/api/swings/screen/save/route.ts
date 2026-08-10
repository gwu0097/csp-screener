import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import type { SwingCandidate } from "@/lib/swing-screener";
import { requireUserId, authErrorResponse } from "@/lib/auth";

export const dynamic = "force-dynamic";
// Persist-only — fast (<1s).
//
// Two write patterns in the same table, distinguished by `kind`:
//  - 'legacy' (the four original tabs): truncate + insert — history
//    doesn't accumulate, only the latest run is kept.
//  - 'rs_pullback': insert-only, one row per run, never deleted. A name
//    sitting a few ADR-days extended today and landing in the entry zone
//    two weeks later is the pullback actually forming — that's only
//    visible if past runs aren't overwritten.
//
// `mode` controls which path(s) actually write, so a single-tab run
// (see swing-screen-view.tsx's run-target selector) only persists what
// it actually recomputed — running RS Pullback alone must not truncate
// the legacy row with stale data, and running the legacy tabs alone must
// not append a new rs_pullback history row with unchanged data (that
// would be a duplicate entry with no new information, misleading the
// "one row per real run" semantics the append-only history depends on).
// Default 'all' matches the original (pre-mode) behavior exactly.

type SaveBody = {
  candidates: SwingCandidate[];
  screened: number;
  pass1Survivors: number;
  pass2Results: number;
  durationMs: number;
  mode?: "all" | "legacy" | "rs_pullback";
};

export async function POST(req: NextRequest): Promise<NextResponse> {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch (e) {
    return authErrorResponse(e);
  }
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
  const mode = body.mode ?? "all";

  try {
  const sb = createServerClient();

  if (mode === "all" || mode === "legacy") {
    // Scoped to kind='legacy' so it can't also wipe the append-only
    // rs_pullback rows sitting in the same table. Outcome for the four
    // legacy tabs is identical either way: exactly one row, replaced.
    const del = await sb
      .from("swing_screen_results")
      .delete()
      .eq("user_id", userId)
      .eq("kind", "legacy")
      .neq("id", "00000000-0000-0000-0000-000000000000");
    if (del.error) {
      console.warn(`[swings/screen/save] truncate failed: ${del.error.message}`);
    }
    const ins = await sb.from("swing_screen_results").insert({
      user_id: userId,
      kind: "legacy",
      screened: body.screened,
      pass1_survivors: body.pass1Survivors,
      pass2_results: body.pass2Results,
      duration_ms: body.durationMs,
      candidates: body.candidates,
    });
    if (ins.error) {
      return NextResponse.json({ error: ins.error.message }, { status: 500 });
    }
  }

  if (mode === "all" || mode === "rs_pullback") {
    // Insert-only, one row per run, never deleted. Only the
    // rs_pullback-tagged subset (a candidate can carry other tabs too via
    // confluence; the legacy row already has all of them — this row is
    // scoped so the append-only history stays about just this tab).
    const rsPullbackCandidates = body.candidates.filter((c) =>
      (c.setupTabs ?? []).includes("rs_pullback"),
    );
    if (rsPullbackCandidates.length > 0) {
      const rsIns = await sb.from("swing_screen_results").insert({
        user_id: userId,
        kind: "rs_pullback",
        screened: body.screened,
        pass1_survivors: body.pass1Survivors,
        pass2_results: body.pass2Results,
        duration_ms: body.durationMs,
        candidates: rsPullbackCandidates,
      });
      if (rsIns.error) {
        console.warn(`[swings/screen/save] rs_pullback append failed: ${rsIns.error.message}`);
      }
    }
  }

  return NextResponse.json({ ok: true, screenedAt: new Date().toISOString() });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "save failed";
    console.error("[swings/save] failed:", e);
    return NextResponse.json({ error: `Save: ${msg}` }, { status: 500 });
  }
}

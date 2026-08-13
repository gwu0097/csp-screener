import { NextResponse } from "next/server";
import type { SwingCandidate } from "@/lib/swing-screener";
import { createServerClient } from "@/lib/supabase";
import { requireUserId, authErrorResponse } from "@/lib/auth";

export const dynamic = "force-dynamic";
// Read path for the Base Breakout tab's append-only history (see /save)
// — mirrors app/api/swings/screen/rs-pullback/history/route.ts exactly,
// scoped to kind='base_breakout' instead.

const MAX_RUNS = 20;

type RunRow = {
  screenedAt: string;
  candidates: SwingCandidate[];
  universe: unknown;
  baseBreakoutDiagnostics: unknown;
};

export async function GET(): Promise<NextResponse> {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch (e) {
    return authErrorResponse(e);
  }
  const sb = createServerClient();
  const res = await sb
    .from("swing_screen_results")
    .select("screened_at,candidates,universe,base_breakout_diagnostics")
    .eq("user_id", userId)
    .eq("kind", "base_breakout")
    .order("screened_at", { ascending: false })
    .limit(MAX_RUNS);
  if (res.error) {
    return NextResponse.json({ error: res.error.message }, { status: 500 });
  }
  const runs: RunRow[] = (
    (res.data ?? []) as Array<{
      screened_at: string;
      candidates: unknown;
      universe: unknown;
      base_breakout_diagnostics: unknown;
    }>
  ).map((row) => ({
    screenedAt: row.screened_at,
    candidates: Array.isArray(row.candidates) ? (row.candidates as SwingCandidate[]) : [],
    universe: row.universe ?? null,
    baseBreakoutDiagnostics: row.base_breakout_diagnostics ?? null,
  }));
  return NextResponse.json({ runs });
}

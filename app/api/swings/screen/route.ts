import { NextResponse } from "next/server";
import type { ScreenerResult } from "@/lib/swing-screener";
import { createServerClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";
// GET-only: returns the cached most-recent screen result. The actual
// scan now runs through the split pair /pass1 + /pass2 and persists via
// /save, so this route stays well under the default 60s ceiling.

type Cached = ScreenerResult & { screenedAt: string | null };

const EMPTY_CACHED: Cached = {
  candidates: [],
  screened: 0,
  pass1Survivors: 0,
  pass2Results: 0,
  durationMs: 0,
  errors: [],
  screenedAt: null,
};

export async function GET(): Promise<NextResponse> {
  const sb = createServerClient();
  const res = await sb
    .from("swing_screen_results")
    .select("*")
    .order("screened_at", { ascending: false })
    .limit(1);
  if (res.error) {
    return NextResponse.json({ error: res.error.message }, { status: 500 });
  }
  const row = (res.data ?? [])[0] as
    | {
        screened_at: string;
        screened: number | null;
        pass1_survivors: number | null;
        pass2_results: number | null;
        duration_ms: number | null;
        candidates: unknown;
      }
    | undefined;
  if (!row) {
    return NextResponse.json(EMPTY_CACHED);
  }
  return NextResponse.json({
    candidates: Array.isArray(row.candidates) ? row.candidates : [],
    screened: row.screened ?? 0,
    pass1Survivors: row.pass1_survivors ?? 0,
    pass2Results: row.pass2_results ?? 0,
    durationMs: row.duration_ms ?? 0,
    errors: [],
    screenedAt: row.screened_at,
  } satisfies Cached);
}

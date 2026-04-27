import { NextResponse } from "next/server";
import { runSwingScreener, type ScreenerResult } from "@/lib/swing-screener";
import { SWING_UNIVERSE } from "@/lib/stock-universe";
import { createServerClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";
// Full S&P 500 + Nasdaq 100 (~580 symbols) takes 3-5 minutes end-to-end.
// 300s is the Vercel Pro plan ceiling.
export const maxDuration = 300;

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

export async function POST(): Promise<NextResponse> {
  const result = await runSwingScreener(SWING_UNIVERSE);

  // Keep only the most recent run — the page only ever displays the
  // latest, and JSONB rows for ~50 candidates are large enough that
  // history stacking would balloon the table.
  const sb = createServerClient();
  const del = await sb
    .from("swing_screen_results")
    .delete()
    .neq("id", "00000000-0000-0000-0000-000000000000");
  if (del.error) {
    console.warn(`[swings/screen] truncate failed: ${del.error.message}`);
  }
  const ins = await sb.from("swing_screen_results").insert({
    screened: result.screened,
    pass1_survivors: result.pass1Survivors,
    pass2_results: result.pass2Results,
    duration_ms: result.durationMs,
    candidates: result.candidates,
  });
  if (ins.error) {
    console.warn(`[swings/screen] insert failed: ${ins.error.message}`);
  }

  return NextResponse.json({
    ...result,
    screenedAt: new Date().toISOString(),
  } satisfies Cached);
}

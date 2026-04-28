import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// Latest CSP-screener result row. Returned shape matches what the
// /api/screener/screen response would have produced for the same
// run, so screener-view can hydrate state in one shot.
//
// Returns { screenedAt: null } when the table is empty (no scan
// has ever been saved on this Supabase project).

type Row = {
  screened_at: string | null;
  vix: number | string | null;
  pass1_count: number | null;
  pass2_count: number | null;
  candidates: unknown;
  prices: unknown;
};

function toNum(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim().length > 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export async function GET() {
  const sb = createServerClient();
  const r = await sb
    .from("screener_results")
    .select("*")
    .order("screened_at", { ascending: false })
    .limit(1);
  if (r.error) {
    console.error(
      `[screener] /latest FAILED: ${r.error.message} (likely migration 010_screener_results.sql not applied)`,
    );
    return NextResponse.json({ error: r.error.message }, { status: 500 });
  }
  const row = ((r.data ?? []) as Row[])[0];
  if (!row) {
    console.log(`[screener] /latest hit empty table — no saved results yet`);
    return NextResponse.json({
      screenedAt: null,
      candidates: [],
      prices: {},
      vix: null,
      pass1Count: null,
      pass2Count: null,
    });
  }
  console.log(
    `[screener] loading cached results from: ${row.screened_at} (${Array.isArray(row.candidates) ? (row.candidates as unknown[]).length : 0} candidates)`,
  );
  return NextResponse.json({
    screenedAt: row.screened_at,
    candidates: Array.isArray(row.candidates) ? row.candidates : [],
    prices:
      row.prices && typeof row.prices === "object" && !Array.isArray(row.prices)
        ? (row.prices as Record<string, number>)
        : {},
    vix: toNum(row.vix),
    pass1Count: row.pass1_count,
    pass2Count: row.pass2_count,
  });
}

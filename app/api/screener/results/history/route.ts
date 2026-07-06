import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { requireUserId, authErrorResponse } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// Screener run history (append-only since 2026-07-06). Returns run
// metadata plus a per-candidate slim view (symbol + whatever grade
// field the run carried) so grade drift and repeat-candidate patterns
// are queryable without shipping the full candidates payloads.
//
// ?limit=N (default 30, max 100)

type Row = {
  id: string;
  screened_at: string | null;
  vix: number | string | null;
  pass1_count: number | null;
  pass2_count: number | null;
  graded: boolean | null;
  candidates: unknown;
};

function slimCandidate(c: unknown): { symbol: string; grade: string | null } | null {
  if (!c || typeof c !== "object") return null;
  const rec = c as Record<string, unknown>;
  const symbol =
    typeof rec.symbol === "string"
      ? rec.symbol
      : typeof rec.ticker === "string"
        ? rec.ticker
        : null;
  if (!symbol) return null;
  const grade =
    typeof rec.finalGrade === "string"
      ? rec.finalGrade
      : typeof rec.final_grade === "string"
        ? rec.final_grade
        : typeof rec.grade === "string"
          ? rec.grade
          : null;
  return { symbol: symbol.toUpperCase(), grade };
}

export async function GET(req: NextRequest) {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch (e) {
    return authErrorResponse(e);
  }
  const limitRaw = Number(req.nextUrl.searchParams.get("limit") ?? 30);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(1, limitRaw), 100) : 30;

  const sb = createServerClient();
  const r = await sb
    .from("screener_results")
    .select("id,screened_at,vix,pass1_count,pass2_count,graded,candidates")
    .eq("user_id", userId)
    .order("screened_at", { ascending: false })
    .limit(limit);
  if (r.error) {
    return NextResponse.json({ error: r.error.message }, { status: 500 });
  }
  const runs = ((r.data ?? []) as Row[]).map((row) => {
    const cands = Array.isArray(row.candidates) ? row.candidates : [];
    return {
      id: row.id,
      screenedAt: row.screened_at,
      vix: typeof row.vix === "string" ? Number(row.vix) : row.vix,
      pass1Count: row.pass1_count,
      pass2Count: row.pass2_count,
      graded: row.graded === true,
      candidateCount: cands.length,
      candidates: cands.map(slimCandidate).filter(Boolean),
    };
  });
  return NextResponse.json({ runs });
}

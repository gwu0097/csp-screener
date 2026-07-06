import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { requireUserId, authErrorResponse } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// Screener run history (append-only since 2026-07-06).
//
// List mode (default): run metadata plus a per-candidate slim view
// (symbol + grade) so grade drift and repeat-candidate patterns are
// queryable without shipping the full candidates payloads.
//   ?limit=N (default 30, max 100)
//
// Detail mode: ?id=<runId> returns ONE run with compact per-candidate
// rows (symbol, grade, price, EM%, crush, strike, premium, yield,
// recommendation) extracted server-side from the stored ScreenerResult
// objects — feeds the History page's right panel.

type Row = {
  id: string;
  screened_at: string | null;
  vix: number | string | null;
  pass1_count: number | null;
  pass2_count: number | null;
  graded: boolean | null;
  candidates: unknown;
};

function candidateGrade(rec: Record<string, unknown>): string | null {
  // Saved candidates are full ScreenerResult objects — the analyzed
  // grade lives at threeLayer.finalGrade; the crush grade at
  // stageThree.crushGrade is the pre-analysis fallback. The flat keys
  // cover any legacy/simplified payloads.
  const threeLayer = rec.threeLayer as Record<string, unknown> | null | undefined;
  if (threeLayer && typeof threeLayer.finalGrade === "string") return threeLayer.finalGrade;
  if (typeof rec.finalGrade === "string") return rec.finalGrade;
  if (typeof rec.final_grade === "string") return rec.final_grade;
  if (typeof rec.grade === "string") return rec.grade;
  const stageThree = rec.stageThree as Record<string, unknown> | null | undefined;
  if (stageThree && typeof stageThree.crushGrade === "string") return stageThree.crushGrade;
  return null;
}

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
  return { symbol: symbol.toUpperCase(), grade: candidateGrade(rec) };
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function detailCandidate(c: unknown): Record<string, unknown> | null {
  if (!c || typeof c !== "object") return null;
  const rec = c as Record<string, unknown>;
  const symbol =
    typeof rec.symbol === "string"
      ? rec.symbol
      : typeof rec.ticker === "string"
        ? rec.ticker
        : null;
  if (!symbol) return null;
  const stageThree = (rec.stageThree ?? null) as Record<string, unknown> | null;
  const stageThreeDetails = (stageThree?.details ?? null) as Record<string, unknown> | null;
  const stageFour = (rec.stageFour ?? null) as Record<string, unknown> | null;
  return {
    symbol: symbol.toUpperCase(),
    grade: candidateGrade(rec),
    price: num(rec.price),
    em_pct: num(stageThreeDetails?.expectedMovePct),
    crush: typeof stageThree?.crushGrade === "string" ? stageThree.crushGrade : null,
    strike: num(stageFour?.suggestedStrike),
    premium: num(stageFour?.premium),
    yield_pct: num(stageFour?.premiumYieldPct),
    recommendation: typeof rec.recommendation === "string" ? rec.recommendation : null,
  };
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

  // Detail mode: one run, full compact candidate rows.
  const runId = req.nextUrl.searchParams.get("id");
  if (runId) {
    const r = await sb
      .from("screener_results")
      .select("id,screened_at,vix,pass1_count,pass2_count,graded,candidates")
      .eq("user_id", userId)
      .eq("id", runId)
      .limit(1);
    if (r.error) {
      return NextResponse.json({ error: r.error.message }, { status: 500 });
    }
    const row = ((r.data ?? []) as Row[])[0];
    if (!row) {
      return NextResponse.json({ error: "Run not found" }, { status: 404 });
    }
    const cands = Array.isArray(row.candidates) ? row.candidates : [];
    return NextResponse.json({
      run: {
        id: row.id,
        screenedAt: row.screened_at,
        vix: typeof row.vix === "string" ? Number(row.vix) : row.vix,
        pass1Count: row.pass1_count,
        pass2Count: row.pass2_count,
        graded: row.graded === true,
        candidates: cands.map(detailCandidate).filter(Boolean),
      },
    });
  }
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

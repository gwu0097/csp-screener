import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { requireUserId, authErrorResponse } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// Persist CSP-screener results so a scan on one device shows up on
// another. APPEND-ONLY as of 2026-07-06: every run is a new row so the
// history (grade drift, repeat candidates, screener→trade conversion)
// is preserved — /latest orders by screened_at desc so "load previous"
// behaves exactly as before. Retention: the newest KEEP_RUNS rows per
// user are kept; older ones are pruned on save.

type Body = {
  candidates?: unknown;
  screenedAt?: unknown;
  prices?: unknown;
  vix?: unknown;
  pass1Count?: unknown;
  pass2Count?: unknown;
  // Whether the candidates carry Stage-3/4 analysis grades. Screen
  // Today writes graded=false; Run Analysis (and single-symbol
  // re-analyze) write graded=true. Drives the cross-device
  // hydration banner copy.
  graded?: unknown;
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

export async function POST(req: NextRequest) {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch (e) {
    return authErrorResponse(e);
  }
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!Array.isArray(body.candidates)) {
    return NextResponse.json(
      { error: "candidates array required" },
      { status: 400 },
    );
  }
  const screenedAt =
    typeof body.screenedAt === "string" && body.screenedAt.length > 0
      ? body.screenedAt
      : new Date().toISOString();
  const prices = isRecord(body.prices) ? body.prices : null;
  const vix = typeof body.vix === "number" ? body.vix : null;
  const pass1Count = typeof body.pass1Count === "number" ? body.pass1Count : null;
  const pass2Count = typeof body.pass2Count === "number" ? body.pass2Count : null;
  const graded = body.graded === true;

  const KEEP_RUNS = 100;

  const sb = createServerClient();
  // Run Analysis re-saves the same run with graded=true a few minutes
  // after Screen Today saved it graded=false. Treat an identical
  // screenedAt as an update of that run, not a new history entry.
  const existing = await sb
    .from("screener_results")
    .select("id")
    .eq("user_id", userId)
    .eq("screened_at", screenedAt)
    .limit(1);
  const existingId = ((existing.data ?? []) as Array<{ id: string }>)[0]?.id ?? null;

  const rowPayload = {
    user_id: userId,
    screened_at: screenedAt,
    vix,
    pass1_count: pass1Count,
    pass2_count: pass2Count,
    candidates: body.candidates,
    prices,
    graded,
  };
  const write = existingId
    ? await sb.from("screener_results").update(rowPayload).eq("id", existingId).eq("user_id", userId)
    : await sb.from("screener_results").insert(rowPayload);
  if (write.error) {
    console.error(
      `[screener] save FAILED: ${write.error.message} (likely migration 010_screener_results.sql not applied)`,
    );
    return NextResponse.json({ error: write.error.message }, { status: 500 });
  }

  // Retention: prune everything past the newest KEEP_RUNS rows.
  const idsRes = await sb
    .from("screener_results")
    .select("id,screened_at")
    .eq("user_id", userId)
    .order("screened_at", { ascending: false })
    .limit(KEEP_RUNS + 50);
  const ids = ((idsRes.data ?? []) as Array<{ id: string }>).map((r) => r.id);
  if (!idsRes.error && ids.length > KEEP_RUNS) {
    const prune = await sb
      .from("screener_results")
      .delete()
      .eq("user_id", userId)
      .in("id", ids.slice(KEEP_RUNS));
    if (prune.error) {
      console.warn(`[screener/results/save] prune failed: ${prune.error.message}`);
    }
  }

  console.log(
    `[screener] saved results to DB: count=${(body.candidates as unknown[]).length} graded=${graded} screenedAt=${screenedAt} mode=${existingId ? "update" : "append"}`,
  );
  return NextResponse.json({ ok: true, screenedAt, graded });
}

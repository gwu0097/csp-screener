import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// Persist the latest CSP-screener results so a scan on one device
// shows up on another. Truncate-and-replace — table only ever holds
// the most-recent run. Mirrors the swing screener's
// /api/swings/screen/save pattern.

type Body = {
  candidates?: unknown;
  screenedAt?: unknown;
  prices?: unknown;
  vix?: unknown;
  pass1Count?: unknown;
  pass2Count?: unknown;
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

export async function POST(req: NextRequest) {
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

  const sb = createServerClient();
  const del = await sb
    .from("screener_results")
    .delete()
    .neq("id", "00000000-0000-0000-0000-000000000000");
  if (del.error) {
    console.warn(`[screener/results/save] truncate failed: ${del.error.message}`);
  }
  const ins = await sb.from("screener_results").insert({
    screened_at: screenedAt,
    vix,
    pass1_count: pass1Count,
    pass2_count: pass2Count,
    candidates: body.candidates,
    prices,
  });
  if (ins.error) {
    return NextResponse.json({ error: ins.error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true, screenedAt });
}

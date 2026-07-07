import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { requireUserId, authErrorResponse } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// POST /api/positions/[id]/classify  { trade_type }
//
// User confirmation/override of an auto-detected trade type. Applies to
// the WHOLE chain (classification is a campaign-level fact) and marks
// it source='user' so retroactive re-runs and import-time detection
// never clobber the manual verdict.

const VALID_TYPES = new Set(["clean", "rolled", "recovery_play"]);

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch (e) {
    return authErrorResponse(e);
  }
  let body: { trade_type?: unknown };
  try {
    body = (await req.json()) as { trade_type?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const tradeType = typeof body.trade_type === "string" ? body.trade_type : "";
  if (!VALID_TYPES.has(tradeType)) {
    return NextResponse.json(
      { error: "trade_type must be clean | rolled | recovery_play" },
      { status: 400 },
    );
  }

  const sb = createServerClient();
  const posRes = await sb
    .from("positions")
    .select("id,trade_chain_id")
    .eq("id", params.id)
    .eq("user_id", userId)
    .limit(1);
  if (posRes.error) {
    return NextResponse.json({ error: posRes.error.message }, { status: 500 });
  }
  const pos = ((posRes.data ?? []) as Array<{ id: string; trade_chain_id: string | null }>)[0];
  if (!pos) {
    return NextResponse.json({ error: "Position not found" }, { status: 404 });
  }

  const patch = { trade_type: tradeType, trade_type_source: "user" };
  const upd = pos.trade_chain_id
    ? await sb
        .from("positions")
        .update(patch)
        .eq("trade_chain_id", pos.trade_chain_id)
        .eq("user_id", userId)
    : await sb.from("positions").update(patch).eq("id", pos.id).eq("user_id", userId);
  if (upd.error) {
    return NextResponse.json({ error: upd.error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true, trade_type: tradeType, scope: pos.trade_chain_id ? "chain" : "position" });
}

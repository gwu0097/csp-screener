import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { requireUserId, authErrorResponse } from "@/lib/auth";

export const dynamic = "force-dynamic";

type PatchBody = { reviewed?: unknown };

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch (e) {
    return authErrorResponse(e);
  }
  const id = (params.id ?? "").trim();
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

  let body: PatchBody;
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (typeof body.reviewed !== "boolean") {
    return NextResponse.json({ error: "reviewed must be a boolean" }, { status: 400 });
  }

  const sb = createServerClient();
  const res = await sb
    .from("swing_trade_orphan_sells")
    .update({ reviewed: body.reviewed })
    .eq("id", id)
    .eq("user_id", userId)
    .select()
    .single();
  if (res.error) return NextResponse.json({ error: res.error.message }, { status: 400 });
  return NextResponse.json({ orphan_sell: res.data });
}

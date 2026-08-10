import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { requireUserId, authErrorResponse } from "@/lib/auth";

export const dynamic = "force-dynamic";

type MemberRow = {
  id: string;
  theme_id: string;
  symbol: string;
  is_anchor: boolean;
  is_active: boolean;
  notes: string | null;
};

type PatchBody = {
  is_anchor?: unknown;
  is_active?: unknown;
  notes?: unknown;
};

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string; memberId: string } },
) {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch (e) {
    return authErrorResponse(e);
  }
  const themeId = (params.id ?? "").trim();
  const memberId = (params.memberId ?? "").trim();
  if (!themeId || !memberId) {
    return NextResponse.json({ error: "Missing id" }, { status: 400 });
  }

  let body: PatchBody;
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const patch: Record<string, unknown> = {};
  if (typeof body.is_anchor === "boolean") patch.is_anchor = body.is_anchor;
  if (typeof body.is_active === "boolean") patch.is_active = body.is_active;
  if (body.notes !== undefined) {
    patch.notes = typeof body.notes === "string" ? body.notes.trim() || null : null;
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "No recognized fields to update" }, { status: 400 });
  }

  const sb = createServerClient();
  const res = await sb
    .from<MemberRow>("theme_members")
    .update(patch)
    .eq("id", memberId)
    .eq("theme_id", themeId)
    .eq("user_id", userId)
    .select()
    .single();
  if (res.error) {
    return NextResponse.json({ error: res.error.message }, { status: 400 });
  }
  return NextResponse.json({ member: res.data });
}

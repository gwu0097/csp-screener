import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { requireUserId, authErrorResponse } from "@/lib/auth";

export const dynamic = "force-dynamic";

// Hard delete only -- see the migration's comment: a subquery carries no
// rejection-scope history to preserve (rejections stay scoped at the
// theme level), so there's no soft-delete/is_active concept to maintain
// here, unlike theme_type or expansion_prompt. Existing pending rows
// already tagged with this subquery's NAME (theme_members.
// expansion_subquery) are untouched -- the tag is a frozen label, not a
// live reference to this row.
export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string; subqueryId: string } },
) {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch (e) {
    return authErrorResponse(e);
  }
  const themeId = (params.id ?? "").trim();
  const subqueryId = (params.subqueryId ?? "").trim();
  if (!themeId || !subqueryId) return NextResponse.json({ error: "Missing id" }, { status: 400 });

  const sb = createServerClient();
  const existing = await sb
    .from("theme_subqueries")
    .select("id")
    .eq("id", subqueryId)
    .eq("theme_id", themeId)
    .eq("user_id", userId)
    .maybeSingle();
  if (existing.error) return NextResponse.json({ error: existing.error.message }, { status: 500 });
  if (!existing.data) return NextResponse.json({ error: "Sub-query not found" }, { status: 404 });

  const del = await sb
    .from("theme_subqueries")
    .delete()
    .eq("id", subqueryId)
    .eq("theme_id", themeId)
    .eq("user_id", userId);
  if (del.error) return NextResponse.json({ error: del.error.message }, { status: 400 });
  return NextResponse.json({ ok: true });
}

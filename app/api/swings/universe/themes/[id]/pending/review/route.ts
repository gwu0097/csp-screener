import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { requireUserId, authErrorResponse } from "@/lib/auth";
import { acceptPendingMembers, rejectPendingMembers } from "@/lib/theme-expansion";

export const dynamic = "force-dynamic";
// Universe & Themes, Phase C — accept/reject for pending (Perplexity-
// suggested, review_status='pending') theme_members rows. Both actions
// are scoped to review_status='pending' at the query level inside
// lib/theme-expansion.ts — this route can never touch an already-
// approved member, including a manually-added one, even given a stray
// id in a bulk call.

type Body = {
  action?: unknown;
  memberIds?: unknown; // accept
  items?: unknown; // reject — [{ memberId, reason? }]
};

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
  const themeId = (params.id ?? "").trim();
  if (!themeId) return NextResponse.json({ error: "Missing id" }, { status: 400 });

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const sb = createServerClient();
  const themeRes = await sb
    .from("themes")
    .select("id")
    .eq("id", themeId)
    .eq("user_id", userId)
    .maybeSingle();
  if (themeRes.error) return NextResponse.json({ error: themeRes.error.message }, { status: 500 });
  if (!themeRes.data) return NextResponse.json({ error: "Theme not found" }, { status: 404 });

  if (body.action === "accept") {
    const ids = Array.isArray(body.memberIds)
      ? body.memberIds.filter((x): x is string => typeof x === "string" && x.trim().length > 0)
      : [];
    if (ids.length === 0) return NextResponse.json({ error: "Missing memberIds" }, { status: 400 });
    const outcomes = await acceptPendingMembers(userId, themeId, ids);
    return NextResponse.json({ outcomes });
  }

  if (body.action === "reject") {
    const items = Array.isArray(body.items)
      ? body.items
          .filter((x): x is { memberId: unknown; reason?: unknown } => !!x && typeof x === "object")
          .map((x) => ({
            memberId: typeof x.memberId === "string" ? x.memberId : "",
            reason: typeof x.reason === "string" ? x.reason : null,
          }))
          .filter((x) => x.memberId.length > 0)
      : [];
    if (items.length === 0) return NextResponse.json({ error: "Missing items" }, { status: 400 });
    const outcomes = await rejectPendingMembers(userId, themeId, items);
    return NextResponse.json({ outcomes });
  }

  return NextResponse.json({ error: "action must be 'accept' or 'reject'" }, { status: 400 });
}

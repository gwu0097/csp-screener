import { NextRequest, NextResponse } from "next/server";
import { requireUserId, authErrorResponse } from "@/lib/auth";
import { undoRejection } from "@/lib/theme-expansion";

export const dynamic = "force-dynamic";
// Universe & Themes — explicit, permanent undo of one theme_rejections
// row (see lib/theme-expansion.ts undoRejection). The only way a
// rejection row is ever removed; expansion runs never delete one on
// their own, even when its scope no longer matches the theme's current
// question — a non-matching row is simply not applied, not deleted.

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string; rejectionId: string } },
) {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch (e) {
    return authErrorResponse(e);
  }
  const themeId = (params.id ?? "").trim();
  const rejectionId = (params.rejectionId ?? "").trim();
  if (!themeId || !rejectionId) {
    return NextResponse.json({ error: "Missing id" }, { status: 400 });
  }

  const outcome = await undoRejection(userId, themeId, rejectionId);
  if (!outcome.ok) {
    return NextResponse.json({ error: outcome.error ?? "Undo failed" }, { status: 400 });
  }
  return NextResponse.json({ ok: true, symbol: outcome.symbol });
}

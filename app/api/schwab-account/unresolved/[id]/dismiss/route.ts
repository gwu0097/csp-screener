import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { requireAdmin, authErrorResponse } from "@/lib/auth";

export const dynamic = "force-dynamic";

// POST /api/schwab-account/unresolved/[id]/dismiss
//
// Marks one schwab_account_transactions row as dismissed so it drops
// out of /api/schwab-account/unresolved for good. Used both for an
// explicit "Dismiss" click and, internally, right after a successful
// manual "Import" of the same activity — either way the row is
// processed=true already, so the poller (which only re-touches
// processed=false rows) never looks at it again.
type Body = { reason?: unknown };

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireAdmin();
  } catch (e) {
    return authErrorResponse(e);
  }
  const { id } = await params;
  if (!id) {
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }
  let reason = "user_dismissed";
  try {
    const body = (await req.json()) as Body;
    if (typeof body.reason === "string" && body.reason) reason = body.reason;
  } catch {
    // no body — default reason
  }

  const sb = createServerClient();
  const res = await sb
    .from("schwab_account_transactions")
    .update({ dismissed: true, dismissed_reason: reason })
    .eq("id", id);
  if (res.error) {
    return NextResponse.json({ error: res.error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}

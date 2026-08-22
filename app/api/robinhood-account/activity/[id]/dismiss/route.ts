import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { requireAdmin, authErrorResponse } from "@/lib/auth";

export const dynamic = "force-dynamic";

// POST /api/robinhood-account/activity/[id]/dismiss
//
// Marks one robinhood_account_transactions row as dismissed so it
// drops out of /api/robinhood-account/activity for good — identical
// contract to app/api/schwab-account/activity/[id]/dismiss/route.ts.
// Used both for an explicit "Dismiss" click and, internally, right
// after a successful manual "Import" of the same execution.
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
    .from("robinhood_account_transactions")
    .update({ dismissed: true, dismissed_reason: reason })
    .eq("id", id);
  if (res.error) {
    return NextResponse.json({ error: res.error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}

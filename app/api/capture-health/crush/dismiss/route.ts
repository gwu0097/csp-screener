import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { requireAdmin, authErrorResponse } from "@/lib/auth";

export const dynamic = "force-dynamic";

// POST /api/capture-health/crush/dismiss
//
// Marks one or more earnings_history rows' permanent T1 failure as
// reviewed, so they drop out of the "Aged out permanently" list (and
// stop counting toward the T0/T1 panel's degraded state) for good.
// These rows are t1_unrecoverable=true — by definition nothing will
// ever retry them — so dismiss just means "a human looked at the
// reason and there's nothing to do." Body: {ids: string[]}. The
// wrapper has no .in(), so this loops per-id like the Schwab activity
// panel's "Dismiss all" does.
type Body = { ids?: unknown };

export async function POST(req: NextRequest) {
  try {
    await requireAdmin();
  } catch (e) {
    return authErrorResponse(e);
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const ids = Array.isArray(body.ids) ? body.ids.filter((x): x is string => typeof x === "string") : [];
  if (ids.length === 0) {
    return NextResponse.json({ error: "ids required" }, { status: 400 });
  }

  const sb = createServerClient();
  const now = new Date().toISOString();
  const results = await Promise.all(
    ids.map((id) =>
      sb
        .from("earnings_history")
        .update({ t1_unrecoverable_dismissed: true, t1_unrecoverable_dismissed_at: now })
        .eq("id", id)
        .eq("t1_unrecoverable", true),
    ),
  );
  const failed = results.filter((r) => r.error);
  if (failed.length > 0) {
    return NextResponse.json({ error: failed[0].error!.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true, dismissed: ids.length });
}

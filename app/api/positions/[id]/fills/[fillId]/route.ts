import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { recalculatePositionFromFills } from "@/lib/positions";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// Delete a single fill, then recompute the position aggregates.
export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string; fillId: string } },
) {
  const { id: positionId, fillId } = params;
  if (!positionId || !fillId) {
    return NextResponse.json({ error: "Missing id" }, { status: 400 });
  }
  const sb = createServerClient();
  // Scope the delete to the parent position so a stale URL can't
  // wipe a fill belonging to someone else's position.
  const del = await sb
    .from("fills")
    .delete()
    .eq("id", fillId)
    .eq("position_id", positionId);
  if (del.error) {
    return NextResponse.json(
      { error: `fill delete failed — ${del.error.message}` },
      { status: 500 },
    );
  }
  const recalc = await recalculatePositionFromFills(positionId, sb);
  if (!recalc.ok) {
    return NextResponse.json({ error: recalc.error }, { status: 500 });
  }
  return NextResponse.json({ ok: true, status: recalc.status });
}

// Update the contract count on an existing fill. Used by the inline
// qty edit in the position-card edit panel. Premium / fill_type /
// fill_date stay frozen — re-issue a delete+add to change those.
type PatchBody = { contracts?: unknown };

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string; fillId: string } },
) {
  const { id: positionId, fillId } = params;
  if (!positionId || !fillId) {
    return NextResponse.json({ error: "Missing id" }, { status: 400 });
  }
  let body: PatchBody;
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const contracts = Number(body.contracts);
  if (!Number.isFinite(contracts) || contracts <= 0) {
    return NextResponse.json({ error: "contracts must be > 0" }, { status: 400 });
  }
  const sb = createServerClient();
  const upd = await sb
    .from("fills")
    .update({ contracts })
    .eq("id", fillId)
    .eq("position_id", positionId);
  if (upd.error) {
    return NextResponse.json(
      { error: `fill update failed — ${upd.error.message}` },
      { status: 500 },
    );
  }
  const recalc = await recalculatePositionFromFills(positionId, sb);
  if (!recalc.ok) {
    return NextResponse.json({ error: recalc.error }, { status: 500 });
  }
  return NextResponse.json({ ok: true, status: recalc.status });
}

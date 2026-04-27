import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// Hard-delete a single position by id. Used by the position card's
// inline Remove control to clean up bad imports (broker screenshots
// that produced wrong strikes, accidental duplicate entries).
//
// fills / position_snapshots / post_earnings_recommendations all
// reference positions.id; we don't know whether the schema has
// ON DELETE CASCADE wired, so we clear the children explicitly. None
// of those child writes is fatal — if a delete fails we still
// attempt the parent and surface the first error.
export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  const id = params.id;
  if (!id || typeof id !== "string") {
    return NextResponse.json(
      { success: false, error: "id required" },
      { status: 400 },
    );
  }

  const sb = createServerClient();

  // Existence check — return 404 instead of silently no-op'ing so the
  // client can distinguish "stale list" from "delete actually ran".
  const exists = await sb
    .from("positions")
    .select("id")
    .eq("id", id)
    .limit(1);
  if (exists.error) {
    return NextResponse.json(
      { success: false, error: exists.error.message },
      { status: 500 },
    );
  }
  if (!exists.data || (exists.data as Array<unknown>).length === 0) {
    return NextResponse.json(
      { success: false, error: "position not found" },
      { status: 404 },
    );
  }

  for (const table of [
    "fills",
    "position_snapshots",
    "post_earnings_recommendations",
  ]) {
    const r = await sb.from(table).delete().eq("position_id", id);
    if (r.error) {
      console.warn(
        `[positions/delete] child cleanup ${table} for ${id} failed: ${r.error.message}`,
      );
    }
  }

  const del = await sb.from("positions").delete().eq("id", id);
  if (del.error) {
    return NextResponse.json(
      { success: false, error: del.error.message },
      { status: 500 },
    );
  }
  return NextResponse.json({ success: true, id });
}

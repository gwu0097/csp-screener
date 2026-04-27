import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// Hard-delete a single position. Used by the position card's Remove
// button to clean up bad imports (broker screenshots that produced a
// wrong strike, accidental duplicate entry, etc.).
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
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }

  const sb = createServerClient();

  for (const table of [
    "fills",
    "position_snapshots",
    "post_earnings_recommendations",
  ]) {
    const r = await sb.from(table).delete().eq("position_id", id);
    if (r.error) {
      // Log and continue — child-table failures shouldn't block the
      // primary delete in case the table doesn't exist or RLS rejects.
      console.warn(
        `[positions/delete] child cleanup ${table} for ${id} failed: ${r.error.message}`,
      );
    }
  }

  const del = await sb.from("positions").delete().eq("id", id);
  if (del.error) {
    return NextResponse.json({ error: del.error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true, id });
}

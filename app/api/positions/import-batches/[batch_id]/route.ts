import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// DELETE /api/positions/import-batches/[batch_id]
//
// Undoes a bulk-create import. Deletes every fill stamped with the
// batch_id, then every position stamped with the batch_id. Snapshots
// tied to those positions go too — they reference position_id, so we
// remove them first to avoid an FK error.
//
// Safety gate (mirrors the GET endpoint's eligibility check):
//   1. All positions in the batch must still be status='open'.
//   2. None can have non-zero realized_pnl.
//   3. No fill in the batch can be fill_type='close' attached to a
//      position outside the batch — that would leave that pre-
//      existing position with stale aggregates.
// Failing any of these returns 409 Conflict with a reason; nothing
// is deleted.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { batch_id: string } },
) {
  const batchId = (params.batch_id ?? "").trim();
  if (!UUID_RE.test(batchId)) {
    return NextResponse.json({ error: "Invalid batch_id" }, { status: 400 });
  }
  const sb = createServerClient();

  // 1. Positions in the batch.
  const pr = await sb
    .from("positions")
    .select("id,symbol,status,realized_pnl")
    .eq("import_batch_id", batchId);
  if (pr.error) {
    return NextResponse.json({ error: pr.error.message }, { status: 500 });
  }
  const positions = (pr.data ?? []) as Array<{
    id: string;
    symbol: string;
    status: string;
    realized_pnl: number | null;
  }>;
  if (positions.length === 0) {
    return NextResponse.json(
      { error: "No positions found for this batch" },
      { status: 404 },
    );
  }

  // 2. Safety: every position must be open with zero realized P&L.
  const dirty = positions.find(
    (p) =>
      p.status !== "open" ||
      (p.realized_pnl !== null && Math.abs(Number(p.realized_pnl)) > 0.0001),
  );
  if (dirty) {
    return NextResponse.json(
      {
        error:
          "Undo blocked: at least one position in this batch is no longer open or has realized P&L (corruption-of-history guard).",
        offending_position_id: dirty.id,
        offending_symbol: dirty.symbol,
      },
      { status: 409 },
    );
  }

  // 3. Safety: no close-fill in the batch (those'd attach to
  //    positions outside the batch and removal would leave them
  //    with stale aggregates).
  const fr = await sb
    .from("fills")
    .select("id,position_id,fill_type")
    .eq("import_batch_id", batchId);
  if (fr.error) {
    return NextResponse.json({ error: fr.error.message }, { status: 500 });
  }
  const fills = (fr.data ?? []) as Array<{
    id: string;
    position_id: string;
    fill_type: string;
  }>;
  const closeFill = fills.find((f) => f.fill_type === "close");
  if (closeFill) {
    return NextResponse.json(
      {
        error:
          "Undo blocked: batch contains close fills. Closes can attach to pre-existing positions and undoing would corrupt their aggregates.",
      },
      { status: 409 },
    );
  }
  const positionIds = positions.map((p) => p.id);

  // 4. Snapshot count (so the response can report it). Then cascade-
  //    delete in dependency order:
  //    snapshots (FK → positions)  →  fills (FK → positions)  →  positions
  const snapPre = await sb
    .from("position_snapshots")
    .select("id")
    .in("position_id", positionIds);
  const snapshotsCount = (snapPre.data ?? []).length;

  const sn = await sb
    .from("position_snapshots")
    .delete()
    .in("position_id", positionIds);
  if (sn.error) {
    return NextResponse.json({ error: sn.error.message }, { status: 500 });
  }
  const flDel = await sb
    .from("fills")
    .delete()
    .eq("import_batch_id", batchId);
  if (flDel.error) {
    return NextResponse.json({ error: flDel.error.message }, { status: 500 });
  }
  const ps = await sb
    .from("positions")
    .delete()
    .eq("import_batch_id", batchId);
  if (ps.error) {
    return NextResponse.json({ error: ps.error.message }, { status: 500 });
  }

  return NextResponse.json({
    batch_id: batchId,
    snapshots_deleted: snapshotsCount,
    fills_deleted: fills.length,
    positions_deleted: positions.length,
  });
}

import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { checkUndoEligibility, loadBatchEligibility } from "@/lib/undo-batch";
import { recalculatePositionFromFills } from "@/lib/positions";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// DELETE /api/positions/import-batches/[batch_id]
//
// Undoes a bulk-create import:
//   • Deletes snapshots for positions CREATED by this batch.
//   • Deletes every fill with import_batch_id = batch_id.
//   • Deletes every position with import_batch_id = batch_id.
//   • Recomputes aggregates on any pre-existing position that had a
//     fill from this batch removed (so it doesn't end up with stale
//     status / realized_pnl from a now-deleted close).
//
// Eligibility lives in lib/undo-batch.ts and is shared with the
// GET endpoint so the UI's "undoable" flag and this guard can never
// drift. A batch is undoable when:
//   • No fills exist on any touched position with a different
//     import_batch_id and created_at > the batch's earliest stamp.
//   • No touched position has status='expired_worthless' or
//     'assigned' (those imply auto-expire / assignment after the
//     batch).
// realized_pnl from this batch's OWN close fills and status='closed'
// from this batch's same-batch open+close are explicitly OK.

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

  // 1. Build eligibility context + check.
  const loaded = await loadBatchEligibility(batchId, sb);
  if (!loaded.ok) {
    return NextResponse.json(
      { error: loaded.error },
      { status: loaded.error.startsWith("No positions") ? 404 : 500 },
    );
  }
  const verdict = checkUndoEligibility(loaded.ctx);
  if (!verdict.undoable) {
    return NextResponse.json(
      {
        error: verdict.reason,
        offending_position_id: verdict.offendingPositionId,
        offending_symbol: verdict.offendingSymbol,
      },
      { status: 409 },
    );
  }

  const batchPositionIds = loaded.batchPositionIds;
  // Positions that the batch added fills to but didn't itself
  // create (pre-existing). These need an aggregate recompute after
  // the batch's fills are deleted.
  const batchCreatedSet = new Set(batchPositionIds);
  const externalPositionIds = loaded.batchFillPositionIds.filter(
    (id) => !batchCreatedSet.has(id),
  );

  // 2. Count snapshots up-front for the response. Then delete in FK
  //    dependency order: snapshots → fills → positions.
  let snapshotsCount = 0;
  if (batchPositionIds.length > 0) {
    const snapPre = await sb
      .from("position_snapshots")
      .select("id")
      .in("position_id", batchPositionIds);
    snapshotsCount = (snapPre.data ?? []).length;
    const sn = await sb
      .from("position_snapshots")
      .delete()
      .in("position_id", batchPositionIds);
    if (sn.error) {
      return NextResponse.json({ error: sn.error.message }, { status: 500 });
    }
  }

  // Count batch fills before delete so the response can report them.
  const fillsPre = await sb
    .from("fills")
    .select("id")
    .eq("import_batch_id", batchId);
  const fillsCount = (fillsPre.data ?? []).length;

  const flDel = await sb
    .from("fills")
    .delete()
    .eq("import_batch_id", batchId);
  if (flDel.error) {
    return NextResponse.json({ error: flDel.error.message }, { status: 500 });
  }

  // 3. Recompute aggregates on pre-existing positions that lost
  //    fills. recalculatePositionFromFills handles total_contracts,
  //    avg_premium_sold, status, closed_date, realized_pnl from the
  //    remaining fill set.
  const recomputeErrors: string[] = [];
  for (const positionId of externalPositionIds) {
    const r = await recalculatePositionFromFills(positionId, sb);
    if (!r.ok) {
      recomputeErrors.push(`${positionId}: ${r.error}`);
    }
  }

  // 4. Delete batch-created positions last (FK refs from fills /
  //    snapshots are already gone).
  let positionsDeletedCount = 0;
  if (batchPositionIds.length > 0) {
    const ps = await sb
      .from("positions")
      .delete()
      .eq("import_batch_id", batchId);
    if (ps.error) {
      return NextResponse.json({ error: ps.error.message }, { status: 500 });
    }
    positionsDeletedCount = batchPositionIds.length;
  }

  return NextResponse.json({
    batch_id: batchId,
    snapshots_deleted: snapshotsCount,
    fills_deleted: fillsCount,
    positions_deleted: positionsDeletedCount,
    positions_recomputed: externalPositionIds.length,
    recompute_errors: recomputeErrors.length > 0 ? recomputeErrors : undefined,
  });
}

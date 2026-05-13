import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// GET /api/positions/import-batches
// Returns the 5 most recent bulk-create batches that the Positions
// page's "Undo import" popover surfaces. A batch is identified by the
// import_batch_id stamped onto every position newly created in that
// bulk-create call (and every fill, which the undo route uses to
// cascade-delete cleanly). Pre-migration rows have a NULL batch_id
// and are invisible here.

export type ImportBatchPosition = {
  id: string;
  symbol: string;
  strike: number;
  expiry: string;
  qty: number;
  status: string;
  realizedPnl: number | null;
};

export type ImportBatchSummary = {
  batchId: string;
  importedAt: string;
  broker: string;
  positionCount: number;
  positions: ImportBatchPosition[];
  // Eligibility hint computed server-side. The undo button on a row
  // is disabled when this is false; the reason explains why.
  undoable: boolean;
  undoBlockedReason: string | null;
};

export async function GET() {
  const sb = createServerClient();
  // Fetch a window of recent stamped positions, then group in memory.
  // 200 rows is plenty to surface 5 batches even if a single batch
  // ran 30+ positions.
  // The project's Supabase wrapper doesn't expose `.not()`, so we
  // fetch the most recent rows and drop nulls in memory. 400 covers a
  // healthy backlog of pre-migration positions plus enough recent
  // batched ones to surface 5 distinct batches.
  const r = await sb
    .from("positions")
    .select(
      "id,symbol,strike,expiry,broker,total_contracts,status,realized_pnl,created_at,import_batch_id",
    )
    .order("created_at", { ascending: false })
    .limit(400);
  if (r.error) {
    return NextResponse.json({ error: r.error.message }, { status: 500 });
  }

  type Row = {
    id: string;
    symbol: string;
    strike: number;
    expiry: string;
    broker: string | null;
    total_contracts: number | null;
    status: string;
    realized_pnl: number | null;
    created_at: string;
    import_batch_id: string | null;
  };
  const rows = ((r.data ?? []) as Row[]).filter(
    (x): x is Row & { import_batch_id: string } => x.import_batch_id !== null,
  );

  // Group by batch, keeping the most recent created_at per group.
  const grouped = new Map<
    string,
    { latest: string; broker: string; positions: ImportBatchPosition[] }
  >();
  for (const row of rows) {
    const existing = grouped.get(row.import_batch_id);
    const pos: ImportBatchPosition = {
      id: row.id,
      symbol: row.symbol,
      strike: Number(row.strike),
      expiry: row.expiry,
      qty: Number(row.total_contracts ?? 0),
      status: row.status,
      realizedPnl:
        row.realized_pnl !== null ? Number(row.realized_pnl) : null,
    };
    if (!existing) {
      grouped.set(row.import_batch_id, {
        latest: row.created_at,
        broker: row.broker ?? "unknown",
        positions: [pos],
      });
    } else {
      existing.positions.push(pos);
      if (row.created_at > existing.latest) existing.latest = row.created_at;
    }
  }

  const sorted = Array.from(grouped.entries())
    .sort(([, a], [, b]) => b.latest.localeCompare(a.latest))
    .slice(0, 5);

  // ---- New undo-eligibility logic ----
  //
  // The old rules (any close fill OR any non-open status) were too
  // aggressive: a fresh import that opens AND closes a position in
  // the same batch (a roll, or a sell-shares from the stock side)
  // would lock immediately even though every change in the batch is
  // still fully reversible.
  //
  // The real question is: has anything happened to a touched
  // position SINCE this batch ran? Specifically:
  //   (a) A fill on a touched position with import_batch_id != this
  //       batch AND created_at > the batch's earliest timestamp →
  //       subsequent fill activity. Undo would leave that later
  //       fill attached to a non-existent position.
  //   (b) A position has status='expired_worthless' or 'assigned' →
  //       auto-expire or assignment ran after the batch (bulk-create
  //       never sets those statuses directly). Undo would leave the
  //       expire/assign side-effects (close fills, snapshots,
  //       stock_long rows from assignment) dangling.
  //
  // Anything else — including realized_pnl from this batch's own
  // close fills, or status='closed' from this batch's same-batch
  // open+close — is undoable.
  const batchIds = sorted.map(([id]) => id);
  type FillProbe = {
    position_id: string;
    import_batch_id: string | null;
    created_at: string;
  };
  // Touched positions: created by the batch + attached via fills.
  const fillsInBatches: FillProbe[] = [];
  if (batchIds.length > 0) {
    const fr = await sb
      .from("fills")
      .select("position_id,import_batch_id,created_at")
      .in("import_batch_id", batchIds);
    if (!fr.error) {
      fillsInBatches.push(...((fr.data ?? []) as FillProbe[]));
    }
  }
  const touchedByBatch = new Map<string, Set<string>>();
  const batchEarliest = new Map<string, string>();
  for (const [batchId, g] of sorted) {
    const touched = new Set<string>(g.positions.map((p) => p.id));
    let earliest = g.latest;
    // include earliest position created_at (currently g.latest is the
    // newest; recompute the earliest by re-scanning rows).
    for (const row of rows) {
      if (row.import_batch_id === batchId && row.created_at < earliest) {
        earliest = row.created_at;
      }
    }
    for (const f of fillsInBatches) {
      if (f.import_batch_id === batchId) {
        touched.add(f.position_id);
        if (f.created_at < earliest) earliest = f.created_at;
      }
    }
    touchedByBatch.set(batchId, touched);
    batchEarliest.set(batchId, earliest);
  }

  // Fetch every fill on every touched position (across all batches),
  // and the current status of those positions, in two batched calls.
  const allTouched = new Set<string>();
  Array.from(touchedByBatch.values()).forEach((set) => {
    set.forEach((id) => allTouched.add(id));
  });
  type FillSubRow = {
    position_id: string;
    import_batch_id: string | null;
    created_at: string;
  };
  const fillsByPosition = new Map<string, FillSubRow[]>();
  type PosStatusRow = { id: string; symbol: string; status: string };
  const statusById = new Map<string, PosStatusRow>();
  if (allTouched.size > 0) {
    const ids = Array.from(allTouched);
    const [fillsRes, posRes] = await Promise.all([
      sb
        .from("fills")
        .select("position_id,import_batch_id,created_at")
        .in("position_id", ids),
      sb.from("positions").select("id,symbol,status").in("id", ids),
    ]);
    if (!fillsRes.error) {
      for (const f of (fillsRes.data ?? []) as FillSubRow[]) {
        const arr = fillsByPosition.get(f.position_id) ?? [];
        arr.push(f);
        fillsByPosition.set(f.position_id, arr);
      }
    }
    if (!posRes.error) {
      for (const p of (posRes.data ?? []) as PosStatusRow[]) {
        statusById.set(p.id, p);
      }
    }
  }

  const batches: ImportBatchSummary[] = sorted.map(([id, g]) => {
    const touched = Array.from(touchedByBatch.get(id) ?? []);
    const earliest = batchEarliest.get(id) ?? g.latest;
    let undoBlockedReason: string | null = null;
    for (const positionId of touched) {
      const subsequentFills = (fillsByPosition.get(positionId) ?? []).filter(
        (f) => f.import_batch_id !== id && f.created_at > earliest,
      );
      const posInfo = statusById.get(positionId);
      const sym = posInfo?.symbol ?? "Position";
      if (subsequentFills.length > 0) {
        undoBlockedReason = `${sym} was modified after this import — undo would corrupt subsequent fills.`;
        break;
      }
      if (
        posInfo?.status === "expired_worthless" ||
        posInfo?.status === "assigned"
      ) {
        undoBlockedReason = `${sym} was ${posInfo.status === "assigned" ? "assigned" : "auto-expired"} after this import — undo would leave the ${posInfo.status === "assigned" ? "assignment" : "expire"} side-effects dangling.`;
        break;
      }
    }
    return {
      batchId: id,
      importedAt: g.latest,
      broker: g.broker,
      positionCount: g.positions.length,
      positions: g.positions,
      undoable: undoBlockedReason === null,
      undoBlockedReason,
    };
  });

  return NextResponse.json({ batches });
}

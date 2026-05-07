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

  // For each batch, also peek at the fills to determine eligibility
  // — we refuse to undo if any close fill is in the batch (it would
  // leave an existing position with stale aggregates).
  const batchIds = sorted.map(([id]) => id);
  const closeFillBatches = new Set<string>();
  if (batchIds.length > 0) {
    const fr = await sb
      .from("fills")
      .select("import_batch_id,fill_type")
      .in("import_batch_id", batchIds);
    if (!fr.error) {
      for (const f of (fr.data ?? []) as Array<{
        import_batch_id: string;
        fill_type: string;
      }>) {
        if (f.fill_type === "close") closeFillBatches.add(f.import_batch_id);
      }
    }
  }

  const batches: ImportBatchSummary[] = sorted.map(([id, g]) => {
    const closedExists = g.positions.some(
      (p) =>
        p.status !== "open" ||
        (p.realizedPnl !== null && Math.abs(p.realizedPnl) > 0.0001),
    );
    const hasCloseFills = closeFillBatches.has(id);
    let undoBlockedReason: string | null = null;
    if (closedExists) {
      undoBlockedReason =
        "One or more positions in this batch are no longer open or have realized P&L — undo would corrupt history.";
    } else if (hasCloseFills) {
      undoBlockedReason =
        "Batch contains close fills that attach to pre-existing positions — undo would leave those positions with stale aggregates.";
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

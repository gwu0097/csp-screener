import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { checkUndoEligibility, type FillLite, type PositionStateLite } from "@/lib/undo-batch";
import { requireUserId, authErrorResponse } from "@/lib/auth";

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
  let userId: string;
  try {
    userId = await requireUserId();
  } catch (e) {
    return authErrorResponse(e);
  }
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
    .eq("user_id", userId)
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

  // ---- Undo-eligibility ----
  // Bulk-fetch the data needed to build an EligibilityContext per
  // batch, then defer to the shared checkUndoEligibility() helper —
  // identical logic to the DELETE handler so a UI "undoable" can
  // never be rejected on confirm, and a server "allow" can never be
  // blocked by stale UI state. Rules live in lib/undo-batch.ts.
  const batchIds = sorted.map(([id]) => id);
  const fillsInBatches: FillLite[] = [];
  if (batchIds.length > 0) {
    const fr = await sb
      .from("fills")
      .select("position_id,import_batch_id,created_at")
      .eq("user_id", userId)
      .in("import_batch_id", batchIds);
    if (!fr.error) {
      fillsInBatches.push(...((fr.data ?? []) as FillLite[]));
    }
  }
  const touchedByBatch = new Map<string, Set<string>>();
  const batchEarliest = new Map<string, string>();
  for (const [batchId, g] of sorted) {
    const touched = new Set<string>(g.positions.map((p) => p.id));
    let earliest = g.latest;
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

  const allTouched = new Set<string>();
  Array.from(touchedByBatch.values()).forEach((set) => {
    set.forEach((id) => allTouched.add(id));
  });
  const fillsByPosition = new Map<string, FillLite[]>();
  const statusByPosition = new Map<string, PositionStateLite>();
  if (allTouched.size > 0) {
    const ids = Array.from(allTouched);
    const [fillsRes, posRes] = await Promise.all([
      sb
        .from("fills")
        .select("position_id,import_batch_id,created_at")
        .eq("user_id", userId)
        .in("position_id", ids),
      sb
        .from("positions")
        .select("id,symbol,status")
        .eq("user_id", userId)
        .in("id", ids),
    ]);
    if (!fillsRes.error) {
      for (const f of (fillsRes.data ?? []) as FillLite[]) {
        const arr = fillsByPosition.get(f.position_id) ?? [];
        arr.push(f);
        fillsByPosition.set(f.position_id, arr);
      }
    }
    if (!posRes.error) {
      for (const p of (posRes.data ?? []) as PositionStateLite[]) {
        statusByPosition.set(p.id, p);
      }
    }
  }

  const batches: ImportBatchSummary[] = sorted.map(([id, g]) => {
    const verdict = checkUndoEligibility({
      batchId: id,
      batchEarliest: batchEarliest.get(id) ?? g.latest,
      touchedPositionIds: Array.from(touchedByBatch.get(id) ?? []),
      fillsByPosition,
      statusByPosition,
    });
    return {
      batchId: id,
      importedAt: g.latest,
      broker: g.broker,
      positionCount: g.positions.length,
      positions: g.positions,
      undoable: verdict.undoable,
      undoBlockedReason: verdict.reason,
    };
  });

  return NextResponse.json({ batches });
}

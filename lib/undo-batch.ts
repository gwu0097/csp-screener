// Shared undo-eligibility logic for /api/positions/import-batches
// (GET — surfaces undoable flag in the list) and
// /api/positions/import-batches/[batch_id] (DELETE — actually
// executes the undo). Keep BOTH endpoints reading the same answer
// so a button enabled in the UI can never be rejected by the
// server, and a server "allow" can never be blocked by a stale UI.
//
// A batch is undoable when EVERY touched position satisfies:
//   1. No fills exist on it with import_batch_id != this batch AND
//      created_at > this batch's earliest timestamp. (No subsequent
//      activity from a later import.)
//   2. Its status is not 'expired_worthless' or 'assigned'.
//      bulk-create never sets those directly; their presence means
//      auto-expire / assignment ran AFTER the batch, and undoing
//      would leave the expire / assign side-effects dangling.
//
// "Touched" = created by the batch OR had a fill attached by the
// batch. Pre-existing positions that the batch added fills to are
// touched too (so the eligibility check still protects them).

export type FillLite = {
  position_id: string;
  import_batch_id: string | null;
  created_at: string;
};

export type PositionStateLite = {
  id: string;
  symbol: string;
  status: string;
};

export type EligibilityContext = {
  batchId: string;
  // Earliest created_at across the batch's positions + fills. Used
  // as the "anchor" for the "subsequent activity" check.
  batchEarliest: string;
  // All position ids touched by this batch.
  touchedPositionIds: string[];
  // Every fill on every touched position, across all batches.
  fillsByPosition: Map<string, FillLite[]>;
  // Current status (and symbol for the message) of every touched
  // position.
  statusByPosition: Map<string, PositionStateLite>;
};

export type EligibilityResult = {
  undoable: boolean;
  reason: string | null;
  offendingPositionId: string | null;
  offendingSymbol: string | null;
};

export function checkUndoEligibility(
  ctx: EligibilityContext,
): EligibilityResult {
  for (const positionId of ctx.touchedPositionIds) {
    const fills = ctx.fillsByPosition.get(positionId) ?? [];
    const subsequent = fills.filter(
      (f) =>
        f.import_batch_id !== ctx.batchId && f.created_at > ctx.batchEarliest,
    );
    const pos = ctx.statusByPosition.get(positionId) ?? null;
    const sym = pos?.symbol ?? "Position";
    if (subsequent.length > 0) {
      return {
        undoable: false,
        reason: `${sym} was modified after this import — undo would corrupt subsequent fills.`,
        offendingPositionId: positionId,
        offendingSymbol: sym,
      };
    }
    if (
      pos?.status === "expired_worthless" ||
      pos?.status === "assigned"
    ) {
      return {
        undoable: false,
        reason: `${sym} was ${pos.status === "assigned" ? "assigned" : "auto-expired"} after this import — undo would leave the ${pos.status === "assigned" ? "assignment" : "expire"} side-effects dangling.`,
        offendingPositionId: positionId,
        offendingSymbol: sym,
      };
    }
  }
  return {
    undoable: true,
    reason: null,
    offendingPositionId: null,
    offendingSymbol: null,
  };
}

// Loads the eligibility context for a single batch from scratch.
// GET endpoint can't reuse this directly (it bulk-fetches across 5
// batches for efficiency); DELETE uses it because it only operates
// on one batch.
//
// `sb` is the project's custom RestClient — typed as `any` to avoid
// a circular import on lib/supabase.ts and to stay compatible with
// supabase-js calls in tests.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function loadBatchEligibility(batchId: string, sb: any): Promise<
  | { ok: true; ctx: EligibilityContext; batchPositionIds: string[]; batchFillPositionIds: string[] }
  | { ok: false; error: string }
> {
  // Positions created by the batch.
  const posInBatch = await sb
    .from("positions")
    .select("id,symbol,status,created_at")
    .eq("import_batch_id", batchId);
  if (posInBatch.error) {
    return { ok: false, error: posInBatch.error.message };
  }
  const positionsCreated = (posInBatch.data ?? []) as Array<{
    id: string;
    symbol: string;
    status: string;
    created_at: string;
  }>;

  // Fills inserted by the batch.
  const fillsInBatch = await sb
    .from("fills")
    .select("position_id,import_batch_id,created_at")
    .eq("import_batch_id", batchId);
  if (fillsInBatch.error) {
    return { ok: false, error: fillsInBatch.error.message };
  }
  const batchFills = (fillsInBatch.data ?? []) as FillLite[];

  if (positionsCreated.length === 0 && batchFills.length === 0) {
    return { ok: false, error: "No positions or fills found for this batch" };
  }

  // Earliest timestamp anchor.
  let earliest = positionsCreated.length > 0
    ? positionsCreated[0].created_at
    : batchFills[0].created_at;
  for (const p of positionsCreated) {
    if (p.created_at < earliest) earliest = p.created_at;
  }
  for (const f of batchFills) {
    if (f.created_at < earliest) earliest = f.created_at;
  }

  // Touched position ids = created in this batch UNION fills' position_ids.
  const touchedSet = new Set<string>();
  for (const p of positionsCreated) touchedSet.add(p.id);
  for (const f of batchFills) touchedSet.add(f.position_id);
  const touchedPositionIds = Array.from(touchedSet);

  // All fills on touched positions across all batches, and current
  // statuses (for any position not yet in `positionsCreated`).
  const fillsByPosition = new Map<string, FillLite[]>();
  const statusByPosition = new Map<string, PositionStateLite>();
  for (const p of positionsCreated) {
    statusByPosition.set(p.id, { id: p.id, symbol: p.symbol, status: p.status });
  }
  if (touchedPositionIds.length > 0) {
    const [allFillsRes, posStateRes] = await Promise.all([
      sb
        .from("fills")
        .select("position_id,import_batch_id,created_at")
        .in("position_id", touchedPositionIds),
      sb
        .from("positions")
        .select("id,symbol,status")
        .in("id", touchedPositionIds),
    ]);
    if (allFillsRes.error) {
      return { ok: false, error: allFillsRes.error.message };
    }
    if (posStateRes.error) {
      return { ok: false, error: posStateRes.error.message };
    }
    for (const f of (allFillsRes.data ?? []) as FillLite[]) {
      const arr = fillsByPosition.get(f.position_id) ?? [];
      arr.push(f);
      fillsByPosition.set(f.position_id, arr);
    }
    for (const p of (posStateRes.data ?? []) as PositionStateLite[]) {
      statusByPosition.set(p.id, p);
    }
  }

  return {
    ok: true,
    ctx: {
      batchId,
      batchEarliest: earliest,
      touchedPositionIds,
      fillsByPosition,
      statusByPosition,
    },
    batchPositionIds: positionsCreated.map((p) => p.id),
    batchFillPositionIds: Array.from(
      new Set(batchFills.map((f) => f.position_id)),
    ),
  };
}

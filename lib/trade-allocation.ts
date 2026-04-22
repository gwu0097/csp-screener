// Distribute a close transaction's contracts across open parents FIFO.
// Shared between /api/trades/bulk-create (at import time) and the
// reconciliation script (to backfill orphaned / over-consumed closes
// already in the DB).

import type { createServerClient, TradeRow } from "./supabase";

export type AllocationKey = {
  symbol: string;
  strike: number;
  expiry: string;
  broker: string;
};

export type Allocation = {
  parentId: string | null; // null = residue (no matching open had capacity)
  contracts: number;
};

export type AllocationResult = {
  allocations: Allocation[];
  // Parents whose remaining contracts hit zero as a result of this close.
  // Caller should PATCH closed_at on these after inserting the child rows.
  fullyClosedParentIds: string[];
};

// Fetch all open parents (action='open', closed_at IS NULL) matching the
// key, plus the sum of close-contract children per parent, and decide how
// to allocate `contracts` across them FIFO (oldest trade_date first).
//
// Does NOT insert or mutate anything — returns a plan. The caller applies
// the plan with buildInsert + supabase.insert.
export async function allocateCloseFIFO(
  supabase: ReturnType<typeof createServerClient>,
  key: AllocationKey,
  contracts: number,
): Promise<AllocationResult> {
  const broker = key.broker.toLowerCase();

  const { data: parentsRaw } = await supabase
    .from<TradeRow>("trades")
    .select("*")
    .eq("action", "open")
    .eq("symbol", key.symbol.toUpperCase())
    .eq("strike", key.strike)
    .eq("expiry", key.expiry)
    .eq("broker", broker)
    .is("closed_at", null)
    .order("trade_date", { ascending: true });
  const opens = (parentsRaw ?? []) as TradeRow[];

  if (opens.length === 0) {
    return {
      allocations: [{ parentId: null, contracts }],
      fullyClosedParentIds: [],
    };
  }

  const parentIds = opens.map((p) => p.id);
  const { data: kidsRaw } = await supabase
    .from<{ parent_trade_id: string | null; contracts: number | null }>("trades")
    .select("parent_trade_id, contracts")
    .eq("action", "close")
    .in("parent_trade_id", parentIds);
  const closedByParent = new Map<string, number>();
  for (const k of (kidsRaw ?? []) as Array<{
    parent_trade_id: string | null;
    contracts: number | null;
  }>) {
    if (!k.parent_trade_id) continue;
    closedByParent.set(
      k.parent_trade_id,
      (closedByParent.get(k.parent_trade_id) ?? 0) + (k.contracts ?? 0),
    );
  }

  // Walk FIFO, allocating from each open's remaining capacity until the
  // close is exhausted or we run out of opens.
  const allocations: Allocation[] = [];
  const fullyClosedParentIds: string[] = [];
  let remaining = contracts;
  for (const p of opens) {
    if (remaining <= 0) break;
    const already = closedByParent.get(p.id) ?? 0;
    const capacity = (p.contracts ?? 1) - already;
    if (capacity <= 0) continue;
    const take = Math.min(capacity, remaining);
    allocations.push({ parentId: p.id, contracts: take });
    if (capacity - take === 0) fullyClosedParentIds.push(p.id);
    remaining -= take;
  }
  if (remaining > 0) {
    allocations.push({ parentId: null, contracts: remaining });
  }

  return { allocations, fullyClosedParentIds };
}

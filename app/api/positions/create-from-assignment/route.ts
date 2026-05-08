import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const maxDuration = 30;

// POST /api/positions/create-from-assignment
//
// Creates stock_long position rows from already-assigned put
// positions. Called after the user confirms the AssignmentStockPrompt
// modal that pops up when /api/positions/confirm-expire returns
// non-empty assignments[].
//
// Body: { items: [{ assignedPositionId: string }] }
//
// For each item we look up the parent (status='assigned') put,
// compute cost basis = strike − avg_premium_per_share, then INSERT a
// new row:
//   position_type='stock_long'
//   symbol, broker copied from the put
//   total_contracts = original_contracts × 100  (= share count)
//   entry_stock_price = cost basis
//   opened_date = today (the day shares actually arrive)
//   assignment_source_id = the assigned put's id
//   notes = "Assigned from {symbol} ${strike}P {expiry}"
//
// Idempotent: if a stock row with this assignment_source_id already
// exists we skip and return it. The migration's position_type +
// assignment_source_id columns must exist for this to succeed.

type Item = { assignedPositionId?: unknown };
type Body = { items?: unknown };

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function POST(req: NextRequest) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const itemsRaw = Array.isArray(body.items) ? (body.items as Item[]) : [];
  const ids: string[] = [];
  for (const i of itemsRaw) {
    if (typeof i.assignedPositionId === "string" && i.assignedPositionId)
      ids.push(i.assignedPositionId);
  }
  if (ids.length === 0) {
    return NextResponse.json(
      { error: "items[].assignedPositionId required" },
      { status: 400 },
    );
  }

  const sb = createServerClient();

  const lookup = await sb
    .from("positions")
    .select(
      "id,symbol,broker,strike,expiry,total_contracts,avg_premium_sold,status",
    )
    .in("id", ids);
  if (lookup.error) {
    return NextResponse.json({ error: lookup.error.message }, { status: 500 });
  }
  type Parent = {
    id: string;
    symbol: string;
    broker: string | null;
    strike: number;
    expiry: string;
    total_contracts: number | null;
    avg_premium_sold: number | null;
    status: string;
  };
  const parents = (lookup.data ?? []) as Parent[];

  // Skip parents that already have a stock_long row pointing back
  // (idempotent guard against double-clicks / retries).
  const existRes = await sb
    .from("positions")
    .select("id,assignment_source_id")
    .in("assignment_source_id", ids);
  const alreadyCreated = new Set(
    ((existRes.data ?? []) as Array<{ assignment_source_id: string }>).map(
      (r) => r.assignment_source_id,
    ),
  );

  const created: Array<{
    parentId: string;
    stockPositionId: string;
    symbol: string;
    shares: number;
    costBasis: number;
  }> = [];
  const skipped: Array<{ parentId: string; reason: string }> = [];

  const today = todayIso();

  for (const p of parents) {
    if (alreadyCreated.has(p.id)) {
      skipped.push({
        parentId: p.id,
        reason: "stock_long row already exists for this assignment",
      });
      continue;
    }
    if (p.status !== "assigned") {
      skipped.push({
        parentId: p.id,
        reason: `parent status is ${p.status}, expected 'assigned'`,
      });
      continue;
    }
    const strike = Number(p.strike);
    const contracts = Number(p.total_contracts ?? 0);
    if (contracts <= 0) {
      skipped.push({
        parentId: p.id,
        reason: "parent has 0 contracts — nothing to create",
      });
      continue;
    }
    const avgPremium =
      p.avg_premium_sold !== null ? Number(p.avg_premium_sold) : 0;
    const costBasis = Math.round((strike - avgPremium) * 100) / 100;
    const shares = contracts * 100;

    const insert = await sb
      .from("positions")
      .insert({
        symbol: p.symbol,
        strike: 0,
        expiry: today,
        option_type: "put",
        broker: p.broker ?? "schwab",
        total_contracts: shares,
        avg_premium_sold: null,
        status: "open",
        opened_date: today,
        notes: `Assigned from ${p.symbol} $${strike}P ${p.expiry}`,
        position_type: "stock_long",
        assignment_source_id: p.id,
        entry_stock_price: costBasis,
      })
      .select()
      .single();
    type InsertedRow = { id: string };
    const inserted = insert.data as InsertedRow | null;
    if (insert.error || !inserted) {
      skipped.push({
        parentId: p.id,
        reason: `insert failed: ${insert.error?.message ?? "unknown"}`,
      });
      continue;
    }
    created.push({
      parentId: p.id,
      stockPositionId: inserted.id,
      symbol: p.symbol,
      shares,
      costBasis,
    });
  }

  return NextResponse.json({
    created_count: created.length,
    skipped_count: skipped.length,
    created,
    skipped,
  });
}

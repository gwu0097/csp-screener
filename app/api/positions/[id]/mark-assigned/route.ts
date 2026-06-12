import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { realizedPnl, type Fill } from "@/lib/positions";
import { requireUserId, authErrorResponse } from "@/lib/auth";

export const dynamic = "force-dynamic";

// Manual early-assignment for an open short put. Schwab doesn't always
// emit a fill the import catches when a put is assigned before expiry,
// so the user marks it by hand:
//   1. $0.00 close fill on the put (assignment date) — full premium
//      stays as realized P&L, matching the expiry-day Option A
//      accounting in lib/expire-positions.recordAssignment.
//   2. Put status → 'assigned', closed_date = assignment date.
//   3. stock_long position created at strike (shares = remaining ×
//      100), linked via assignment_source_id — same shape as
//      /api/positions/create-from-assignment, idempotent on the link.
// The market loss is NOT booked on the put: it carries forward as the
// stock's cost basis (= strike), so nothing is double-counted.

type Body = { assignmentDate?: unknown };

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch (e) {
    return authErrorResponse(e);
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const assignmentDate =
    typeof body.assignmentDate === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(body.assignmentDate)
      ? body.assignmentDate
      : null;
  if (!assignmentDate) {
    return NextResponse.json(
      { error: "assignmentDate (YYYY-MM-DD) is required" },
      { status: 400 },
    );
  }

  const sb = createServerClient();
  const posRes = await sb
    .from("positions")
    .select(
      "id,symbol,strike,expiry,broker,status,notes,direction,option_type,position_type",
    )
    .eq("id", params.id)
    .eq("user_id", userId)
    .maybeSingle();
  if (posRes.error) {
    return NextResponse.json({ error: posRes.error.message }, { status: 500 });
  }
  const pos = posRes.data as {
    id: string;
    symbol: string;
    strike: number;
    expiry: string;
    broker: string | null;
    status: string;
    notes: string | null;
    direction: string | null;
    option_type: string | null;
    position_type: string | null;
  } | null;
  if (!pos) {
    return NextResponse.json({ error: "Position not found" }, { status: 404 });
  }

  // Guards: open short puts only. NULL direction is pre-migration data
  // (every legacy position is a sold-to-open CSP); NULL option_type
  // likewise defaults to put.
  if (pos.status !== "open") {
    return NextResponse.json(
      { error: `Position is ${pos.status}, not open` },
      { status: 409 },
    );
  }
  if (
    pos.position_type === "stock_long" ||
    pos.position_type === "stock_short"
  ) {
    return NextResponse.json(
      { error: "Stock positions can't be marked as assigned" },
      { status: 400 },
    );
  }
  if ((pos.option_type ?? "put") !== "put" || (pos.direction ?? "short") !== "short") {
    return NextResponse.json(
      { error: "Only open SHORT PUTS can be marked as assigned" },
      { status: 400 },
    );
  }

  // Remaining contracts from the fill ledger (total_contracts is the
  // historical "ever opened" count and over-counts after rolls).
  const fillsRes = await sb
    .from("fills")
    .select("fill_type, contracts, premium, fill_date")
    .eq("position_id", pos.id)
    .eq("user_id", userId);
  if (fillsRes.error) {
    return NextResponse.json({ error: fillsRes.error.message }, { status: 500 });
  }
  const priorFills = (fillsRes.data ?? []) as Fill[];
  const opened = priorFills
    .filter((f) => f.fill_type === "open")
    .reduce((s, f) => s + f.contracts, 0);
  const closed = priorFills
    .filter((f) => f.fill_type === "close")
    .reduce((s, f) => s + f.contracts, 0);
  const remaining = Math.max(0, opened - closed);
  if (remaining === 0) {
    return NextResponse.json(
      { error: "No remaining contracts — position is already fully closed" },
      { status: 409 },
    );
  }

  // Idempotency: a stock position already linked back means this
  // assignment was processed (double-click / retry).
  const existing = await sb
    .from("positions")
    .select("id")
    .eq("assignment_source_id", pos.id)
    .eq("user_id", userId)
    .limit(1);
  if ((existing.data ?? []).length > 0) {
    return NextResponse.json(
      { error: "Already marked as assigned — a linked stock position exists" },
      { status: 409 },
    );
  }

  // 1. $0.00 close fill dated to the assignment.
  const closeFill = await sb.from("fills").insert({
    position_id: pos.id,
    user_id: userId,
    fill_type: "close",
    contracts: remaining,
    premium: 0,
    fill_date: assignmentDate,
  });
  if (closeFill.error) {
    return NextResponse.json(
      { error: `close fill failed: ${closeFill.error.message}` },
      { status: 500 },
    );
  }

  // 2. Put → assigned. realized_pnl = full premium retained (the $0
  // close adds nothing to the buy-back side).
  const allFills: Fill[] = [
    ...priorFills,
    { fill_type: "close", contracts: remaining, premium: 0, fill_date: assignmentDate },
  ];
  const realized = Math.round(realizedPnl(allFills, "short") * 100) / 100;
  const strike = Number(pos.strike);
  const noteAdd = `Marked assigned early (${remaining} contract${remaining === 1 ? "" : "s"}) on ${assignmentDate}. Shares received at $${strike.toFixed(2)} strike.`;
  const upd = await sb
    .from("positions")
    .update({
      status: "assigned",
      realized_pnl: realized,
      closed_date: assignmentDate,
      notes: pos.notes ? `${pos.notes} | ${noteAdd}` : noteAdd,
      updated_at: new Date().toISOString(),
    })
    .eq("id", pos.id)
    .eq("user_id", userId);
  if (upd.error) {
    return NextResponse.json(
      { error: `put update failed: ${upd.error.message}` },
      { status: 500 },
    );
  }

  // 3. stock_long at strike — Option A cost basis. Same row shape as
  // create-from-assignment (strike=0 + position_type is how stock rows
  // are modelled; entry_stock_price carries the basis).
  const shares = remaining * 100;
  const stockInsert = await sb
    .from("positions")
    .insert({
      symbol: pos.symbol,
      strike: 0,
      expiry: assignmentDate,
      option_type: "put",
      broker: pos.broker ?? "schwab",
      total_contracts: shares,
      avg_premium_sold: null,
      status: "open",
      opened_date: assignmentDate,
      notes: `Assigned early from ${pos.symbol} $${strike.toFixed(2)}P ${pos.expiry}`,
      position_type: "stock_long",
      assignment_source_id: pos.id,
      entry_stock_price: strike,
      user_id: userId,
    })
    .select("id")
    .single();
  if (stockInsert.error || !stockInsert.data) {
    return NextResponse.json(
      {
        error: `stock position insert failed: ${stockInsert.error?.message ?? "unknown"} — the put was closed; create the stock row via the assignment tools`,
      },
      { status: 500 },
    );
  }
  const stockId = (stockInsert.data as { id: string }).id;

  // Open fill so the share ledger (remaining shares / sell flows)
  // works exactly like every other stock_long.
  const openFill = await sb.from("fills").insert({
    position_id: stockId,
    user_id: userId,
    fill_type: "open",
    contracts: shares,
    premium: strike,
    fill_date: assignmentDate,
  });
  if (openFill.error) {
    return NextResponse.json(
      { error: `stock open-fill failed: ${openFill.error.message}` },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    message: `${pos.symbol}: ${remaining} put${remaining === 1 ? "" : "s"} assigned → ${shares} shares @ $${strike.toFixed(2)}`,
    stockPositionId: stockId,
    shares,
    costBasis: strike,
    putRealizedPnl: realized,
  });
}

import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { realizedPnl, reduceStockLotForCallAssignment, type Fill } from "@/lib/positions";
import { requireUserId, authErrorResponse } from "@/lib/auth";

export const dynamic = "force-dynamic";

// Manual early-assignment for an open short put OR short call. Schwab
// doesn't always emit a fill the import catches when an option is
// assigned before expiry, so the user marks it by hand:
//   1. $0.00 close fill on the option (assignment date).
//   2. Option status → 'assigned', realized_pnl → 0. The premium isn't
//      lost — it moves onto the stock leg's cost basis (put) or sale
//      proceeds (call), so the stock round-trip carries the whole
//      economic result of the assignment cycle in one interpretable
//      number instead of splitting it arbitrarily across two rows.
//   3. Put: a NEW stock_long position is created (shares = remaining ×
//      100) at strike MINUS the per-share premium collected — the
//      assignment means BUYING shares at an effective cost reduced by
//      the premium banked. Same shape as
//      /api/positions/create-from-assignment.
//      Call: shares are CALLED AWAY — the opposite direction. There is
//      no new stock position to create; instead an existing open
//      stock_long lot for the same symbol (if one is tracked, any
//      broker — covered calls are written against shares held wherever
//      they actually live) gets a close fill for `shares` at strike
//      PLUS the per-share premium collected (the premium raises the
//      effective sale proceeds), reusing recalculatePositionFromFills'
//      already-correct stock P&L math. If no matching lot exists, the
//      option leg still closes correctly; there's just nothing to
//      reduce.

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
  const optionType: "put" | "call" = pos.option_type === "call" ? "call" : "put";
  if ((pos.direction ?? "short") !== "short") {
    return NextResponse.json(
      { error: "Only open short options can be marked as assigned" },
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

  // 2. Option → assigned, realized_pnl → 0. The premium collected (the
  // $0 close adds nothing to the buy-back side, so `realized` here is
  // exactly the premium banked) moves onto the stock leg below instead
  // of staying on this row. Direction-only, correct for both puts and
  // calls.
  const allFills: Fill[] = [
    ...priorFills,
    { fill_type: "close", contracts: remaining, premium: 0, fill_date: assignmentDate },
  ];
  const realized = Math.round(realizedPnl(allFills, "short") * 100) / 100;
  const strike = Number(pos.strike);
  const shares = remaining * 100;
  const premiumPerShare = shares > 0 ? realized / shares : 0;
  const noteAdd =
    optionType === "call"
      ? `Called away early (${remaining} contract${remaining === 1 ? "" : "s"}) on ${assignmentDate}. Shares sold at $${strike.toFixed(2)} strike.`
      : `Marked assigned early (${remaining} contract${remaining === 1 ? "" : "s"}) on ${assignmentDate}. Shares received at $${strike.toFixed(2)} strike.`;
  const upd = await sb
    .from("positions")
    .update({
      status: "assigned",
      realized_pnl: 0,
      closed_date: assignmentDate,
      notes: pos.notes ? `${pos.notes} | ${noteAdd}` : noteAdd,
      updated_at: new Date().toISOString(),
    })
    .eq("id", pos.id)
    .eq("user_id", userId);
  if (upd.error) {
    return NextResponse.json(
      { error: `option update failed: ${upd.error.message}` },
      { status: 500 },
    );
  }

  if (optionType === "put") {
    // 3a. Put: stock_long at strike minus the premium banked — the
    // premium reduces the cost basis of the assigned shares, so the
    // stock round-trip carries the whole economic result. Same row
    // shape as create-from-assignment (strike=0 + position_type is how
    // stock rows are modelled; entry_stock_price carries the basis).
    const costBasis = Math.round((strike - premiumPerShare) * 10000) / 10000;
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
        entry_stock_price: costBasis,
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
      premium: costBasis,
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
      message: `${pos.symbol}: ${remaining} put${remaining === 1 ? "" : "s"} assigned → ${shares} shares @ $${strike.toFixed(2)} (cost basis $${costBasis.toFixed(2)} after premium)`,
      stockPositionId: stockId,
      shares,
      costBasis,
      putRealizedPnl: realized,
    });
  }

  // 3b. Call: shares are CALLED AWAY — the opposite direction from a
  // put assignment. No new position is created; reduceStockLotForCallAssignment
  // reduces an existing open stock_long lot for this symbol (any
  // broker — the call is tracked separately from wherever the shares
  // actually live) by `shares`, sold at `strike`. Ambiguous/missing
  // lots are left for the user via Sell Shares — same shared rule the
  // bulk expiry-confirmation flow uses (confirm-expire/route.ts), so
  // the two entry points can't drift.
  const reduced = await reduceStockLotForCallAssignment(
    sb,
    userId,
    pos.symbol,
    shares,
    strike,
    assignmentDate,
    premiumPerShare,
  );
  if (!reduced.ok) {
    const reasonMsg =
      reduced.reason === "no_lot"
        ? `No single tracked stock lot covers ${shares} shares — use Sell Shares to record the sale if you track this position's stock.`
        : reduced.reason === "ambiguous_lot"
          ? `Multiple stock lots could cover ${shares} shares — use Sell Shares to pick the right one.`
          : `The linked stock lot couldn't be updated (${reduced.detail ?? "unknown error"}) — use Sell Shares to record it.`;
    return NextResponse.json({
      ok: true,
      message: `${pos.symbol}: ${remaining} call${remaining === 1 ? "" : "s"} called away. ${reasonMsg}`,
      shares,
      strikePrice: strike,
      callRealizedPnl: realized,
      stockLotAdjusted: false,
    });
  }

  return NextResponse.json({
    ok: true,
    message: `${pos.symbol}: ${remaining} call${remaining === 1 ? "" : "s"} called away → ${shares} shares sold @ $${strike.toFixed(2)}`,
    stockPositionId: reduced.stockPositionId,
    shares,
    strikePrice: strike,
    callRealizedPnl: realized,
    stockLotAdjusted: true,
  });
}

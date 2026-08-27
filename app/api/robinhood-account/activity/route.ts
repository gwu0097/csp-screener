import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { requireAdmin, authErrorResponse } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// GET /api/robinhood-account/activity
//
// Every robinhood_account_transactions row the courier-fed importer
// has touched and the user hasn't dismissed yet — mirrors
// app/api/schwab-account/activity/route.ts exactly in shape. Unlike
// the Schwab table, there's no raw-jsonb digging here: the landing
// table already stores symbol/strike/expiry/side/position_effect/etc
// as flat columns (see lib/robinhood-account-import.ts), since a
// Robinhood row IS one execution, not a whole transaction with a leg
// buried inside it. Dismissing a row (see [id]/dismiss/route.ts) is
// permanent; the importer never revisits processed=true rows.
const LOOKBACK_DAYS = 30;

// No administrative-noise outcomes to filter beyond duplicates (unlike
// Schwab's dividends/fees/transfers) — only options fills ever land in
// this table at all. skipped_duplicate is excluded from needs_review:
// the importer always attaches Robinhood's own execution_id (see
// fills.external_id), so a skipped_duplicate here is an exact id match
// against a fill already correctly on the position — not a
// probabilistic guess, nothing to review or dismiss.
const APPLIED_OUTCOMES = new Set(["submitted"]);
const NOISE_OUTCOMES = new Set(["skipped_duplicate"]);

type ActivityRow = {
  id: string;
  execution_id: string;
  order_id: string;
  broker: string;
  account_number: string;
  symbol: string;
  strike: number | null;
  expiry: string | null;
  option_type: string | null;
  side: string | null;
  position_effect: string | null;
  contracts: number | null;
  price: number | null;
  trade_date: string;
  process_outcome: string;
  process_detail: string | null;
};

export async function GET() {
  try {
    await requireAdmin();
  } catch (e) {
    return authErrorResponse(e);
  }

  const sb = createServerClient();
  const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const res = await sb
    .from("robinhood_account_transactions")
    .select(
      "id,execution_id,order_id,broker,account_number,symbol,strike,expiry,option_type,side,position_effect,contracts,price,trade_date,process_outcome,process_detail",
    )
    .eq("processed", true)
    .eq("dismissed", false)
    .gte("trade_date", since.slice(0, 10))
    .order("trade_date", { ascending: false })
    .limit(200);
  if (res.error) {
    return NextResponse.json({ error: res.error.message }, { status: 500 });
  }

  const rows = ((res.data ?? []) as ActivityRow[]).filter(
    (r) => r.process_outcome && !NOISE_OUTCOMES.has(r.process_outcome),
  );
  const items = rows.map((r) => ({
    id: r.id,
    executionId: r.execution_id,
    orderId: r.order_id,
    transactionTime: r.trade_date,
    broker: r.broker,
    accountNumber: r.account_number,
    symbol: r.symbol,
    strike: r.strike,
    putCall: r.option_type,
    expiry: r.expiry,
    positionEffect: r.position_effect === "open" ? "OPENING" : "CLOSING",
    contracts: r.contracts,
    price: r.price,
    // Same mapping as lib/robinhood-account-import.ts's TradeInput
    // build — side "sell" on open = short.
    direction: r.side === "sell" ? "short" : "long",
    outcome: r.process_outcome,
    detail: r.process_detail,
    status: APPLIED_OUTCOMES.has(r.process_outcome) ? "applied" : "needs_review",
  }));

  return NextResponse.json({ items });
}

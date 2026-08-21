import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { requireAdmin, authErrorResponse } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// GET /api/schwab-account/activity
//
// Every schwab_account_transactions row the auto-import poller has
// touched and the user hasn't dismissed yet — both what it applied
// automatically (status "applied": submitted/expired/assigned, shown
// so the user can validate what changed) and what it couldn't apply
// (status "needs_review": a bulk-create validation error, no matching
// position, or a suspected duplicate it declined to write). Purely
// administrative noise (dividends, cash transfers, fee-only legs) is
// excluded — it was never a position event to review. Dismissing a
// row (see [id]/dismiss/route.ts) is permanent; the poller never
// revisits processed=true rows, so nothing here is retried.
const LOOKBACK_DAYS = 30;

// Real trade/expiration/assignment events the poller applied cleanly.
const APPLIED_OUTCOMES = new Set(["submitted", "expired", "assigned"]);
// Administrative rows that were never a position event — never shown.
const NOISE_OUTCOMES = new Set([
  "skipped_no_leg",
  "skipped_unhandled_leg",
  "skipped_unhandled",
  "skipped_irrelevant_type",
]);

type ActivityRow = {
  id: string;
  activity_id: number;
  type: string;
  transaction_time: string;
  process_outcome: string;
  process_detail: string | null;
  broker: string;
  account_number: string;
  raw: {
    description?: string;
    transferItems?: Array<{
      instrument?: {
        assetType?: string;
        underlyingSymbol?: string;
        symbol?: string;
        putCall?: string;
        strikePrice?: number;
        expirationDate?: string;
      };
      amount?: number;
      price?: number;
      positionEffect?: string;
    }>;
  };
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
    .from("schwab_account_transactions")
    .select("id,activity_id,type,transaction_time,process_outcome,process_detail,broker,account_number,raw")
    .eq("processed", true)
    .eq("dismissed", false)
    .gte("transaction_time", since)
    .order("transaction_time", { ascending: false })
    .limit(500);
  if (res.error) {
    return NextResponse.json({ error: res.error.message }, { status: 500 });
  }

  const rows = ((res.data ?? []) as ActivityRow[])
    .filter((r) => r.process_outcome && !NOISE_OUTCOMES.has(r.process_outcome))
    .slice(0, 100);
  const items = rows.map((r) => {
    const leg = r.raw.transferItems?.find((ti) => ti.instrument?.assetType !== "CURRENCY");
    const amount = leg?.amount ?? null;
    return {
      id: r.id,
      activityId: r.activity_id,
      type: r.type,
      transactionTime: r.transaction_time,
      broker: r.broker,
      accountNumber: r.account_number,
      description: r.raw.description ?? null,
      symbol: leg?.instrument?.underlyingSymbol ?? leg?.instrument?.symbol ?? null,
      strike: leg?.instrument?.strikePrice ?? null,
      putCall: leg?.instrument?.putCall ?? null,
      expiry: leg?.instrument?.expirationDate?.slice(0, 10) ?? null,
      positionEffect: leg?.positionEffect ?? null,
      amount,
      price: leg?.price ?? null,
      // Prefill hints for the "Import" action — contracts/direction
      // mirror lib/schwab-account-import.ts's own TradeInput mapping
      // (amount<0 = sold to open = short; abs(amount) = contract count).
      contracts: amount !== null ? Math.abs(amount) : null,
      direction: amount !== null ? (amount < 0 ? "short" : "long") : null,
      outcome: r.process_outcome,
      detail: r.process_detail,
      status: APPLIED_OUTCOMES.has(r.process_outcome) ? "applied" : "needs_review",
    };
  });

  return NextResponse.json({ items });
}

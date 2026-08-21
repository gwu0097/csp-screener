import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { requireAdmin, authErrorResponse } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// GET /api/schwab-account/unresolved
//
// Every schwab_account_transactions row the auto-import poller landed
// but couldn't turn into a position update — process_outcome starting
// with "error_" (a close/expiration/assignment with no matching
// position, a bulk-create validation failure, etc.). This is the
// "doesn't fit the model, surface it" half of the auto-import design:
// a transaction that fits gets applied automatically (see
// lib/schwab-account-import.ts); one that doesn't lands here instead
// of silently sitting in a table nobody looks at.
const LOOKBACK_DAYS = 30;

type UnresolvedRow = {
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
  // The wrapper (lib/supabase.ts) has no .like()/.not() — fetch
  // processed rows in the window and filter the error_* prefix in JS.
  const res = await sb
    .from("schwab_account_transactions")
    .select("id,activity_id,type,transaction_time,process_outcome,process_detail,broker,account_number,raw")
    .eq("processed", true)
    .gte("transaction_time", since)
    .order("transaction_time", { ascending: false })
    .limit(500);
  if (res.error) {
    return NextResponse.json({ error: res.error.message }, { status: 500 });
  }

  const rows = ((res.data ?? []) as UnresolvedRow[])
    .filter((r) => r.process_outcome?.startsWith("error_"))
    .slice(0, 100);
  const items = rows.map((r) => {
    const leg = r.raw.transferItems?.find((ti) => ti.instrument?.assetType !== "CURRENCY");
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
      amount: leg?.amount ?? null,
      price: leg?.price ?? null,
      outcome: r.process_outcome,
      detail: r.process_detail,
    };
  });

  return NextResponse.json({ items });
}

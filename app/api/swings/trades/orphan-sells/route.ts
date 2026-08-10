import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { requireUserId, authErrorResponse } from "@/lib/auth";

export const dynamic = "force-dynamic";
// Sell fills the matcher (lib/swing-trade-fills.ts) couldn't apply — no
// open position for the symbol, or more shares than were open across
// every open position for it. Persisted at write time (see bulk-create),
// surfaced here for review rather than living only in that one API
// response.

type OrphanRow = {
  id: string;
  symbol: string;
  fill_date: string;
  price: number;
  shares: number;
  exit_reason: string | null;
  broker: string | null;
  source: string;
  reviewed: boolean;
  created_at: string;
};

export async function GET() {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch (e) {
    return authErrorResponse(e);
  }
  const sb = createServerClient();
  const res = await sb
    .from<OrphanRow>("swing_trade_orphan_sells")
    .select("*")
    .eq("user_id", userId)
    .order("reviewed", { ascending: true })
    .order("fill_date", { ascending: false });
  if (res.error) {
    return NextResponse.json({ error: res.error.message }, { status: 500 });
  }
  return NextResponse.json({ orphan_sells: res.data ?? [] });
}

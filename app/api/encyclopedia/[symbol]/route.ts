import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import type {
  EarningsHistory,
  StockEncyclopedia,
} from "@/lib/encyclopedia";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ symbol: string }> },
) {
  const { symbol } = await params;
  const sym = symbol.toUpperCase();
  const sb = createServerClient();

  const encRes = await sb
    .from("stock_encyclopedia")
    .select("*")
    .eq("symbol", sym)
    .limit(1);
  if (encRes.error) {
    return NextResponse.json({ error: encRes.error.message }, { status: 500 });
  }
  const encyclopedia = ((encRes.data ?? []) as StockEncyclopedia[])[0] ?? null;

  const histRes = await sb
    .from("earnings_history")
    .select("*")
    .eq("symbol", sym)
    .order("earnings_date", { ascending: false });
  if (histRes.error) {
    return NextResponse.json({ error: histRes.error.message }, { status: 500 });
  }
  const history = (histRes.data ?? []) as EarningsHistory[];

  return NextResponse.json({ encyclopedia, history });
}

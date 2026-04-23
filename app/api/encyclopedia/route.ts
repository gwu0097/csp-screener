import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import type { StockEncyclopedia } from "@/lib/encyclopedia";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// Returns every encyclopedia row ordered by symbol. Used by the summary
// grid on /encyclopedia when no ticker is selected.
export async function GET() {
  const sb = createServerClient();
  const res = await sb
    .from("stock_encyclopedia")
    .select("*")
    .order("symbol", { ascending: true });
  if (res.error) {
    return NextResponse.json({ error: res.error.message }, { status: 500 });
  }
  return NextResponse.json({ entries: (res.data ?? []) as StockEncyclopedia[] });
}

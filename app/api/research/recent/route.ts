import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

type StockRow = {
  symbol: string;
  company_name: string | null;
  sector: string | null;
  overall_grade: string | null;
  last_researched_at: string | null;
};

export async function GET(): Promise<NextResponse> {
  const sb = createServerClient();
  const res = await sb
    .from("research_stocks")
    .select("symbol,company_name,sector,overall_grade,last_researched_at")
    .order("last_researched_at", { ascending: false })
    .limit(10);
  if (res.error) {
    return NextResponse.json({ error: res.error.message }, { status: 500 });
  }
  return NextResponse.json({ stocks: (res.data ?? []) as StockRow[] });
}

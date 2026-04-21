import { NextRequest, NextResponse } from "next/server";
import { createServerClient, TradeRow } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = createServerClient();
  const { data, error } = await supabase
    .from("trades")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ trades: (data ?? []) as TradeRow[] });
}

type TradeInsert = {
  symbol: string;
  trade_date: string;
  earnings_date: string;
  entry_stock_price?: number | null;
  strike: number;
  expiry: string;
  premium_sold: number;
  crush_grade?: string | null;
  opportunity_grade?: string | null;
  notes?: string | null;
};

export async function POST(req: NextRequest) {
  let body: TradeInsert;
  try {
    body = (await req.json()) as TradeInsert;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const required: Array<keyof TradeInsert> = ["symbol", "trade_date", "earnings_date", "strike", "expiry", "premium_sold"];
  for (const key of required) {
    if (body[key] === undefined || body[key] === null || body[key] === "") {
      return NextResponse.json({ error: `Missing field: ${key}` }, { status: 400 });
    }
  }
  const supabase = createServerClient();
  const { data, error } = await supabase
    .from("trades")
    .insert({
      symbol: body.symbol.toUpperCase(),
      trade_date: body.trade_date,
      earnings_date: body.earnings_date,
      entry_stock_price: body.entry_stock_price ?? null,
      strike: body.strike,
      expiry: body.expiry,
      premium_sold: body.premium_sold,
      crush_grade: body.crush_grade ?? null,
      opportunity_grade: body.opportunity_grade ?? null,
      notes: body.notes ?? null,
    })
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ trade: data as TradeRow });
}

type TradePatch = {
  id: string;
  premium_bought?: number | null;
  outcome?: string | null;
  closed_at?: string | null;
  notes?: string | null;
};

export async function PATCH(req: NextRequest) {
  let body: TradePatch;
  try {
    body = (await req.json()) as TradePatch;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!body.id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  const supabase = createServerClient();
  const update: Record<string, unknown> = {};
  if (body.premium_bought !== undefined) update.premium_bought = body.premium_bought;
  if (body.outcome !== undefined) update.outcome = body.outcome;
  if (body.closed_at !== undefined) update.closed_at = body.closed_at ?? new Date().toISOString();
  if (body.notes !== undefined) update.notes = body.notes;
  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "No fields to update" }, { status: 400 });
  }
  const { data, error } = await supabase.from("trades").update(update).eq("id", body.id).select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ trade: data as TradeRow });
}

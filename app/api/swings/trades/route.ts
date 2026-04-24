import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

const ALLOWED_EXIT_REASONS = [
  "target_hit",
  "stop_loss",
  "thesis_broken",
  "manual",
] as const;

type TradeRow = {
  id: string;
  swing_idea_id: string | null;
  symbol: string;
  broker: string | null;
  shares: number | null;
  entry_price: number | null;
  entry_date: string | null;
  exit_price: number | null;
  exit_date: string | null;
  realized_pnl: number | null;
  return_pct: number | null;
  thesis: string | null;
  exit_reason: string | null;
  status: string;
  created_at: string;
  updated_at: string;
};

export async function GET() {
  const sb = createServerClient();
  const res = await sb
    .from<TradeRow>("swing_trades")
    .select("*")
    .order("entry_date", { ascending: false });
  if (res.error) {
    return NextResponse.json({ error: res.error.message }, { status: 500 });
  }
  return NextResponse.json({ trades: res.data ?? [] });
}

type CreateBody = {
  swing_idea_id?: unknown;
  symbol?: unknown;
  broker?: unknown;
  shares?: unknown;
  entry_price?: unknown;
  entry_date?: unknown;
  exit_price?: unknown;
  exit_date?: unknown;
  thesis?: unknown;
  exit_reason?: unknown;
};

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export async function POST(req: NextRequest) {
  let body: CreateBody;
  try {
    body = (await req.json()) as CreateBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (typeof body.symbol !== "string" || body.symbol.trim().length === 0) {
    return NextResponse.json({ error: "Missing symbol" }, { status: 400 });
  }
  const symbol = body.symbol.trim().toUpperCase();

  const shares = num(body.shares);
  const entryPrice = num(body.entry_price);
  if (shares === null || shares <= 0) {
    return NextResponse.json({ error: "shares must be > 0" }, { status: 400 });
  }
  if (entryPrice === null || entryPrice <= 0) {
    return NextResponse.json({ error: "entry_price must be > 0" }, { status: 400 });
  }
  if (typeof body.entry_date !== "string" || body.entry_date.trim() === "") {
    return NextResponse.json({ error: "Missing entry_date" }, { status: 400 });
  }

  const exitPrice = num(body.exit_price);
  const exitDate =
    typeof body.exit_date === "string" && body.exit_date.trim() !== ""
      ? body.exit_date
      : null;

  let realizedPnl: number | null = null;
  let returnPct: number | null = null;
  let status: "open" | "closed" = "open";
  let exitReason: string | null = null;

  if (exitPrice !== null && exitPrice > 0) {
    realizedPnl = (exitPrice - entryPrice) * shares;
    returnPct = (exitPrice - entryPrice) / entryPrice;
    status = "closed";
    if (
      typeof body.exit_reason === "string" &&
      (ALLOWED_EXIT_REASONS as readonly string[]).includes(body.exit_reason)
    ) {
      exitReason = body.exit_reason;
    }
  }

  const insertRow = {
    swing_idea_id:
      typeof body.swing_idea_id === "string" && body.swing_idea_id.length > 0
        ? body.swing_idea_id
        : null,
    symbol,
    broker: typeof body.broker === "string" ? body.broker : null,
    shares,
    entry_price: entryPrice,
    entry_date: body.entry_date,
    exit_price: exitPrice,
    exit_date: exitDate,
    thesis: typeof body.thesis === "string" ? body.thesis : null,
    realized_pnl: realizedPnl,
    return_pct: returnPct,
    exit_reason: exitReason,
    status,
  };

  const sb = createServerClient();
  const res = await sb.from<TradeRow>("swing_trades").insert(insertRow).select().single();
  if (res.error) {
    return NextResponse.json({ error: res.error.message }, { status: 400 });
  }
  return NextResponse.json({ trade: res.data });
}

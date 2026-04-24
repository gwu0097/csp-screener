import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

const ALLOWED_TIMEFRAMES = ["1month", "3months", "6months"] as const;
const ALLOWED_SENTIMENTS = ["bullish", "bearish", "mixed", "neutral"] as const;

type IdeaRow = {
  id: string;
  symbol: string;
  catalyst: string | null;
  thesis: string | null;
  ai_summary: string | null;
  analyst_sentiment: string | null;
  analyst_target: number | null;
  forward_pe: number | null;
  week_52_low: number | null;
  week_52_high: number | null;
  price_at_discovery: number | null;
  user_thesis: string | null;
  timeframe: string | null;
  conviction: number | null;
  status: string;
  discovered_at: string;
  updated_at: string;
  created_at: string;
};

type TradeRow = {
  id: string;
  swing_idea_id: string | null;
  symbol: string;
  shares: number | null;
  entry_price: number | null;
  entry_date: string | null;
  exit_price: number | null;
  exit_date: string | null;
  realized_pnl: number | null;
  return_pct: number | null;
  exit_reason: string | null;
  status: string;
};

export async function GET() {
  const sb = createServerClient();
  const ideasRes = await sb
    .from("swing_ideas")
    .select("*")
    .order("created_at", { ascending: false });
  if (ideasRes.error) {
    return NextResponse.json({ error: ideasRes.error.message }, { status: 500 });
  }
  const ideas = (ideasRes.data ?? []) as IdeaRow[];

  // Enrich ENTERED / EXITED ideas with their linked trade data. Cards in
  // those stages need to render trade metrics (entry, exit, P&L) that
  // live in swing_trades, not in swing_ideas. Fetch all trades for the
  // set of idea ids in one query.
  const ideaIds = ideas.map((i) => i.id);
  const tradesById = new Map<string, TradeRow>();
  if (ideaIds.length > 0) {
    const tradesRes = await sb
      .from("swing_trades")
      .select(
        "id,swing_idea_id,symbol,shares,entry_price,entry_date,exit_price,exit_date,realized_pnl,return_pct,exit_reason,status",
      )
      .in("swing_idea_id", ideaIds)
      .order("created_at", { ascending: false });
    if (tradesRes.error) {
      return NextResponse.json({ error: tradesRes.error.message }, { status: 500 });
    }
    const trades = (tradesRes.data ?? []) as TradeRow[];

    // For each idea, pick the single most-relevant trade:
    //   ENTERED → latest open trade
    //   EXITED  → latest closed trade
    //   others  → any latest trade (rare, but shouldn't crash)
    // trades is already ordered created_at desc, so the first match wins.
    for (const idea of ideas) {
      if (tradesById.has(idea.id)) continue;
      const pool = trades.filter((t) => t.swing_idea_id === idea.id);
      if (pool.length === 0) continue;
      const pickStatus =
        idea.status === "entered"
          ? "open"
          : idea.status === "exited"
            ? "closed"
            : null;
      const pick = pickStatus
        ? (pool.find((t) => t.status === pickStatus) ?? pool[0])
        : pool[0];
      tradesById.set(idea.id, pick);
    }
  }

  const enriched = ideas.map((idea) => ({
    ...idea,
    active_trade: tradesById.get(idea.id) ?? null,
  }));

  return NextResponse.json({ ideas: enriched });
}

type CreateBody = {
  symbol?: unknown;
  catalyst?: unknown;
  user_thesis?: unknown;
  timeframe?: unknown;
  conviction?: unknown;
  analyst_sentiment?: unknown;
  analyst_target?: unknown;
  price_at_discovery?: unknown;
  forward_pe?: unknown;
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

  const timeframe =
    typeof body.timeframe === "string" &&
    (ALLOWED_TIMEFRAMES as readonly string[]).includes(body.timeframe)
      ? body.timeframe
      : null;

  const sentiment =
    typeof body.analyst_sentiment === "string" &&
    (ALLOWED_SENTIMENTS as readonly string[]).includes(body.analyst_sentiment)
      ? body.analyst_sentiment
      : null;

  const conviction = (() => {
    const n = num(body.conviction);
    if (n === null) return null;
    const i = Math.round(n);
    return i >= 1 && i <= 5 ? i : null;
  })();

  const insertRow = {
    symbol,
    catalyst: typeof body.catalyst === "string" ? body.catalyst : null,
    user_thesis: typeof body.user_thesis === "string" ? body.user_thesis : null,
    timeframe,
    conviction,
    analyst_sentiment: sentiment,
    analyst_target: num(body.analyst_target),
    price_at_discovery: num(body.price_at_discovery),
    forward_pe: num(body.forward_pe),
    status: "watching",
  };

  const sb = createServerClient();
  const res = await sb.from<IdeaRow>("swing_ideas").insert(insertRow).select().single();
  if (res.error) {
    return NextResponse.json({ error: res.error.message }, { status: 400 });
  }
  return NextResponse.json({ idea: res.data });
}

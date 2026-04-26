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
  exit_condition: string | null;
  timeframe: string | null;
  conviction: number | null;
  status: string;
  discovered_at: string;
  updated_at: string;
  created_at: string;
};

export async function GET() {
  const sb = createServerClient();
  const res = await sb
    .from("longterm_ideas")
    .select("*")
    .order("created_at", { ascending: false });
  if (res.error) {
    return NextResponse.json({ error: res.error.message }, { status: 500 });
  }
  return NextResponse.json({ ideas: (res.data ?? []) as IdeaRow[] });
}

type CreateBody = {
  symbol?: unknown;
  catalyst?: unknown;
  user_thesis?: unknown;
  thesis?: unknown;
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
    thesis: typeof body.thesis === "string" ? body.thesis : null,
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
  const res = await sb
    .from<IdeaRow>("longterm_ideas")
    .insert(insertRow)
    .select()
    .single();
  if (res.error) {
    return NextResponse.json({ error: res.error.message }, { status: 400 });
  }
  return NextResponse.json({ idea: res.data });
}

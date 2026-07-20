import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { batchRefreshSnapshots } from "@/lib/market-snapshot";
import { computeEntrySignal, computeSwingScore } from "@/lib/entry-signal";
import { requireUserId, authErrorResponse } from "@/lib/auth";

export const dynamic = "force-dynamic";

const ALLOWED_TIMEFRAMES = ["1month", "3months", "6months"] as const;
const ALLOWED_SENTIMENTS = ["bullish", "bearish", "mixed", "neutral"] as const;
const ALLOWED_SOURCES = ["manual", "screener_track"] as const;
const ALLOWED_SOURCE_TABS = [
  "capitulation",
  "pullback",
  "insider",
  "options_flow",
] as const;
const ALLOWED_CATALYST_CONFIDENCE = ["high", "medium", "low", "none"] as const;

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
  // Screener setup context — frozen at track time, see
  // migrations/2026-07-20-add-screener-context-to-swing-ideas.sql.
  source: string;
  source_tab: string | null;
  source_score: number | null;
  entry_price: number | null;
  target_price: number | null;
  stop_price: number | null;
  rr: number | null;
  atr14: number | null;
  tier1_signals: string[];
  tier2_signals: string[];
  red_flags: string[];
  catalyst_type: string | null;
  catalyst_confidence: string | null;
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
  let userId: string;
  try {
    userId = await requireUserId();
  } catch (e) {
    return authErrorResponse(e);
  }
  const sb = createServerClient();
  const ideasRes = await sb
    .from("swing_ideas")
    .select("*")
    .eq("user_id", userId)
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
      .eq("user_id", userId)
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

  // Market-snapshot enrichment (Phase 2): one batched, cached refresh
  // for every idea symbol, then per-idea entry signal + swing score.
  const symbols = Array.from(new Set(ideas.map((i) => i.symbol.toUpperCase())));
  const snapBySymbol = new Map<string, Awaited<ReturnType<typeof batchRefreshSnapshots>>[number]>();
  if (symbols.length > 0) {
    const snaps = await batchRefreshSnapshots(symbols, 15);
    for (const s of snaps) snapBySymbol.set(s.symbol.toUpperCase(), s);
  }

  const now = Date.now();
  const enriched = ideas.map((idea) => {
    const snapshot = snapBySymbol.get(idea.symbol.toUpperCase()) ?? null;
    const direction: "bullish" | "bearish" =
      idea.analyst_sentiment === "bearish" ? "bearish" : "bullish";
    const ageDays = idea.created_at
      ? Math.max(0, Math.round((now - Date.parse(idea.created_at)) / 86400000))
      : undefined;
    const entry_signal = snapshot
      ? computeEntrySignal(snapshot, direction)
      : null;
    const swing_score = snapshot
      ? computeSwingScore(snapshot, { stage: idea.status, direction, ageDays })
      : null;
    return {
      ...idea,
      active_trade: tradesById.get(idea.id) ?? null,
      snapshot,
      entry_signal,
      swing_score,
    };
  });

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
  // Screener setup context (all optional — omitted entirely by the
  // manual Add Idea dialog, which relies on the DB defaults).
  source?: unknown;
  source_tab?: unknown;
  source_score?: unknown;
  entry_price?: unknown;
  target_price?: unknown;
  stop_price?: unknown;
  rr?: unknown;
  atr14?: unknown;
  tier1_signals?: unknown;
  tier2_signals?: unknown;
  red_flags?: unknown;
  catalyst_type?: unknown;
  catalyst_confidence?: unknown;
};

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function strArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}

export async function POST(req: NextRequest) {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch (e) {
    return authErrorResponse(e);
  }
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

  const source =
    typeof body.source === "string" &&
    (ALLOWED_SOURCES as readonly string[]).includes(body.source)
      ? body.source
      : "manual";

  const sourceTab =
    typeof body.source_tab === "string" &&
    (ALLOWED_SOURCE_TABS as readonly string[]).includes(body.source_tab)
      ? body.source_tab
      : null;

  const catalystConfidence =
    typeof body.catalyst_confidence === "string" &&
    (ALLOWED_CATALYST_CONFIDENCE as readonly string[]).includes(
      body.catalyst_confidence,
    )
      ? body.catalyst_confidence
      : null;

  const sourceScore = (() => {
    const n = num(body.source_score);
    if (n === null) return null;
    const i = Math.round(n);
    return i >= 0 && i <= 10 ? i : null;
  })();

  const insertRow = {
    user_id: userId,
    symbol,
    catalyst: typeof body.catalyst === "string" ? body.catalyst : null,
    user_thesis: typeof body.user_thesis === "string" ? body.user_thesis : null,
    timeframe,
    conviction,
    analyst_sentiment: sentiment,
    analyst_target: num(body.analyst_target),
    price_at_discovery: num(body.price_at_discovery),
    forward_pe: num(body.forward_pe),
    status: "setup_ready",
    // Screener setup context — frozen here, never touched again after
    // insert (no PATCH path exposes these, see [id]/route.ts).
    source,
    source_tab: sourceTab,
    source_score: sourceScore,
    entry_price: num(body.entry_price),
    target_price: num(body.target_price),
    stop_price: num(body.stop_price),
    rr: num(body.rr),
    atr14: num(body.atr14),
    tier1_signals: strArray(body.tier1_signals),
    tier2_signals: strArray(body.tier2_signals),
    red_flags: strArray(body.red_flags),
    catalyst_type: typeof body.catalyst_type === "string" ? body.catalyst_type : null,
    catalyst_confidence: catalystConfidence,
  };

  const sb = createServerClient();
  const res = await sb.from<IdeaRow>("swing_ideas").insert(insertRow).select().single();
  if (res.error) {
    return NextResponse.json({ error: res.error.message }, { status: 400 });
  }
  return NextResponse.json({ idea: res.data });
}

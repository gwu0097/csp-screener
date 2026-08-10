import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { requireUserId, authErrorResponse } from "@/lib/auth";
import { insertEntryFill, type FillRow } from "@/lib/swing-trade-fills";

export const dynamic = "force-dynamic";

const DEFAULT_MAX_RISK_PCT = 0.5;

export type TradeRow = {
  id: string;
  swing_idea_id: string | null;
  symbol: string;
  broker: string | null;
  created_at: string;
  updated_at: string;
  setup_name: string | null;
  thesis: string;
  entry_date: string;
  entry_price: number;
  shares: number;
  open_shares: number;
  initial_stop: number;
  current_stop: number;
  planned_target: number | null;
  initial_risk_dollars: number;
  risk_pct_of_portfolio: number | null;
  portfolio_value_at_entry: number | null;
  risk_limit_overridden: boolean;
  atr_at_entry: number | null;
  adr_pct_at_entry: number | null;
  conviction: number | null;
  market_regime: string | null;
  exit_date: string | null;
  exit_price: number | null;
  exit_reason: string | null;
  realized_pnl: number | null;
  r_multiple: number | null;
  return_pct: number | null;
  days_held: number | null;
  max_favorable_excursion_r: number | null;
  max_adverse_excursion_r: number | null;
  price_two_weeks_after_exit: number | null;
  exit_quality_note: string | null;
  status: "open" | "closed";
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
    .from<TradeRow>("swing_trades")
    .select("*")
    .eq("user_id", userId)
    .order("entry_date", { ascending: false });
  if (res.error) {
    return NextResponse.json({ error: res.error.message }, { status: 500 });
  }
  const trades = (res.data ?? []) as TradeRow[];

  // Fills embedded per trade — a personal journal's fill volume is small
  // enough that one extra bulk query beats a lazy per-trade endpoint;
  // the UI's expandable fill history renders instantly off this.
  let fillsByTrade = new Map<string, FillRow[]>();
  if (trades.length > 0) {
    const fillsRes = await sb
      .from<FillRow>("swing_trade_fills")
      .select("*")
      .eq("user_id", userId)
      .order("fill_date", { ascending: true })
      .order("created_at", { ascending: true });
    if (!fillsRes.error) {
      const grouped = new Map<string, FillRow[]>();
      for (const f of (fillsRes.data ?? []) as FillRow[]) {
        const list = grouped.get(f.trade_id) ?? [];
        list.push(f);
        grouped.set(f.trade_id, list);
      }
      fillsByTrade = grouped;
    }
  }

  return NextResponse.json({
    trades: trades.map((t) => ({ ...t, fills: fillsByTrade.get(t.id) ?? [] })),
  });
}

type CreateBody = {
  swing_idea_id?: unknown;
  symbol?: unknown;
  broker?: unknown;
  setup_name?: unknown;
  thesis?: unknown;
  entry_date?: unknown;
  entry_price?: unknown;
  shares?: unknown;
  planned_stop?: unknown;
  planned_target?: unknown;
  portfolio_value_at_entry?: unknown;
  atr_at_entry?: unknown;
  adr_pct_at_entry?: unknown;
  conviction?: unknown;
  market_regime?: unknown;
  // Set by the client after the user has seen the risk-limit warning and
  // explicitly chosen to proceed anyway. Absent (or false) on the first
  // submit of an oversized trade — that first submit is intentionally
  // rejected with needs_confirmation so the UI can show the warning.
  confirmed_override?: unknown;
};

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
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

  const symbol = str(body.symbol)?.toUpperCase() ?? null;
  const thesis = str(body.thesis);
  const entryPrice = num(body.entry_price);
  const shares = num(body.shares);
  // Client field name stays "planned_stop" (matches the entry form's
  // "Planned stop" label) — it becomes initial_stop on write, the
  // immutable R denominator. current_stop starts equal to it and trails
  // independently from there.
  const plannedStop = num(body.planned_stop);
  const entryDate = str(body.entry_date);

  if (!symbol) return NextResponse.json({ error: "Missing symbol" }, { status: 400 });
  if (!thesis) return NextResponse.json({ error: "Thesis is required" }, { status: 400 });
  if (entryPrice === null || entryPrice <= 0) {
    return NextResponse.json({ error: "entry_price must be > 0" }, { status: 400 });
  }
  if (shares === null || shares <= 0) {
    return NextResponse.json({ error: "shares must be > 0" }, { status: 400 });
  }
  if (!entryDate) {
    return NextResponse.json({ error: "Missing entry_date" }, { status: 400 });
  }
  // The trade cannot be logged without a planned stop — without it there
  // is no R, and without R no trade is comparable to any other.
  if (plannedStop === null) {
    return NextResponse.json(
      { error: "planned_stop is required — a trade cannot be logged without one" },
      { status: 400 },
    );
  }
  if (plannedStop >= entryPrice) {
    return NextResponse.json(
      { error: "planned_stop must be below entry_price" },
      { status: 400 },
    );
  }

  const plannedTarget = num(body.planned_target);
  const initialRiskDollars = (entryPrice - plannedStop) * shares;

  const sb = createServerClient();

  // Portfolio value: prefer what the client sent (it already read the
  // setting to live-compute the risk % the user saw), fall back to the
  // stored setting so a client that omits it still gets a meaningful %.
  let portfolioValue = num(body.portfolio_value_at_entry);
  let maxRiskPct = DEFAULT_MAX_RISK_PCT;
  const settingsRes = await sb
    .from("swing_journal_settings")
    .select("max_risk_pct,portfolio_value")
    .eq("user_id", userId)
    .maybeSingle();
  const settings = settingsRes.data as
    | { max_risk_pct: number; portfolio_value: number | null }
    | null;
  if (settings) {
    maxRiskPct = settings.max_risk_pct ?? DEFAULT_MAX_RISK_PCT;
    if (portfolioValue === null) portfolioValue = settings.portfolio_value;
  }

  const riskPctOfPortfolio =
    portfolioValue !== null && portfolioValue > 0
      ? (initialRiskDollars / portfolioValue) * 100
      : null;

  const exceedsLimit = riskPctOfPortfolio !== null && riskPctOfPortfolio > maxRiskPct;
  const confirmedOverride = body.confirmed_override === true;

  if (exceedsLimit && !confirmedOverride) {
    // Not an error — a real, expected pause in the flow. The client shows
    // this as a warning and re-submits with confirmed_override: true.
    return NextResponse.json(
      {
        needs_confirmation: true,
        reason: "risk_limit_exceeded",
        risk_pct_of_portfolio: riskPctOfPortfolio,
        max_risk_pct: maxRiskPct,
        initial_risk_dollars: initialRiskDollars,
      },
      { status: 200 },
    );
  }

  const conviction = num(body.conviction);

  const insertRow = {
    user_id: userId,
    swing_idea_id:
      typeof body.swing_idea_id === "string" && body.swing_idea_id.length > 0
        ? body.swing_idea_id
        : null,
    symbol,
    broker: str(body.broker),
    setup_name: str(body.setup_name),
    thesis,
    entry_date: entryDate,
    entry_price: entryPrice,
    shares,
    open_shares: shares,
    initial_stop: plannedStop,
    current_stop: plannedStop,
    planned_target: plannedTarget,
    initial_risk_dollars: initialRiskDollars,
    risk_pct_of_portfolio: riskPctOfPortfolio,
    portfolio_value_at_entry: portfolioValue,
    risk_limit_overridden: exceedsLimit && confirmedOverride,
    atr_at_entry: num(body.atr_at_entry),
    adr_pct_at_entry: num(body.adr_pct_at_entry),
    conviction: conviction !== null ? Math.round(conviction) : null,
    market_regime: str(body.market_regime),
    status: "open" as const,
  };

  const res = await sb.from<TradeRow>("swing_trades").insert(insertRow).select().single();
  if (res.error) {
    return NextResponse.json({ error: res.error.message }, { status: 400 });
  }
  const trade = res.data as TradeRow;

  // Every position's opening buy is itself a fill — this is what FIFO
  // matching on the exit side walks against. One entry fill per position
  // today (this app has no scale-in feature), but the fill model is
  // correct if that changes later.
  await insertEntryFill(sb, trade.id, userId, {
    price: entryPrice,
    shares,
    date: entryDate,
    broker: str(body.broker),
  });

  // The list view (GET, above) is the source of embedded fills — the
  // caller reloads the full list right after a successful create, so
  // this response doesn't need to carry the just-inserted entry fill.
  return NextResponse.json({ trade });
}

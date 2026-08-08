import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { requireUserId, authErrorResponse } from "@/lib/auth";

export const dynamic = "force-dynamic";

const EXIT_REASONS = [
  "stop_hit",
  "target_hit",
  "time_stop",
  "trailing_stop",
  "discretionary_override",
] as const;

// Stock-trade shape the import pipeline feeds us (matches ParsedStockTrade
// from app/api/trades/parse-screenshot/route.ts), plus two fields the
// review table in import-stock-screenshot-modal.tsx collects that the OCR
// itself can never read off a screenshot: a broker fill has a price, not a
// plan. planned_stop (buys) and exit_reason (sells) are required here for
// the same reason they're required on the manual entry/exit forms — a
// trade without a stop has no R, and an exit without a reason can't be
// reviewed later.
type ParsedStockTrade = {
  symbol: string;
  action: "buy" | "sell";
  shares: number;
  price: number;
  date: string;
  broker?: string;
  planned_stop?: number;
  exit_reason?: string;
};

type SwingIdeaRow = { id: string; symbol: string; status: string };
type SwingTradeRow = {
  id: string;
  symbol: string;
  shares: number;
  entry_price: number;
  entry_date: string;
  planned_stop: number;
  initial_risk_dollars: number;
  status: string;
  broker: string | null;
};

function validTrade(t: unknown): ParsedStockTrade | null {
  if (!t || typeof t !== "object") return null;
  const r = t as Record<string, unknown>;
  const symbol = typeof r.symbol === "string" ? r.symbol.trim().toUpperCase() : "";
  const action = r.action === "buy" || r.action === "sell" ? r.action : null;
  const shares = Math.abs(Number(r.shares));
  const price = Number(r.price);
  const date = typeof r.date === "string" ? r.date : "";
  const broker = typeof r.broker === "string" ? r.broker : undefined;
  const plannedStop = Number(r.planned_stop);
  const exitReason =
    typeof r.exit_reason === "string" &&
    (EXIT_REASONS as readonly string[]).includes(r.exit_reason)
      ? r.exit_reason
      : undefined;
  if (!symbol || !action) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  if (!Number.isFinite(shares) || shares <= 0) return null;
  if (!Number.isFinite(price) || price <= 0) return null;
  if (action === "buy") {
    if (!Number.isFinite(plannedStop) || plannedStop <= 0 || plannedStop >= price) return null;
    return { symbol, action, shares, price, date, broker, planned_stop: plannedStop };
  }
  if (!exitReason) return null;
  return { symbol, action, shares, price, date, broker, exit_reason: exitReason };
}

function daysBetween(a: string, b: string): number {
  const start = new Date(a + "T00:00:00Z").getTime();
  const end = new Date(b + "T00:00:00Z").getTime();
  return Math.round((end - start) / (24 * 60 * 60 * 1000));
}

export async function POST(req: NextRequest) {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch (e) {
    return authErrorResponse(e);
  }
  let body: { trades?: unknown; broker?: unknown };
  try {
    body = (await req.json()) as { trades?: unknown; broker?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!Array.isArray(body.trades)) {
    return NextResponse.json({ error: "trades must be an array" }, { status: 400 });
  }
  const bodyBroker =
    typeof body.broker === "string" && body.broker.trim() ? body.broker.trim() : null;

  const rawTrades = body.trades as unknown[];
  const trades = rawTrades.map(validTrade).filter((t): t is ParsedStockTrade => t !== null);
  const invalidCount = rawTrades.length - trades.length;
  if (trades.length === 0) {
    return NextResponse.json(
      {
        error:
          invalidCount > 0
            ? "No valid trades — buy rows need a planned stop, sell rows need an exit reason"
            : "No valid trades",
      },
      { status: 400 },
    );
  }

  // Stable order: chronological, so buy → sell pairings across the same
  // import always match the earlier fill as the entry.
  trades.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const sb = createServerClient();
  const symbols = Array.from(new Set(trades.map((t) => t.symbol)));

  // Preload ideas (with status) so we can both link trades and auto-sync
  // the idea's stage as buys / sells arrive. Ideas are the "kanban card";
  // trades drive their lifecycle once a position is actually held.
  const ideasRes = await sb
    .from("swing_ideas")
    .select("id,symbol,status")
    .eq("user_id", userId)
    .in("symbol", symbols);
  if (ideasRes.error) {
    return NextResponse.json({ error: ideasRes.error.message }, { status: 500 });
  }
  const ideaBySymbol = new Map<string, { id: string; status: string }>();
  for (const i of (ideasRes.data ?? []) as SwingIdeaRow[]) {
    ideaBySymbol.set(i.symbol, { id: i.id, status: i.status });
  }

  // Preload open swing_trades for the same symbols — a sell will try to
  // close the oldest open position for that symbol.
  const openRes = await sb
    .from("swing_trades")
    .select("id,symbol,shares,entry_price,entry_date,planned_stop,initial_risk_dollars,status,broker")
    .eq("user_id", userId)
    .eq("status", "open")
    .in("symbol", symbols)
    .order("entry_date", { ascending: true });
  if (openRes.error) {
    return NextResponse.json({ error: openRes.error.message }, { status: 500 });
  }
  const openBySymbol = new Map<string, SwingTradeRow[]>();
  for (const t of (openRes.data ?? []) as SwingTradeRow[]) {
    const list = openBySymbol.get(t.symbol) ?? [];
    list.push(t);
    openBySymbol.set(t.symbol, list);
  }

  let inserted = 0;
  let closed = 0;
  let skippedOrphanSells = 0;
  let ideasPromoted = 0;
  let ideasDemoted = 0;
  let ideasCreated = 0;
  const errors: string[] = [];
  const orphanSells: Array<{ symbol: string; date: string; shares: number; price: number }> = [];

  async function ensureIdeaForBuy(symbol: string, entryPrice: number): Promise<string | null> {
    const existing = ideaBySymbol.get(symbol);
    if (existing) {
      if (existing.status === "setup_ready") {
        const upd = await sb
          .from("swing_ideas")
          .update({ status: "entered", updated_at: new Date().toISOString() })
          .eq("id", existing.id)
          .eq("user_id", userId);
        if (upd.error) {
          errors.push(`${symbol} idea promote: ${upd.error.message}`);
        } else {
          existing.status = "entered";
          ideasPromoted += 1;
        }
      }
      return existing.id;
    }

    const ins = await sb
      .from("swing_ideas")
      .insert({
        user_id: userId,
        symbol,
        status: "entered",
        price_at_discovery: entryPrice,
        user_thesis: "Auto-created from trade import",
      })
      .select()
      .single();
    if (ins.error) {
      errors.push(`${symbol} idea create: ${ins.error.message}`);
      return null;
    }
    const created = ins.data as { id: string } | null;
    if (!created) return null;
    ideaBySymbol.set(symbol, { id: created.id, status: "entered" });
    ideasCreated += 1;
    return created.id;
  }

  async function demoteIdeaOnClose(symbol: string) {
    const existing = ideaBySymbol.get(symbol);
    if (!existing || existing.status !== "entered") return;
    const upd = await sb
      .from("swing_ideas")
      .update({ status: "exited", updated_at: new Date().toISOString() })
      .eq("id", existing.id)
      .eq("user_id", userId);
    if (upd.error) {
      errors.push(`${symbol} idea demote: ${upd.error.message}`);
      return;
    }
    existing.status = "exited";
    ideasDemoted += 1;
  }

  for (const t of trades) {
    const broker = t.broker ?? bodyBroker ?? null;

    if (t.action === "buy") {
      const plannedStop = t.planned_stop as number; // guaranteed by validTrade
      const initialRiskDollars = (t.price - plannedStop) * t.shares;
      const ideaId = await ensureIdeaForBuy(t.symbol, t.price);
      const insertRow = {
        user_id: userId,
        swing_idea_id: ideaId,
        symbol: t.symbol,
        broker,
        thesis: "Imported from broker screenshot",
        entry_date: t.date,
        entry_price: t.price,
        shares: t.shares,
        planned_stop: plannedStop,
        initial_risk_dollars: initialRiskDollars,
        status: "open",
      };
      const ins = await sb.from("swing_trades").insert(insertRow).select().single();
      if (ins.error) {
        errors.push(`${t.symbol} buy @ ${t.date}: ${ins.error.message}`);
        continue;
      }
      const list = openBySymbol.get(t.symbol) ?? [];
      if (ins.data) list.push(ins.data as SwingTradeRow);
      openBySymbol.set(t.symbol, list);
      inserted += 1;
      continue;
    }

    // action === "sell" — try to match the oldest open buy.
    const candidates = openBySymbol.get(t.symbol) ?? [];
    const match = candidates.shift();
    if (match) {
      const realizedPnl = (t.price - match.entry_price) * match.shares;
      const rMultiple =
        match.initial_risk_dollars > 0 ? realizedPnl / match.initial_risk_dollars : null;
      const returnPct = match.entry_price > 0 ? (t.price - match.entry_price) / match.entry_price : null;
      const upd = await sb
        .from("swing_trades")
        .update({
          exit_price: t.price,
          exit_date: t.date,
          exit_reason: t.exit_reason,
          realized_pnl: realizedPnl,
          r_multiple: rMultiple,
          return_pct: returnPct,
          days_held: daysBetween(match.entry_date, t.date),
          status: "closed",
          updated_at: new Date().toISOString(),
        })
        .eq("id", match.id)
        .eq("user_id", userId)
        .select()
        .single();
      if (upd.error) {
        errors.push(`${t.symbol} sell @ ${t.date}: ${upd.error.message}`);
        candidates.unshift(match);
        continue;
      }
      openBySymbol.set(t.symbol, candidates);
      closed += 1;
      if (candidates.length === 0) {
        await demoteIdeaOnClose(t.symbol);
      }
      continue;
    }

    // No open buy to close against. Unlike the prior version of this
    // route, we do NOT insert a stopless "trade" here — planned_stop and
    // entry_price are both required (NOT NULL) on swing_trades now, and
    // there is no plan to attach to a fill whose entry was never logged
    // in this journal. Reported back so the user can log the original
    // entry (with a stop) manually first.
    skippedOrphanSells += 1;
    orphanSells.push({ symbol: t.symbol, date: t.date, shares: t.shares, price: t.price });
  }

  return NextResponse.json({
    inserted,
    closed,
    skipped_orphan_sells: skippedOrphanSells,
    orphan_sells: orphanSells,
    total: inserted + closed,
    ideas_promoted: ideasPromoted,
    ideas_demoted: ideasDemoted,
    ideas_created: ideasCreated,
    invalid_rows: invalidCount,
    errors,
  });
}

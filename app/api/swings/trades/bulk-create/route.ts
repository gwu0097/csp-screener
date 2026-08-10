import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { requireUserId, authErrorResponse } from "@/lib/auth";
import { insertEntryFill, applySellAcrossPositions, recordOrphanSell } from "@/lib/swing-trade-fills";

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

  // Stable order: chronological, buys before sells on the same date. A
  // same-day scale-in-then-trim (or open-then-close) must see the buy
  // applied first — sorting on date alone leaves same-day ordering to
  // whatever order the screenshot happened to list rows in, and a sell
  // processed first would find no position yet and become a spurious
  // orphan.
  trades.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    if (a.action !== b.action) return a.action === "buy" ? -1 : 1;
    return 0;
  });

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

  let inserted = 0;
  let fullyClosedPositions = 0;
  let partialCloses = 0;
  let skippedOrphanSells = 0;
  let ideasPromoted = 0;
  let ideasDemoted = 0;
  let ideasCreated = 0;
  const errors: string[] = [];
  const orphanSells: Array<{ id: string; symbol: string; date: string; shares: number; price: number }> = [];

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
    // Re-derived from the DB rather than an in-memory decrement — the
    // matcher (lib/swing-trade-fills.ts) is itself fills-derived, so the
    // idea-demotion signal should be too: still-open positions for this
    // symbol mean the idea stays ENTERED.
    const stillOpenRes = await sb
      .from("swing_trades")
      .select("id")
      .eq("user_id", userId)
      .eq("symbol", symbol)
      .eq("status", "open")
      .limit(1);
    const stillOpen = (stillOpenRes.data ?? []).length > 0;
    if (stillOpen) return;
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
        open_shares: t.shares,
        initial_stop: plannedStop,
        current_stop: plannedStop,
        initial_risk_dollars: initialRiskDollars,
        status: "open",
      };
      const ins = await sb.from("swing_trades").insert(insertRow).select().single();
      if (ins.error) {
        errors.push(`${t.symbol} buy @ ${t.date}: ${ins.error.message}`);
        continue;
      }
      const insertedTrade = ins.data as { id: string } | null;
      if (insertedTrade) {
        await insertEntryFill(sb, insertedTrade.id, userId, {
          price: t.price,
          shares: t.shares,
          date: t.date,
          broker,
        });
      }
      inserted += 1;
      continue;
    }

    // action === "sell" — FIFO across every open position for this
    // symbol, oldest entry first, spilling into the next open position
    // once one is fully consumed. Any leftover after every open position
    // is exhausted is a genuine oversell relative to everything
    // currently held for this symbol — persisted for review, not
    // dropped.
    const result = await applySellAcrossPositions(sb, userId, t.symbol, {
      shares: t.shares,
      price: t.price,
      date: t.date,
      exitReason: t.exit_reason as string,
      broker,
    });
    for (const e of result.errors) errors.push(e);
    for (const f of result.filledTrades) {
      // A fill that didn't fully consume the position it was matched
      // against (checked via the still-open query in demoteIdeaOnClose
      // below) is a partial close; otherwise it's a full close. We don't
      // know which without asking, so just count fills applied and let
      // demoteIdeaOnClose's still-open check drive idea lifecycle —
      // partial vs. full is reported per-fill via a follow-up query.
      const stillOpenRes = await sb.from("swing_trades").select("status").eq("id", f.tradeId).maybeSingle();
      const status = (stillOpenRes.data as { status?: string } | null)?.status;
      if (status === "closed") fullyClosedPositions += 1;
      else partialCloses += 1;
    }
    if (result.filledTrades.length > 0) {
      await demoteIdeaOnClose(t.symbol);
    }
    if (result.remainderShares > 0) {
      const rec = await recordOrphanSell(sb, userId, {
        symbol: t.symbol,
        date: t.date,
        shares: result.remainderShares,
        price: t.price,
        exitReason: t.exit_reason ?? null,
        broker,
        source: "import",
      });
      skippedOrphanSells += 1;
      const created = rec.data as { id: string } | null;
      orphanSells.push({
        id: created?.id ?? "",
        symbol: t.symbol,
        date: t.date,
        shares: result.remainderShares,
        price: t.price,
      });
    }
  }

  return NextResponse.json({
    inserted,
    closed: fullyClosedPositions,
    partial_closes: partialCloses,
    skipped_orphan_sells: skippedOrphanSells,
    orphan_sells: orphanSells,
    total: inserted + fullyClosedPositions + partialCloses,
    ideas_promoted: ideasPromoted,
    ideas_demoted: ideasDemoted,
    ideas_created: ideasCreated,
    invalid_rows: invalidCount,
    errors,
  });
}

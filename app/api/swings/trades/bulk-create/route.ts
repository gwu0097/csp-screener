import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

// Stock-trade shape that the import pipeline feeds us (matches
// ParsedStockTrade from app/api/trades/parse-screenshot/route.ts).
type ParsedStockTrade = {
  symbol: string;
  action: "buy" | "sell";
  shares: number;
  price: number;
  date: string;
  broker?: string;
};

type SwingIdeaRow = { id: string; symbol: string };
type SwingTradeRow = {
  id: string;
  symbol: string;
  shares: number | null;
  entry_price: number | null;
  entry_date: string | null;
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
  if (!symbol || !action) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  if (!Number.isFinite(shares) || shares <= 0) return null;
  if (!Number.isFinite(price) || price <= 0) return null;
  return { symbol, action, shares, price, date, broker };
}

export async function POST(req: NextRequest) {
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

  const trades = (body.trades as unknown[])
    .map(validTrade)
    .filter((t): t is ParsedStockTrade => t !== null);
  if (trades.length === 0) {
    return NextResponse.json({ error: "No valid trades" }, { status: 400 });
  }

  // Stable order: chronological, so buy → sell pairings across the same
  // import always match the earlier fill as the entry.
  trades.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const sb = createServerClient();

  const symbols = Array.from(new Set(trades.map((t) => t.symbol)));

  // Preload ideas for all symbols so buys can get linked without N round-trips.
  const ideasRes = await sb
    .from("swing_ideas")
    .select("id,symbol")
    .in("symbol", symbols);
  if (ideasRes.error) {
    return NextResponse.json({ error: ideasRes.error.message }, { status: 500 });
  }
  const ideaBySymbol = new Map<string, string>();
  for (const i of (ideasRes.data ?? []) as SwingIdeaRow[]) {
    // If multiple ideas per symbol, last one wins — good enough for Phase 1.
    ideaBySymbol.set(i.symbol, i.id);
  }

  // Preload open swing_trades for the same symbols — a sell will try to
  // close the oldest open position for that symbol.
  const openRes = await sb
    .from("swing_trades")
    .select("id,symbol,shares,entry_price,entry_date,status,broker")
    .eq("status", "open")
    .in("symbol", symbols)
    .order("entry_date", { ascending: true });
  if (openRes.error) {
    return NextResponse.json({ error: openRes.error.message }, { status: 500 });
  }
  // Group by symbol, oldest-first — we pop from the head when matching sells.
  const openBySymbol = new Map<string, SwingTradeRow[]>();
  for (const t of (openRes.data ?? []) as SwingTradeRow[]) {
    const list = openBySymbol.get(t.symbol) ?? [];
    list.push(t);
    openBySymbol.set(t.symbol, list);
  }

  let inserted = 0;
  let closed = 0;
  let orphaned = 0; // sells with no matching open buy
  const errors: string[] = [];

  for (const t of trades) {
    const broker = t.broker ?? bodyBroker ?? null;

    if (t.action === "buy") {
      const insertRow = {
        swing_idea_id: ideaBySymbol.get(t.symbol) ?? null,
        symbol: t.symbol,
        broker,
        shares: t.shares,
        entry_price: t.price,
        entry_date: t.date,
        thesis: null,
        realized_pnl: null,
        return_pct: null,
        exit_reason: null,
        status: "open",
      };
      const ins = await sb.from("swing_trades").insert(insertRow).select().single();
      if (ins.error) {
        errors.push(`${t.symbol} buy @ ${t.date}: ${ins.error.message}`);
        continue;
      }
      // Make this new open trade available for any later sell in the same import.
      const list = openBySymbol.get(t.symbol) ?? [];
      if (ins.data) list.push(ins.data as SwingTradeRow);
      openBySymbol.set(t.symbol, list);
      inserted += 1;
      continue;
    }

    // action === "sell" — try to match the oldest open buy.
    const candidates = openBySymbol.get(t.symbol) ?? [];
    const match = candidates.shift();
    if (match && match.entry_price !== null && match.shares !== null) {
      const realizedPnl = (t.price - match.entry_price) * match.shares;
      const returnPct = (t.price - match.entry_price) / match.entry_price;
      const upd = await sb
        .from("swing_trades")
        .update({
          exit_price: t.price,
          exit_date: t.date,
          realized_pnl: realizedPnl,
          return_pct: returnPct,
          exit_reason: "manual",
          status: "closed",
          updated_at: new Date().toISOString(),
        })
        .eq("id", match.id)
        .select()
        .single();
      if (upd.error) {
        errors.push(`${t.symbol} sell @ ${t.date}: ${upd.error.message}`);
        // Put the match back since the update failed.
        candidates.unshift(match);
        continue;
      }
      openBySymbol.set(t.symbol, candidates);
      closed += 1;
      continue;
    }

    // No open buy to close against — record as a closed trade with only
    // exit data. Avoids dropping history when the import is partial.
    const orphanRow = {
      swing_idea_id: ideaBySymbol.get(t.symbol) ?? null,
      symbol: t.symbol,
      broker,
      shares: t.shares,
      entry_price: null,
      entry_date: null,
      exit_price: t.price,
      exit_date: t.date,
      realized_pnl: null,
      return_pct: null,
      thesis: null,
      exit_reason: "manual",
      status: "closed",
    };
    const ins = await sb.from("swing_trades").insert(orphanRow).select().single();
    if (ins.error) {
      errors.push(`${t.symbol} sell @ ${t.date} (orphan): ${ins.error.message}`);
      continue;
    }
    orphaned += 1;
  }

  return NextResponse.json({
    inserted,
    closed,
    orphaned,
    total: inserted + closed + orphaned,
    errors,
  });
}

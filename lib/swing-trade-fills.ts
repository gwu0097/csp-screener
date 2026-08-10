// Swing journal fill-level matching. swing_trades holds the position and
// its plan (entry, INITIAL stop, target, thesis); swing_trade_fills holds
// every entry and exit with its own price, date, quantity, and reason —
// see migrations/2026-08-16-swing-trade-fills.sql for the full rationale.
//
// Every position-level rollup column on swing_trades (open_shares,
// realized_pnl, r_multiple, return_pct, exit_date/price/reason,
// days_held, status) is a CACHE, always recomputed from the complete
// fill set — never trusted or written as an independent source of
// truth. That's what makes this self-healing: if a position-row update
// fails right after its fill wrote successfully, the next call still
// derives open shares from the real fills (not the stale cached column),
// so the failure can't corrupt subsequent matching — it just gets
// repaired on the next write.
import type { RestClient } from "./supabase";

export type FillType = "entry" | "exit";

export type FillRow = {
  id: string;
  trade_id: string;
  user_id: string;
  fill_type: FillType;
  fill_date: string;
  price: number;
  shares: number;
  broker: string | null;
  exit_reason: string | null;
  realized_pnl: number | null;
  r_multiple: number | null;
  return_pct: number | null;
  cost_basis: number | null;
  created_at: string;
};

// The subset of swing_trades fields the matcher needs. Callers already
// have most of this from their own query — passed in rather than
// re-fetched, except recomputeTradeRollup, which always re-fetches the
// fixed fields itself so it's safely callable from anywhere.
export type TradeCore = {
  id: string;
  user_id: string;
  entry_date: string;
  initial_risk_dollars: number;
};

function daysBetween(a: string, b: string): number {
  const start = new Date(a + "T00:00:00Z").getTime();
  const end = new Date(b + "T00:00:00Z").getTime();
  return Math.round((end - start) / (24 * 60 * 60 * 1000));
}

async function loadFills(sb: RestClient, tradeId: string): Promise<FillRow[]> {
  const res = await sb
    .from<FillRow>("swing_trade_fills")
    .select("*")
    .eq("trade_id", tradeId)
    .order("fill_date", { ascending: true })
    .order("created_at", { ascending: true });
  return (res.data ?? []) as FillRow[];
}

// Entry shares minus exit shares, derived fresh from the fill rows
// themselves every time — never from swing_trades.open_shares, which is
// a display cache that can lag a failed write.
function openSharesFromFills(fills: FillRow[]): number {
  let entry = 0;
  let exit = 0;
  for (const f of fills) {
    if (f.fill_type === "entry") entry += f.shares;
    else exit += f.shares;
  }
  return entry - exit;
}

// FIFO-consumes entry fills (oldest fill_date/created_at first) by
// replaying every prior exit fill's allocation in memory, then returns
// each entry fill's currently-remaining quantity. No allocation table is
// persisted — this is fully deterministic from the ordered fill rows, so
// recomputing it is cheap and can never drift from the fills themselves.
function remainingEntryCapacity(fills: FillRow[]): Map<string, number> {
  const entryFills = fills
    .filter((f) => f.fill_type === "entry")
    .sort((a, b) => (a.fill_date < b.fill_date ? -1 : a.fill_date > b.fill_date ? 1 : a.created_at < b.created_at ? -1 : 1));
  const exitFills = fills
    .filter((f) => f.fill_type === "exit")
    .sort((a, b) => (a.fill_date < b.fill_date ? -1 : a.fill_date > b.fill_date ? 1 : a.created_at < b.created_at ? -1 : 1));

  const remaining = new Map<string, number>(entryFills.map((e) => [e.id, e.shares]));
  for (const ex of exitFills) {
    let need = ex.shares;
    for (const en of entryFills) {
      if (need <= 0) break;
      const avail = remaining.get(en.id) ?? 0;
      if (avail <= 0) continue;
      const take = Math.min(avail, need);
      remaining.set(en.id, avail - take);
      need -= take;
    }
  }
  return remaining;
}

export async function insertEntryFill(
  sb: RestClient,
  tradeId: string,
  userId: string,
  opts: { price: number; shares: number; date: string; broker: string | null },
): Promise<void> {
  await sb.from("swing_trade_fills").insert({
    trade_id: tradeId,
    user_id: userId,
    fill_type: "entry",
    fill_date: opts.date,
    price: opts.price,
    shares: opts.shares,
    broker: opts.broker,
  });
}

// Recomputes every derived column on swing_trades from its complete fill
// set. Called after every exit fill write — including on a fresh call
// with no prior state assumed, so a partial failure earlier in the same
// logical operation self-heals here rather than compounding.
export async function recomputeTradeRollup(
  sb: RestClient,
  tradeId: string,
  userId: string,
): Promise<{ data: unknown; error: { message: string } | null }> {
  const tradeRes = await sb
    .from<{ entry_date: string }>("swing_trades")
    .select("entry_date")
    .eq("id", tradeId)
    .eq("user_id", userId)
    .maybeSingle();
  if (tradeRes.error || !tradeRes.data) {
    return { data: null, error: tradeRes.error ?? { message: "trade not found" } };
  }
  const { entry_date: entryDate } = tradeRes.data;

  const fills = await loadFills(sb, tradeId);
  const exitFills = fills
    .filter((f) => f.fill_type === "exit")
    .sort((a, b) => (a.fill_date < b.fill_date ? -1 : a.fill_date > b.fill_date ? 1 : a.created_at < b.created_at ? -1 : 1));

  const openShares = openSharesFromFills(fills);
  const hasExits = exitFills.length > 0;
  const realizedPnl = hasExits ? exitFills.reduce((s, f) => s + (f.realized_pnl ?? 0), 0) : null;
  const rMultiple = hasExits ? exitFills.reduce((s, f) => s + (f.r_multiple ?? 0), 0) : null;
  const costBasisDollars = hasExits
    ? exitFills.reduce((s, f) => s + (f.cost_basis ?? 0) * f.shares, 0)
    : null;
  const returnPct =
    hasExits && costBasisDollars !== null && costBasisDollars > 0
      ? ((realizedPnl as number) / costBasisDollars)
      : null;

  const last = hasExits ? exitFills[exitFills.length - 1] : null;
  const status = openShares <= 1e-9 ? "closed" : "open";

  const patch = {
    open_shares: Math.max(0, openShares),
    realized_pnl: realizedPnl,
    r_multiple: rMultiple,
    return_pct: returnPct,
    exit_date: last?.fill_date ?? null,
    exit_price: last?.price ?? null,
    exit_reason: last?.exit_reason ?? null,
    days_held: status === "closed" && last ? daysBetween(entryDate, last.fill_date) : null,
    status,
    updated_at: new Date().toISOString(),
  };

  const res = await sb
    .from("swing_trades")
    .update(patch)
    .eq("id", tradeId)
    .eq("user_id", userId)
    .select()
    .single();
  if (res.error) return { data: null, error: res.error };
  return { data: res.data, error: null };
}

export type ExitResult =
  | { ok: true; fill: FillRow; trade: unknown }
  | { ok: false; error: string };

// FIFO-matches `opts.shares` of an exit against trade.id's entry fills
// (oldest first), computing this fill's own realized P&L and cost basis
// from the allocation, then recomputes every position-level rollup from
// the complete fill set. Capacity is validated against fills-derived
// open shares, not swing_trades.open_shares — see module comment.
export async function recordExitFill(
  sb: RestClient,
  trade: TradeCore,
  opts: { shares: number; price: number; date: string; exitReason: string; broker: string | null },
): Promise<ExitResult> {
  if (!(opts.shares > 0)) return { ok: false, error: "shares must be > 0" };
  if (!(opts.price > 0)) return { ok: false, error: "price must be > 0" };

  const fills = await loadFills(sb, trade.id);
  const openShares = openSharesFromFills(fills);
  if (opts.shares > openShares + 1e-9) {
    return {
      ok: false,
      error: `Cannot sell ${opts.shares} shares — only ${openShares} open`,
    };
  }

  const entryFills = fills
    .filter((f) => f.fill_type === "entry")
    .sort((a, b) => (a.fill_date < b.fill_date ? -1 : a.fill_date > b.fill_date ? 1 : a.created_at < b.created_at ? -1 : 1));
  const remaining = remainingEntryCapacity(fills);

  let need = opts.shares;
  let pnl = 0;
  let costBasisDollars = 0;
  for (const en of entryFills) {
    if (need <= 0) break;
    const avail = remaining.get(en.id) ?? 0;
    if (avail <= 0) continue;
    const take = Math.min(avail, need);
    pnl += (opts.price - en.price) * take;
    costBasisDollars += en.price * take;
    need -= take;
  }
  if (need > 1e-9) {
    // Shouldn't happen — openShares was just derived from the same fill
    // set — but surfaced explicitly rather than silently under-filling.
    return { ok: false, error: "FIFO allocation could not cover the full requested shares" };
  }

  const costBasis = costBasisDollars / opts.shares;
  const rMultiple = trade.initial_risk_dollars > 0 ? pnl / trade.initial_risk_dollars : null;
  const returnPct = costBasis > 0 ? (opts.price - costBasis) / costBasis : null;

  const ins = await sb
    .from<FillRow>("swing_trade_fills")
    .insert({
      trade_id: trade.id,
      user_id: trade.user_id,
      fill_type: "exit",
      fill_date: opts.date,
      price: opts.price,
      shares: opts.shares,
      exit_reason: opts.exitReason,
      realized_pnl: pnl,
      r_multiple: rMultiple,
      return_pct: returnPct,
      cost_basis: costBasis,
      broker: opts.broker,
    })
    .select()
    .single();
  if (ins.error || !ins.data) {
    return { ok: false, error: ins.error?.message ?? "insert failed" };
  }

  const rollup = await recomputeTradeRollup(sb, trade.id, trade.user_id);
  if (rollup.error) {
    // The fill itself is durably written — the position row just hasn't
    // caught up yet. The next write to this trade re-derives everything
    // from fills and repairs it (see module comment), so this is
    // reported but not fatal to the caller's overall result.
    console.warn(`[swing-trade-fills] rollup failed for trade ${trade.id}: ${rollup.error.message}`);
  }

  return { ok: true, fill: ins.data as FillRow, trade: rollup.data };
}

export async function recordOrphanSell(
  sb: RestClient,
  userId: string,
  opts: {
    symbol: string;
    date: string;
    shares: number;
    price: number;
    exitReason: string | null;
    broker: string | null;
    source?: string;
  },
): Promise<{ data: unknown; error: { message: string } | null }> {
  const res = await sb
    .from("swing_trade_orphan_sells")
    .insert({
      user_id: userId,
      symbol: opts.symbol,
      fill_date: opts.date,
      price: opts.price,
      shares: opts.shares,
      exit_reason: opts.exitReason,
      broker: opts.broker,
      source: opts.source ?? "import",
    })
    .select()
    .single();
  return { data: res.data, error: res.error };
}

type OpenPositionRow = TradeCore & { entry_date: string };

// Cross-position FIFO for the import path: a sell for `symbol` is
// applied against every open position for that symbol, oldest
// entry_date first, spilling into the next position once one is fully
// consumed. Whatever's left after every open position is exhausted is
// the caller's job to persist via recordOrphanSell — a genuine oversell
// relative to everything currently held, not a bug to silently drop.
export async function applySellAcrossPositions(
  sb: RestClient,
  userId: string,
  symbol: string,
  opts: { shares: number; price: number; date: string; exitReason: string; broker: string | null },
): Promise<{ filledTrades: Array<{ tradeId: string; shares: number }>; remainderShares: number; errors: string[] }> {
  const openRes = await sb
    .from<OpenPositionRow>("swing_trades")
    .select("id,user_id,entry_date,initial_risk_dollars")
    .eq("user_id", userId)
    .eq("symbol", symbol)
    .eq("status", "open")
    .order("entry_date", { ascending: true });
  const positions = (openRes.data ?? []) as OpenPositionRow[];

  let remaining = opts.shares;
  const filledTrades: Array<{ tradeId: string; shares: number }> = [];
  const errors: string[] = [];

  for (const pos of positions) {
    if (remaining <= 1e-9) break;
    const fills = await loadFills(sb, pos.id);
    const posOpen = openSharesFromFills(fills);
    if (posOpen <= 1e-9) continue;
    const take = Math.min(posOpen, remaining);
    const res = await recordExitFill(sb, pos, {
      shares: take,
      price: opts.price,
      date: opts.date,
      exitReason: opts.exitReason,
      broker: opts.broker,
    });
    if (!res.ok) {
      errors.push(`${symbol} exit against ${pos.id}: ${res.error}`);
      continue;
    }
    filledTrades.push({ tradeId: pos.id, shares: take });
    remaining -= take;
  }

  return { filledTrades, remainderShares: Math.max(0, remaining), errors };
}

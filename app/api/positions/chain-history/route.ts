import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { requireUserId, authErrorResponse } from "@/lib/auth";
import { safetyNumerator } from "@/lib/positions";
import { getHistoricalPrices } from "@/lib/yahoo";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// GET /api/positions/chain-history?symbol=SYM
//
// The caller's campaign history on one ticker, one row per trade chain
// (lib/trade-chains classification), for the screener History tab.
// Chain P&L includes assignment stock legs — the whole point: "last
// time I traded ZS I lost $2,859 on a recovery play" must be visible
// at the point of decision.
//
// Strike/EM/closest-approach context (2026-08-11): "expired worthless"
// reads identically for a trade that never came within 15% of its
// strike and one that finished a dollar OTM. All context here is keyed
// off the campaign's FIRST-opened option leg (the entry decision the
// strike rule was actually built on) — a rolled chain's later legs can
// land at different strikes, shown separately in `strike` when they
// differ, but spot/EM/x-EM stay anchored to entry.

type Row = {
  id: string;
  strike: number;
  expiry: string;
  status: string;
  position_type: string | null;
  option_type: "put" | "call" | null;
  opened_date: string;
  closed_date: string | null;
  realized_pnl: number | null;
  total_contracts: number | null;
  trade_chain_id: string | null;
  trade_type: string | null;
  chain_pnl: number | null;
  peak_capital: number | null;
  entry_stock_price: number | null;
  entry_em_pct: number | null;
  earnings_history_id: string | null;
};

type EarningsRow = {
  id: string;
  earnings_date: string;
  implied_move_pct: number | null;
  actual_move_pct: number | null;
  move_ratio: number | null;
};

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function GET(req: NextRequest) {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch (e) {
    return authErrorResponse(e);
  }
  const symbol = (req.nextUrl.searchParams.get("symbol") ?? "").trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(symbol)) {
    return NextResponse.json({ error: "Invalid symbol" }, { status: 400 });
  }

  const sb = createServerClient();
  const res = await sb
    .from("positions")
    .select(
      "id,strike,expiry,status,position_type,option_type,opened_date,closed_date,realized_pnl,total_contracts,trade_chain_id,trade_type,chain_pnl,peak_capital,entry_stock_price,entry_em_pct,earnings_history_id",
    )
    .eq("user_id", userId)
    .eq("symbol", symbol);
  if (res.error) {
    return NextResponse.json({ error: res.error.message }, { status: 500 });
  }
  const rows = (res.data ?? []) as Row[];

  // Earnings context for the join below — fetched once for the whole
  // symbol (this route is always scoped to one ticker) rather than
  // per-campaign. Covers both the FK path (positions.earnings_history_id,
  // stamped when the calendar was available at entry/T0 time) and a
  // range-match fallback for older positions where it was never
  // stamped — same +/-window lookup lib/entry-context.ts's
  // linkEarningsEvent already uses, just read-only here.
  const ehRes = await sb
    .from("earnings_history")
    .select("id,earnings_date,implied_move_pct,actual_move_pct,move_ratio")
    .eq("symbol", symbol);
  const earningsRows = (ehRes.data ?? []) as EarningsRow[];
  const earningsById = new Map(earningsRows.map((r) => [r.id, r]));

  function findEarningsRowByDateRange(lo: string, hi: string): EarningsRow | null {
    const matches = earningsRows
      .filter((r) => r.earnings_date >= lo && r.earnings_date <= hi)
      .sort((a, b) => a.earnings_date.localeCompare(b.earnings_date));
    return matches[0] ?? null;
  }

  type Agg = {
    members: Row[];
    type: string;
    chainPnl: number | null;
    peakCapital: number | null;
  };
  const byChain = new Map<string, Agg>();
  for (const r of rows) {
    const isStock = r.position_type === "stock_long" || r.position_type === "stock_short";
    // Orphan stock lots (no chain) aren't campaigns on their own.
    if (isStock && !r.trade_chain_id) continue;
    const key = r.trade_chain_id ?? `solo:${r.id}`;
    const agg = byChain.get(key) ?? {
      members: [],
      type: r.trade_type ?? "clean",
      chainPnl: null,
      peakCapital: null,
    };
    agg.members.push(r);
    if (r.trade_type) agg.type = r.trade_type;
    if (r.chain_pnl !== null) agg.chainPnl = Number(r.chain_pnl);
    if (r.peak_capital !== null) agg.peakCapital = Number(r.peak_capital);
    byChain.set(key, agg);
  }

  const today = todayIso();

  // Widest hold window across every campaign — one Yahoo history call
  // for the whole symbol, sliced per-campaign below, instead of one
  // call per campaign.
  let fetchLo: string | null = null;
  let fetchHi: string | null = null;
  for (const r of rows) {
    if (fetchLo === null || r.opened_date < fetchLo) fetchLo = r.opened_date;
    const hi = r.closed_date ?? today;
    if (fetchHi === null || hi > fetchHi) fetchHi = hi;
  }
  // +1 day on the end bound — Yahoo's period2 is exclusive, same
  // padding lib/entry-context.ts's historicalCloseOnOrBefore uses, so
  // fetchHi's own bar isn't silently dropped.
  const dailyBars =
    fetchLo !== null && fetchHi !== null
      ? await getHistoricalPrices(
          symbol,
          new Date(fetchLo + "T00:00:00Z"),
          new Date(new Date(fetchHi + "T00:00:00Z").getTime() + 86_400_000),
        ).catch(() => [])
      : [];

  const campaigns = Array.from(byChain.values()).map((agg) => {
    const options = agg.members.filter(
      (m) => m.position_type !== "stock_long" && m.position_type !== "stock_short",
    );
    const stocks = agg.members.filter(
      (m) => m.position_type === "stock_long" || m.position_type === "stock_short",
    );
    const start = agg.members.map((m) => m.opened_date).sort()[0];
    const stillOpen = agg.members.some((m) => m.status === "open");
    const end = stillOpen
      ? null
      : agg.members.map((m) => m.closed_date ?? m.opened_date).sort().pop() ?? null;
    const pnl =
      agg.chainPnl ??
      Math.round(agg.members.reduce((s, m) => s + Number(m.realized_pnl ?? 0), 0) * 100) /
        100;
    const roc =
      agg.peakCapital !== null && agg.peakCapital > 0
        ? (pnl / agg.peakCapital) * 100
        : null;
    const contracts = options.reduce((s, m) => s + Number(m.total_contracts ?? 0), 0);
    const assignedCount = options.filter((m) => m.status === "assigned").length;
    const expiredCount = options.filter((m) => m.status === "expired_worthless").length;
    const noteBits: string[] = [];
    if (options.length > 1) noteBits.push(`${options.length} legs`);
    if (assignedCount > 0)
      noteBits.push(`assigned${assignedCount > 1 ? ` ×${assignedCount}` : ""}`);
    if (expiredCount > 0)
      noteBits.push(`expired worthless${expiredCount > 1 ? ` ×${expiredCount}` : ""}`);
    if (stocks.length > 0) noteBits.push("incl. stock lots");
    if (stillOpen) noteBits.push("still open");

    // Entry context anchored to the first-opened option leg — the
    // strike rule was built at that decision; later rolled legs can
    // land at different strikes (shown in `strike` below) but don't
    // change what "the rule" originally priced in.
    const sortedOptions = options.slice().sort((a, b) => a.opened_date.localeCompare(b.opened_date));
    const anchor = sortedOptions[0] ?? null;
    const distinctStrikes = Array.from(new Set(sortedOptions.map((m) => m.strike)));
    const strike = anchor?.strike ?? null;
    // Only set when the chain rolled to a different strike — the
    // common (unrolled) case leaves this null so the client just shows
    // `strike` alone instead of a redundant single-value arrow chain.
    const rolledStrikes = distinctStrikes.length > 1 ? distinctStrikes : null;

    const optionType: "put" | "call" = anchor?.option_type ?? "put";
    const entrySpot = anchor?.entry_stock_price ?? null;
    const entryEmPct = anchor?.entry_em_pct ?? null;
    const pctBelowSpot =
      anchor && entrySpot !== null && entrySpot > 0
        ? (safetyNumerator(entrySpot, anchor.strike, optionType) / entrySpot) * 100
        : null;
    const xEmAtEntry =
      pctBelowSpot !== null && entryEmPct !== null && entryEmPct > 0
        ? pctBelowSpot / 100 / entryEmPct
        : null;

    // Earnings-event join: FK first, then a range match across the
    // whole chain's hold window (earliest open -> latest expiry among
    // its option legs) for older positions never stamped.
    let earningsRow: EarningsRow | null = null;
    for (const m of options) {
      if (m.earnings_history_id) {
        const hit = earningsById.get(m.earnings_history_id);
        if (hit) {
          earningsRow = hit;
          break;
        }
      }
    }
    if (!earningsRow && options.length > 0) {
      const lo = options.map((m) => m.opened_date).sort()[0];
      const hi = options.map((m) => m.expiry).sort().pop()!;
      earningsRow = findEarningsRowByDateRange(lo, hi);
    }

    // Closest approach: the worst (smallest, most-negative-if-breached)
    // daily cushion between the underlying and the anchor strike across
    // the hold, using each day's low for puts / high for calls (no
    // intraday price series is stored anywhere in this app — this is
    // the daily-bar floor, not a true intraday low).
    let closestApproachPct: number | null = null;
    if (anchor) {
      const holdLo = start;
      const holdHi = end ?? today;
      const anchorStrike = anchor.strike;
      let worst: number | null = null;
      for (const bar of dailyBars) {
        const iso = bar.date.toISOString().slice(0, 10);
        if (iso < holdLo || iso > holdHi) continue;
        const extreme = optionType === "call" ? bar.high : bar.low;
        const cushion = safetyNumerator(extreme, anchorStrike, optionType);
        if (worst === null || cushion < worst) worst = cushion;
      }
      closestApproachPct = worst !== null ? (worst / anchorStrike) * 100 : null;
    }

    return {
      start,
      end,
      trade_type: agg.type,
      contracts,
      pnl,
      roc,
      peak_capital: agg.peakCapital,
      notes: noteBits.join(", ") || "single clean leg",
      still_open: stillOpen,
      strike,
      rolled_strikes: rolledStrikes,
      entry_spot: entrySpot,
      pct_below_spot: pctBelowSpot,
      x_em_entry: xEmAtEntry,
      implied_move_pct: earningsRow?.implied_move_pct ?? null,
      actual_move_pct: earningsRow?.actual_move_pct ?? null,
      move_ratio: earningsRow?.move_ratio ?? null,
      closest_approach_pct: closestApproachPct,
    };
  });
  campaigns.sort((a, b) => (b.start ?? "").localeCompare(a.start ?? ""));

  return NextResponse.json({ symbol, campaigns });
}

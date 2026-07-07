import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { requireUserId, authErrorResponse } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// GET /api/positions/chain-history?symbol=SYM
//
// The caller's campaign history on one ticker, one row per trade chain
// (lib/trade-chains classification), for the screener History tab.
// Chain P&L includes assignment stock legs — the whole point: "last
// time I traded ZS I lost $2,859 on a recovery play" must be visible
// at the point of decision.

type Row = {
  id: string;
  strike: number;
  expiry: string;
  status: string;
  position_type: string | null;
  opened_date: string;
  closed_date: string | null;
  realized_pnl: number | null;
  total_contracts: number | null;
  trade_chain_id: string | null;
  trade_type: string | null;
  chain_pnl: number | null;
  peak_capital: number | null;
};

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
      "id,strike,expiry,status,position_type,opened_date,closed_date,realized_pnl,total_contracts,trade_chain_id,trade_type,chain_pnl,peak_capital",
    )
    .eq("user_id", userId)
    .eq("symbol", symbol);
  if (res.error) {
    return NextResponse.json({ error: res.error.message }, { status: 500 });
  }
  const rows = (res.data ?? []) as Row[];

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
    };
  });
  campaigns.sort((a, b) => (b.start ?? "").localeCompare(a.start ?? ""));

  return NextResponse.json({ symbol, campaigns });
}

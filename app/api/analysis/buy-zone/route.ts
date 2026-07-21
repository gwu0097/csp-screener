// Cross-watchlist Buy Zone: how close each watched name is to an
// oversold bullish turnaround (RSI approaching oversold + a below-
// zero MACD bullish cross). Default reads every symbol across every
// one of the user's watchlists, deduped by symbol (score doesn't
// change based on which list it's in) and tagged with the list(s) it
// belongs to. ?watchlistId= scopes to a single list instead.
import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { requireUserId, authErrorResponse } from "@/lib/auth";
import { batchRefreshSnapshots, type SymbolSnapshot } from "@/lib/market-snapshot";
import { computeBuyZoneScore } from "@/lib/buy-zone";
import { ensurePortfolioWatchlist, type WatchlistMeta } from "@/lib/watchlists";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type ItemRow = { symbol: string; watchlist_id: string };

export async function GET(req: NextRequest) {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch (e) {
    return authErrorResponse(e);
  }
  await ensurePortfolioWatchlist(userId);
  const watchlistId = req.nextUrl.searchParams.get("watchlistId");

  const sb = createServerClient();
  const listsRes = await sb
    .from("watchlists")
    .select("id,name,is_portfolio")
    .eq("user_id", userId);
  if (listsRes.error) {
    return NextResponse.json({ error: listsRes.error.message }, { status: 500 });
  }
  const lists = (listsRes.data ?? []) as WatchlistMeta[];
  const nameById = new Map(lists.map((w) => [w.id, w.name]));

  if (watchlistId && !nameById.has(watchlistId)) {
    return NextResponse.json({ error: "Watchlist not found" }, { status: 404 });
  }

  let itemsQuery = sb.from("long_term_watchlist").select("symbol,watchlist_id").eq("user_id", userId);
  if (watchlistId) itemsQuery = itemsQuery.eq("watchlist_id", watchlistId);
  const itemsRes = await itemsQuery;
  if (itemsRes.error) {
    return NextResponse.json({ error: itemsRes.error.message }, { status: 500 });
  }
  const items = (itemsRes.data ?? []) as ItemRow[];

  // Dedup by symbol, accumulating which watchlist(s) each one belongs to.
  const bySymbol = new Map<string, Set<string>>();
  for (const it of items) {
    const sym = it.symbol.toUpperCase();
    const name = nameById.get(it.watchlist_id) ?? it.watchlist_id;
    if (!bySymbol.has(sym)) bySymbol.set(sym, new Set());
    bySymbol.get(sym)!.add(name);
  }
  const symbols = Array.from(bySymbol.keys());

  const snapshots = await batchRefreshSnapshots(symbols, 15);
  const snapMap = new Map<string, SymbolSnapshot>();
  for (const s of snapshots) snapMap.set(s.symbol.toUpperCase(), s);

  const rows = symbols.map((sym) => {
    const snap = snapMap.get(sym) ?? null;
    const rsi14 = snap?.rsi14 ?? null;
    const score = computeBuyZoneScore(rsi14, snap?.macd_history ?? null);
    return {
      symbol: sym,
      companyName: snap?.company_name ?? null,
      price: snap?.price ?? null,
      changePct: snap?.change_pct ?? null,
      rsi14,
      buyZoneRsiScore: score.rsiScore,
      buyZoneMacdScore: score.macdScore,
      buyZoneComposite: score.composite,
      buyZoneMacdStatus: score.macdStatus,
      watchlistNames: Array.from(bySymbol.get(sym) ?? []).sort(),
    };
  });
  rows.sort((a, b) => b.buyZoneComposite - a.buyZoneComposite);

  return NextResponse.json({
    rows,
    watchlists: lists
      .slice()
      .sort((a, b) => (a.is_portfolio === b.is_portfolio ? a.name.localeCompare(b.name) : a.is_portfolio ? -1 : 1))
      .map((w) => ({ id: w.id, name: w.name, isPortfolio: w.is_portfolio })),
  });
}

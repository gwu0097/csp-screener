// Items in a single watchlist (Portfolio or custom). Custom
// watchlists are simple: symbol + optional thesis note + whatever Buy
// Zone provides — no allocation tier, flags, or ACTION column (those
// only make sense for something already owned; see
// /api/longterm/watchlist for Portfolio's full-featured version).
import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { requireUserId, authErrorResponse } from "@/lib/auth";
import { batchRefreshSnapshots, type SymbolSnapshot } from "@/lib/market-snapshot";
import { computeBuyZoneScore } from "@/lib/buy-zone";
import type { WatchlistMeta } from "@/lib/watchlists";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type ItemRow = {
  id: string;
  symbol: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

async function loadWatchlist(
  id: string,
  userId: string,
): Promise<WatchlistMeta | null> {
  const sb = createServerClient();
  const res = await sb
    .from("watchlists")
    .select("*")
    .eq("id", id)
    .eq("user_id", userId)
    .maybeSingle();
  if (res.error || !res.data) return null;
  return res.data as WatchlistMeta;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch (e) {
    return authErrorResponse(e);
  }
  const watchlist = await loadWatchlist(params.id, userId);
  if (!watchlist) {
    return NextResponse.json({ error: "Watchlist not found" }, { status: 404 });
  }

  const sb = createServerClient();
  const res = await sb
    .from("long_term_watchlist")
    .select("id,symbol,notes,created_at,updated_at")
    .eq("watchlist_id", watchlist.id);
  if (res.error) {
    return NextResponse.json({ error: res.error.message }, { status: 500 });
  }
  const rows = (res.data ?? []) as ItemRow[];
  const symbols = rows.map((r) => r.symbol);
  const snapshots = await batchRefreshSnapshots(symbols, 15);
  const bySymbol = new Map<string, SymbolSnapshot>();
  for (const s of snapshots) bySymbol.set(s.symbol.toUpperCase(), s);

  const items = rows
    .map((r) => {
      const snap = bySymbol.get(r.symbol.toUpperCase()) ?? null;
      const rsi14 = snap?.rsi14 ?? null;
      const score = computeBuyZoneScore(rsi14, snap?.macd_history ?? null);
      return {
        id: r.id,
        symbol: r.symbol,
        notes: r.notes,
        companyName: snap?.company_name ?? null,
        price: snap?.price ?? null,
        changePct: snap?.change_pct ?? null,
        rsi14,
        buyZoneRsiScore: score.rsiScore,
        buyZoneMacdScore: score.macdScore,
        buyZoneComposite: score.composite,
        buyZoneMacdStatus: score.macdStatus,
        created_at: r.created_at,
      };
    })
    .sort((a, b) => b.buyZoneComposite - a.buyZoneComposite);

  return NextResponse.json({
    watchlist: { id: watchlist.id, name: watchlist.name, isPortfolio: watchlist.is_portfolio },
    items,
  });
}

type CreateBody = { symbol?: unknown; notes?: unknown };

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch (e) {
    return authErrorResponse(e);
  }
  const watchlist = await loadWatchlist(params.id, userId);
  if (!watchlist) {
    return NextResponse.json({ error: "Watchlist not found" }, { status: 404 });
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
  if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol)) {
    return NextResponse.json({ error: "Invalid symbol" }, { status: 400 });
  }
  const notes =
    typeof body.notes === "string" && body.notes.trim().length > 0
      ? body.notes.trim()
      : null;

  const sb = createServerClient();
  const ins = await sb
    .from("long_term_watchlist")
    .insert({ user_id: userId, watchlist_id: watchlist.id, symbol, allocation: null, notes })
    .select()
    .single();
  if (ins.error) {
    const status = ins.error.code === "23505" ? 409 : 400;
    return NextResponse.json(
      { error: status === 409 ? "Already in this watchlist" : ins.error.message },
      { status },
    );
  }
  return NextResponse.json({ row: ins.data });
}

type PatchBody = { id?: unknown; notes?: unknown };

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch (e) {
    return authErrorResponse(e);
  }
  const watchlist = await loadWatchlist(params.id, userId);
  if (!watchlist) {
    return NextResponse.json({ error: "Watchlist not found" }, { status: 404 });
  }
  let body: PatchBody;
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const itemId = typeof body.id === "string" ? body.id.trim() : "";
  if (!itemId) {
    return NextResponse.json({ error: "Missing id" }, { status: 400 });
  }
  const notes =
    typeof body.notes === "string" && body.notes.trim().length > 0
      ? body.notes.trim()
      : null;

  const sb = createServerClient();
  const res = await sb
    .from("long_term_watchlist")
    .update({ notes, updated_at: new Date().toISOString() })
    .eq("id", itemId)
    .eq("user_id", userId)
    .eq("watchlist_id", watchlist.id)
    .select()
    .single();
  if (res.error) {
    return NextResponse.json({ error: res.error.message }, { status: 400 });
  }
  return NextResponse.json({ row: res.data });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch (e) {
    return authErrorResponse(e);
  }
  const watchlist = await loadWatchlist(params.id, userId);
  if (!watchlist) {
    return NextResponse.json({ error: "Watchlist not found" }, { status: 404 });
  }
  const itemId = (req.nextUrl.searchParams.get("itemId") ?? "").trim();
  if (!itemId) {
    return NextResponse.json({ error: "Missing itemId" }, { status: 400 });
  }
  const sb = createServerClient();
  const res = await sb
    .from("long_term_watchlist")
    .delete()
    .eq("id", itemId)
    .eq("user_id", userId)
    .eq("watchlist_id", watchlist.id);
  if (res.error) {
    return NextResponse.json({ error: res.error.message }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}

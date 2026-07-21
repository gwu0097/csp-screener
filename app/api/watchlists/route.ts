// Watchlist metadata CRUD. Every user always has exactly one
// non-deletable "Portfolio" watchlist (allocation/flags/action/
// catalyst/digest, managed via /api/longterm/watchlist) plus any
// number of simpler custom watchlists (symbol + thesis + Buy Zone
// only, managed via /api/watchlists/[id]/items).
import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { requireUserId, authErrorResponse } from "@/lib/auth";
import { ensurePortfolioWatchlist, type WatchlistMeta } from "@/lib/watchlists";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch (e) {
    return authErrorResponse(e);
  }
  await ensurePortfolioWatchlist(userId);

  const sb = createServerClient();
  const res = await sb
    .from("watchlists")
    .select("id,name,is_portfolio,created_at,updated_at")
    .eq("user_id", userId);
  if (res.error) {
    return NextResponse.json({ error: res.error.message }, { status: 500 });
  }
  const lists = (res.data ?? []) as WatchlistMeta[];

  // Item counts in one batched query — the wrapper has no GROUP BY, so
  // count in JS over a single symbol/watchlist_id pull.
  const itemsRes = await sb
    .from("long_term_watchlist")
    .select("watchlist_id")
    .eq("user_id", userId);
  const counts = new Map<string, number>();
  if (!itemsRes.error) {
    for (const r of (itemsRes.data ?? []) as Array<{ watchlist_id: string }>) {
      counts.set(r.watchlist_id, (counts.get(r.watchlist_id) ?? 0) + 1);
    }
  }

  // Portfolio first, then alphabetical.
  lists.sort((a, b) => {
    if (a.is_portfolio !== b.is_portfolio) return a.is_portfolio ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return NextResponse.json({
    watchlists: lists.map((w) => ({
      id: w.id,
      name: w.name,
      isPortfolio: w.is_portfolio,
      symbolCount: counts.get(w.id) ?? 0,
      createdAt: w.created_at,
    })),
  });
}

type CreateBody = { name?: unknown };

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
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) {
    return NextResponse.json({ error: "Missing name" }, { status: 400 });
  }
  if (name.length > 100) {
    return NextResponse.json({ error: "Name too long" }, { status: 400 });
  }
  if (name.toLowerCase() === "portfolio") {
    return NextResponse.json(
      { error: "\"Portfolio\" is reserved for the built-in watchlist" },
      { status: 409 },
    );
  }

  const sb = createServerClient();
  const ins = await sb
    .from("watchlists")
    .insert({ user_id: userId, name, is_portfolio: false })
    .select()
    .single();
  if (ins.error) {
    const status = ins.error.code === "23505" ? 409 : 400;
    return NextResponse.json(
      { error: status === 409 ? "A watchlist with that name already exists" : ins.error.message },
      { status },
    );
  }
  const w = ins.data as WatchlistMeta;
  return NextResponse.json({
    watchlist: { id: w.id, name: w.name, isPortfolio: w.is_portfolio, symbolCount: 0, createdAt: w.created_at },
  });
}

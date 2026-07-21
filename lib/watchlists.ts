// Shared watchlist metadata helpers. Each user has one non-deletable
// "Portfolio" watchlist (allocation/flags/action/catalyst/digest) plus
// any number of simpler custom watchlists (symbol + thesis + Buy Zone
// only). See migrations/2026-07-21-add-watchlists.sql.
import { createServerClient } from "@/lib/supabase";

export type WatchlistMeta = {
  id: string;
  user_id: string;
  name: string;
  is_portfolio: boolean;
  created_at: string;
  updated_at: string;
};

// Idempotent create-if-missing so a brand-new user (no backfilled row)
// still always has a Portfolio watchlist to resolve against.
export async function ensurePortfolioWatchlist(userId: string): Promise<WatchlistMeta> {
  const sb = createServerClient();
  const existing = await sb
    .from("watchlists")
    .select("*")
    .eq("user_id", userId)
    .eq("is_portfolio", true)
    .limit(1);
  if (!existing.error && existing.data && existing.data.length > 0) {
    return existing.data[0] as WatchlistMeta;
  }
  const ins = await sb
    .from("watchlists")
    .insert({ user_id: userId, name: "Portfolio", is_portfolio: true })
    .select()
    .single();
  if (!ins.error && ins.data) {
    return ins.data as WatchlistMeta;
  }
  // Concurrent first-request race — the unique partial index on
  // (user_id) WHERE is_portfolio rejected a second insert. Re-fetch
  // the one that won.
  if (ins.error?.code === "23505") {
    const retry = await sb
      .from("watchlists")
      .select("*")
      .eq("user_id", userId)
      .eq("is_portfolio", true)
      .limit(1)
      .single();
    if (!retry.error && retry.data) return retry.data as WatchlistMeta;
  }
  throw new Error(`Failed to ensure Portfolio watchlist: ${ins.error?.message}`);
}

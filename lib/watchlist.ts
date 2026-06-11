import { createServerClient } from "@/lib/supabase";

export type WatchlistType = "whitelist" | "blacklist";

export type WatchlistEntry = {
  symbol: string;
  list_type: WatchlistType;
  added_at: string;
};

// All watchlist data is per-user (multi-tenancy) — every function
// takes the owning user's id and scopes its queries to it.

export async function getWatchlist(userId: string): Promise<{
  whitelist: WatchlistEntry[];
  blacklist: WatchlistEntry[];
}> {
  try {
    const supabase = createServerClient();
    const { data, error } = await supabase
      .from("watchlist")
      .select("symbol, list_type, added_at")
      .eq("user_id", userId)
      .order("added_at", { ascending: false });
    if (error) throw error;
    const rows = (data ?? []) as WatchlistEntry[];
    return {
      whitelist: rows.filter((r) => r.list_type === "whitelist"),
      blacklist: rows.filter((r) => r.list_type === "blacklist"),
    };
  } catch (e) {
    console.error("[watchlist] load failed:", e instanceof Error ? e.message : e);
    return { whitelist: [], blacklist: [] };
  }
}

export async function getWatchlistSymbols(userId: string): Promise<{
  whitelist: Set<string>;
  blacklist: Set<string>;
}> {
  const { whitelist, blacklist } = await getWatchlist(userId);
  return {
    whitelist: new Set(whitelist.map((r) => r.symbol.toUpperCase())),
    blacklist: new Set(blacklist.map((r) => r.symbol.toUpperCase())),
  };
}

export async function addToWatchlist(
  userId: string,
  symbol: string,
  listType: WatchlistType,
): Promise<WatchlistEntry> {
  const norm = symbol.trim().toUpperCase();
  if (!/^[A-Z]{1,10}([.\-][A-Z]{1,2})?$/.test(norm)) {
    throw new Error(`Invalid symbol: ${symbol}`);
  }
  const supabase = createServerClient();
  const { data, error } = await supabase
    .from("watchlist")
    .upsert(
      {
        user_id: userId,
        symbol: norm,
        list_type: listType,
        added_at: new Date().toISOString(),
      },
      { onConflict: "user_id,symbol" },
    )
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data as WatchlistEntry;
}

export async function removeFromWatchlist(
  userId: string,
  symbol: string,
): Promise<void> {
  const norm = symbol.trim().toUpperCase();
  const supabase = createServerClient();
  const { error } = await supabase
    .from("watchlist")
    .delete()
    .eq("user_id", userId)
    .eq("symbol", norm);
  if (error) throw new Error(error.message);
}

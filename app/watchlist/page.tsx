import { WatchlistView } from "@/components/watchlist-view";
import { getWatchlist } from "@/lib/watchlist";
import { requireUserId } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function WatchlistPage() {
  // Middleware redirects unauthenticated page loads, so this resolves.
  const userId = await requireUserId();
  const { whitelist, blacklist } = await getWatchlist(userId);
  return (
    <WatchlistView
      initialWhitelist={whitelist.map((r) => ({ symbol: r.symbol, addedAt: r.added_at }))}
      initialBlacklist={blacklist.map((r) => ({ symbol: r.symbol, addedAt: r.added_at }))}
    />
  );
}

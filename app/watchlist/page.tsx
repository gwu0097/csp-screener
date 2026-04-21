import { WatchlistView } from "@/components/watchlist-view";
import { getWatchlist } from "@/lib/watchlist";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function WatchlistPage() {
  const { whitelist, blacklist } = await getWatchlist();
  return (
    <WatchlistView
      initialWhitelist={whitelist.map((r) => ({ symbol: r.symbol, addedAt: r.added_at }))}
      initialBlacklist={blacklist.map((r) => ({ symbol: r.symbol, addedAt: r.added_at }))}
    />
  );
}

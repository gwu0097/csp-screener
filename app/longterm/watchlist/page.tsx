export const dynamic = "force-dynamic";

export default function LongTermWatchlistPage() {
  return (
    <div className="space-y-4">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">
          Long Term Watchlist
        </h1>
      </header>
      <div className="rounded-md border border-dashed border-border bg-background/40 p-10 text-center">
        <div className="text-lg font-medium">Long Term Watchlist — Coming Soon</div>
        <p className="mx-auto mt-2 max-w-xl text-sm text-muted-foreground">
          Track your long-term holdings with fundamental health monitoring,
          news feed, and valuation alerts.
        </p>
      </div>
    </div>
  );
}

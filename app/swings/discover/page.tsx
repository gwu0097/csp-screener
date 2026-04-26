export const dynamic = "force-dynamic";

export default function SwingDiscoverPage() {
  return (
    <div className="space-y-4">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Swing Setups</h1>
      </header>
      <div className="rounded-md border border-dashed border-border bg-background/40 p-10 text-center">
        <div className="text-lg font-medium">Swing Setups — Coming Soon</div>
        <p className="mx-auto mt-2 max-w-xl text-sm text-muted-foreground">
          Real-time setup screener using Yahoo Finance, Finnhub insider data,
          and Schwab options flow. Screens S&amp;P 500 + Nasdaq 100 for
          actionable setups meeting strict technical and signal criteria. No
          AI guessing — every signal backed by real data.
        </p>
      </div>
    </div>
  );
}

import { Suspense } from "react";
import { ScreenerView } from "@/components/screener-view";
import { runScreener } from "@/lib/screener";
import { isSchwabConnected } from "@/lib/schwab";

export const dynamic = "force-dynamic";
export const revalidate = 0;

async function ScreenerLoader() {
  const [{ connected }, result] = await Promise.all([
    isSchwabConnected().catch(() => ({ connected: false })),
    runScreener().catch((e) => ({
      connected: false,
      results: [],
      errors: [e instanceof Error ? e.message : "Screener error"],
    })),
  ]);
  return <ScreenerView connected={connected} results={result.results} errors={result.errors} />;
}

export default function Home() {
  return (
    <div className="space-y-4">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Earnings screener</h1>
        <p className="text-sm text-muted-foreground">
          Cash-secured puts on stable, earnings-season candidates. Sorted by recommendation strength.
        </p>
      </header>
      <Suspense fallback={<div className="text-sm text-muted-foreground">Running screener…</div>}>
        <ScreenerLoader />
      </Suspense>
    </div>
  );
}

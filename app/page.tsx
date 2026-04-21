import { ScreenerView } from "@/components/screener-view";
import { isSchwabConnected } from "@/lib/schwab";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function Home() {
  const { connected } = await isSchwabConnected().catch(() => ({ connected: false }));

  return (
    <div className="space-y-4">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Earnings screener</h1>
        <p className="text-sm text-muted-foreground">
          Cash-secured puts on stable, earnings-season candidates. Click Run to score today&apos;s and
          tomorrow&apos;s earnings.
        </p>
      </header>
      <ScreenerView connected={connected} />
    </div>
  );
}

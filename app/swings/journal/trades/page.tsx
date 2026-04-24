import { Suspense } from "react";
import { SwingTradesView } from "@/components/swing-trades-view";

export const dynamic = "force-dynamic";

export default function SwingTradesPage() {
  return (
    <div className="space-y-4">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Swing Trades</h1>
        <p className="text-sm text-muted-foreground">
          Log of all swing positions — entry, exit, realized P&amp;L, and return %.
        </p>
      </header>
      <Suspense fallback={<div className="text-sm text-muted-foreground">Loading…</div>}>
        <SwingTradesView />
      </Suspense>
    </div>
  );
}

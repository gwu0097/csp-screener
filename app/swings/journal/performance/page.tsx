import { LineChart } from "lucide-react";

export default function SwingPerformancePage() {
  return (
    <div className="space-y-4">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">
          Swing Performance
        </h1>
      </header>
      <div className="rounded-md border border-border bg-background/40 p-8 text-center">
        <LineChart className="mx-auto mb-3 h-10 w-10 text-muted-foreground" />
        <div className="text-lg font-medium">Coming in Phase 3</div>
        <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
          Equity curve, win rate, batting average vs slugging ratio, and
          holding period analysis for your swing trades.
        </p>
      </div>
    </div>
  );
}

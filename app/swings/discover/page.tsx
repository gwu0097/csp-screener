import { SwingScreenView } from "@/components/swing-screen-view";

export const dynamic = "force-dynamic";

export default function SwingDiscoverPage() {
  return (
    <div className="space-y-4">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Swing Setups</h1>
        <p className="text-sm text-muted-foreground">
          Real-time setup screener. S&amp;P 500 + Nasdaq 100. Every signal
          backed by real data.
        </p>
      </header>
      <SwingScreenView />
    </div>
  );
}

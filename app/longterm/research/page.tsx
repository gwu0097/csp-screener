import { SwingDiscoverView } from "@/components/swing-discover-view";

export const dynamic = "force-dynamic";

export default function LongTermResearchPage() {
  return (
    <div className="space-y-4">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Stock Research</h1>
        <p className="text-sm text-muted-foreground">
          AI-powered stock research tool. Find and analyze long-term investment
          candidates.
        </p>
      </header>
      <SwingDiscoverView
        ideasApiBase="/api/longterm/ideas"
        scanLabelOverride="Scan for Ideas"
      />
    </div>
  );
}

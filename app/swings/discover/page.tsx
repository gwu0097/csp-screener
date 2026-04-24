import { SwingDiscoverView } from "@/components/swing-discover-view";

export const dynamic = "force-dynamic";

export default function SwingDiscoverPage() {
  return (
    <div className="space-y-4">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Swing Discover</h1>
        <p className="text-sm text-muted-foreground">
          AI-powered catalyst scanner. Surfaces momentum stocks matching your
          swing trading style.
        </p>
      </header>
      <SwingDiscoverView />
    </div>
  );
}

import { Search } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function SwingDiscoverPage() {
  return (
    <div className="space-y-4">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Swing Discover</h1>
      </header>
      <div className="rounded-md border border-border bg-background/40 p-8 text-center">
        <Search className="mx-auto mb-3 h-10 w-10 text-muted-foreground" />
        <div className="text-lg font-medium">Coming in Phase 2</div>
        <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
          AI-powered catalyst scanner using Perplexity. Will surface momentum
          stocks with near-term catalysts matching your swing trading style.
        </p>
        <div className="mt-6">
          <Button disabled>Scan Now</Button>
        </div>
      </div>
    </div>
  );
}

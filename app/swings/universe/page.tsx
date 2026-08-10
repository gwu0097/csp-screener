import { SwingUniverseView } from "@/components/swing-universe-view";

export const dynamic = "force-dynamic";

export default function SwingUniversePage() {
  return (
    <div className="space-y-4">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Universe & Themes</h1>
        <p className="text-sm text-muted-foreground">
          Manually curated groups of names — second/third-tier suppliers and
          comparables that aren&apos;t in the S&amp;P 500 or Nasdaq 100.
        </p>
      </header>
      <SwingUniverseView />
    </div>
  );
}

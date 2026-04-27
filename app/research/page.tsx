import { ResearchHomeView } from "@/components/research-home-view";

export const dynamic = "force-dynamic";

export default function ResearchHomePage() {
  return (
    <div className="space-y-4">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Deep Research</h1>
        <p className="text-sm text-muted-foreground">
          Fundamental analysis, catalyst discovery, and valuation modeling.
          Every insight saved to your research encyclopedia.
        </p>
      </header>
      <ResearchHomeView />
    </div>
  );
}

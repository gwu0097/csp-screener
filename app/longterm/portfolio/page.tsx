export const dynamic = "force-dynamic";

export default function LongTermPortfolioPage() {
  return (
    <div className="space-y-4">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">
          Portfolio Analysis
        </h1>
      </header>
      <div className="rounded-md border border-dashed border-border bg-background/40 p-10 text-center">
        <div className="text-lg font-medium">Portfolio Analysis — Coming Soon</div>
        <p className="mx-auto mt-2 max-w-xl text-sm text-muted-foreground">
          DCF valuation model, bear/base/bull scenarios, and DCA tracker for
          your long-term positions.
        </p>
      </div>
    </div>
  );
}

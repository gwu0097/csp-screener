import { BookOpen } from "lucide-react";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default function JournalPage() {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-sm font-medium">
        <BookOpen className="h-4 w-4" /> Journal
      </div>

      <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border bg-background/40 px-6 py-16 text-center">
        <BookOpen className="mb-3 h-10 w-10 text-muted-foreground" />
        <h2 className="mb-1 text-lg font-semibold">Journal coming next</h2>
        <p className="max-w-md text-sm text-muted-foreground">
          Equity curve, win-rate by ticker/strike/day, expectancy, and top wins/losses land
          in PR 3. The existing /history page still works in the meantime.
        </p>
      </div>
    </div>
  );
}

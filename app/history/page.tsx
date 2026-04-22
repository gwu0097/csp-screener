import Link from "next/link";

export const dynamic = "force-dynamic";

// /history ran against the pre-rebuild single-row trades table. It's been
// superseded by /journal, which reads positions + fills.
export default function HistoryPage() {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border bg-background/40 px-6 py-16 text-center">
      <h1 className="mb-2 text-lg font-semibold">History moved</h1>
      <p className="mb-4 max-w-md text-sm text-muted-foreground">
        This page ran against the old trades schema. It&apos;s been replaced by
        the Journal, which uses the new positions + fills model.
      </p>
      <Link
        href="/journal"
        className="rounded-md border border-border bg-background px-3 py-1.5 text-sm hover:bg-muted/40"
      >
        Go to Journal
      </Link>
    </div>
  );
}

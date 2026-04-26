import { SwingIdeasBoard } from "@/components/swing-ideas-board";

export const dynamic = "force-dynamic";

export default function SwingIdeasPage() {
  return (
    <div className="space-y-4">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Swing Ideas</h1>
        <p className="text-sm text-muted-foreground">
          Kanban of swing setups. Cards land in Setup Ready when they pass the
          screener; Entered and Exited follow your trade log.
        </p>
      </header>
      <SwingIdeasBoard />
    </div>
  );
}

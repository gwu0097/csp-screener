import { SwingIdeasBoard } from "@/components/swing-ideas-board";

export const dynamic = "force-dynamic";

export default function SwingIdeasPage() {
  return (
    <div className="space-y-4">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Swing Ideas</h1>
        <p className="text-sm text-muted-foreground">
          Kanban of swing-trading candidates. Move cards through Watching →
          Conviction → Entered → Exited as your conviction grows or the thesis
          resolves.
        </p>
      </header>
      <SwingIdeasBoard />
    </div>
  );
}

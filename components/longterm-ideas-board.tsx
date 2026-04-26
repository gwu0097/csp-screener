"use client";

import { useEffect, useState } from "react";
import { ArrowLeft, ArrowRight, Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  SwingIdeaDialog,
  StarRating,
  type SwingIdea,
} from "@/components/swing-idea-dialog";
import { SwingConvictionGate } from "@/components/swing-conviction-gate";

const API_BASE = "/api/longterm/ideas";

type Status = "watching" | "conviction" | "entered" | "exited";

const COLUMNS: Array<{ key: Status; label: string }> = [
  { key: "watching", label: "Watching" },
  { key: "conviction", label: "Conviction" },
  { key: "entered", label: "Entered" },
  { key: "exited", label: "Exited" },
];

// All four columns are user-controlled here — no trade integration on
// long-term ideas yet, so the board is fully manual.
const DND_MIME = "application/x-longterm-idea-id";

function sentimentColor(s: string | null): string {
  if (s === "bullish") return "bg-emerald-500/20 text-emerald-300 border-emerald-500/40";
  if (s === "bearish") return "bg-rose-500/20 text-rose-300 border-rose-500/40";
  if (s === "mixed") return "bg-amber-500/20 text-amber-300 border-amber-500/40";
  return "bg-muted/40 text-muted-foreground border-border";
}

function timeframeLabel(tf: string | null): string {
  if (tf === "1month") return "1 month";
  if (tf === "3months") return "3 months";
  if (tf === "6months") return "6 months";
  return "—";
}

function fmtMoney(n: number | null): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return `$${n.toFixed(2)}`;
}

const NEXT_STAGE: Record<Status, Status | null> = {
  watching: "conviction",
  conviction: "entered",
  entered: "exited",
  exited: null,
};

const PREV_STAGE: Record<Status, Status | null> = {
  watching: null,
  conviction: "watching",
  entered: "conviction",
  exited: "entered",
};

export function LongTermIdeasBoard() {
  const [ideas, setIdeas] = useState<SwingIdea[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<SwingIdea | null>(null);

  const [dragOverCol, setDragOverCol] = useState<Status | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);

  // The conviction gate intercepts every watching → conviction move so the
  // user has to articulate a thesis + exit before promoting.
  const [convictionFor, setConvictionFor] = useState<SwingIdea | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(API_BASE, { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setIdeas(json.ideas as SwingIdea[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function changeStatus(idea: SwingIdea, next: Status): Promise<boolean> {
    setActionError(null);
    try {
      const res = await fetch(`${API_BASE}/${idea.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: next }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      setIdeas((prev) =>
        prev.map((i) => (i.id === idea.id ? { ...i, status: next } : i)),
      );
      load();
      return true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to update";
      console.error("[longterm-ideas] status change failed:", e);
      setActionError(`Could not move ${idea.symbol}: ${msg}`);
      return false;
    }
  }

  async function deleteIdea(idea: SwingIdea) {
    if (!window.confirm(`Delete long-term idea ${idea.symbol}?`)) return;
    setActionError(null);
    try {
      const res = await fetch(`${API_BASE}/${idea.id}`, { method: "DELETE" });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      await load();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to delete";
      console.error("[longterm-ideas] delete failed:", e);
      setActionError(`Could not delete ${idea.symbol}: ${msg}`);
    }
  }

  function onCardDragStart(e: React.DragEvent<HTMLDivElement>, idea: SwingIdea) {
    e.dataTransfer.setData(DND_MIME, idea.id);
    e.dataTransfer.setData("text/plain", idea.id);
    e.dataTransfer.effectAllowed = "move";
    setDraggingId(idea.id);
  }
  function onCardDragEnd() {
    setDraggingId(null);
    setDragOverCol(null);
  }
  function onColumnDragOver(e: React.DragEvent<HTMLDivElement>, col: Status) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (dragOverCol !== col) setDragOverCol(col);
  }
  function onColumnDragLeave(col: Status) {
    setDragOverCol((cur) => (cur === col ? null : cur));
  }
  async function onColumnDrop(e: React.DragEvent<HTMLDivElement>, col: Status) {
    e.preventDefault();
    const id = e.dataTransfer.getData(DND_MIME) || e.dataTransfer.getData("text/plain");
    setDragOverCol(null);
    setDraggingId(null);
    if (!id) return;
    const idea = ideas.find((i) => i.id === id);
    if (!idea) return;
    if (idea.status === col) return;
    if (col === "conviction" && idea.status === "watching") {
      setConvictionFor(idea);
      return;
    }
    await changeStatus(idea, col);
  }

  const byStatus: Record<Status, SwingIdea[]> = {
    watching: [],
    conviction: [],
    entered: [],
    exited: [],
  };
  for (const idea of ideas) {
    const key = (idea.status as Status) ?? "watching";
    if (byStatus[key]) byStatus[key].push(idea);
  }

  return (
    <div className="space-y-4">
      {error && (
        <div className="rounded border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-300">
          {error}
        </div>
      )}
      {actionError && (
        <div className="flex items-start justify-between gap-3 rounded border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-300">
          <span>{actionError}</span>
          <button
            type="button"
            onClick={() => setActionError(null)}
            className="text-xs text-rose-200 hover:text-white"
          >
            Dismiss
          </button>
        </div>
      )}

      {loading && ideas.length === 0 ? (
        <div className="text-sm text-muted-foreground">Loading ideas…</div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
          {COLUMNS.map((col) => {
            const list = byStatus[col.key];
            const isDropTarget = dragOverCol === col.key;
            return (
              <div
                key={col.key}
                onDragOver={(e) => onColumnDragOver(e, col.key)}
                onDragLeave={() => onColumnDragLeave(col.key)}
                onDrop={(e) => onColumnDrop(e, col.key)}
                className={`flex min-h-[400px] flex-col rounded-md border bg-background/40 transition-colors ${
                  isDropTarget
                    ? "border-2 border-blue-500 bg-blue-500/5"
                    : "border border-border"
                }`}
              >
                <div className="flex items-center justify-between border-b border-border px-3 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  <span>
                    {col.label}{" "}
                    <span className="ml-1 rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-foreground">
                      {list.length}
                    </span>
                  </span>
                </div>
                <div className="flex-1 space-y-2 overflow-y-auto p-2">
                  {list.length === 0 ? (
                    <div className="py-6 text-center text-xs text-muted-foreground">
                      —
                    </div>
                  ) : (
                    list.map((idea) => (
                      <IdeaCard
                        key={idea.id}
                        idea={idea}
                        dragging={draggingId === idea.id}
                        onDragStart={(e) => onCardDragStart(e, idea)}
                        onDragEnd={onCardDragEnd}
                        onForward={() => {
                          const next = NEXT_STAGE[idea.status as Status] ?? null;
                          if (!next) return;
                          if (
                            next === "conviction" &&
                            idea.status === "watching"
                          ) {
                            setConvictionFor(idea);
                          } else {
                            changeStatus(idea, next);
                          }
                        }}
                        onBackward={() => {
                          const prev = PREV_STAGE[idea.status as Status] ?? null;
                          if (prev) changeStatus(idea, prev);
                        }}
                        onEdit={() => setEditing(idea)}
                        onDelete={() => deleteIdea(idea)}
                      />
                    ))
                  )}
                </div>
                {col.key === "watching" && (
                  <div className="border-t border-border p-2">
                    <Button
                      variant="outline"
                      className="w-full"
                      onClick={() => setCreateOpen(true)}
                    >
                      <Plus className="mr-1 h-4 w-4" /> Add Idea
                    </Button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <SwingIdeaDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        mode={{ kind: "create" }}
        onSaved={load}
        apiBase={API_BASE}
        titlePrefix="long-term idea"
      />
      <SwingIdeaDialog
        open={editing !== null}
        onOpenChange={(v) => !v && setEditing(null)}
        mode={editing ? { kind: "edit", idea: editing } : { kind: "create" }}
        onSaved={load}
        apiBase={API_BASE}
        titlePrefix="long-term idea"
      />
      <SwingConvictionGate
        idea={convictionFor}
        open={convictionFor !== null}
        onOpenChange={(v) => !v && setConvictionFor(null)}
        onConfirmed={load}
        apiBase={API_BASE}
      />
    </div>
  );
}

function IdeaCard({
  idea,
  dragging,
  onDragStart,
  onDragEnd,
  onForward,
  onBackward,
  onEdit,
  onDelete,
}: {
  idea: SwingIdea;
  dragging: boolean;
  onDragStart: (e: React.DragEvent<HTMLDivElement>) => void;
  onDragEnd: () => void;
  onForward: () => void;
  onBackward: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const status = idea.status as Status;
  const summary =
    idea.user_thesis?.trim() ||
    idea.catalyst?.trim() ||
    idea.ai_summary?.trim() ||
    "";

  const stageStyle =
    status === "entered"
      ? "border-emerald-500/30 bg-emerald-500/5"
      : status === "exited"
        ? "border-border bg-zinc-900/60 opacity-90"
        : "border-border bg-zinc-900/60";

  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className={`cursor-grab rounded-md border p-3 text-xs active:cursor-grabbing ${stageStyle} ${
        dragging ? "opacity-40" : ""
      }`}
    >
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="font-mono text-sm font-semibold text-foreground">
          {idea.symbol}
        </span>
        {idea.analyst_sentiment && (
          <span
            className={`rounded border px-1.5 py-0.5 text-[10px] font-medium capitalize ${sentimentColor(idea.analyst_sentiment)}`}
          >
            {idea.analyst_sentiment}
          </span>
        )}
      </div>

      {status === "watching" ? (
        <div className="mb-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
          {idea.price_at_discovery !== null && (
            <span className="text-foreground">{fmtMoney(idea.price_at_discovery)}</span>
          )}
          {idea.forward_pe !== null && (
            <span>
              Fwd P/E: <span className="text-foreground">{idea.forward_pe}x</span>
            </span>
          )}
          {idea.analyst_target !== null && (
            <span>
              Tgt: <span className="text-foreground">{fmtMoney(idea.analyst_target)}</span>
            </span>
          )}
        </div>
      ) : (
        <>
          {idea.user_thesis?.trim() && (
            <div className="mb-1 line-clamp-3 italic text-foreground/90">
              &ldquo;{idea.user_thesis}&rdquo;
            </div>
          )}
          {idea.exit_condition?.trim() && (
            <div className="mb-2 line-clamp-2 text-[11px] text-muted-foreground">
              <span className="font-medium text-foreground/80">Exit:</span>{" "}
              {idea.exit_condition}
            </div>
          )}
        </>
      )}

      {status === "watching" && summary && (
        <div className="mb-2 line-clamp-1 italic text-muted-foreground">
          &ldquo;{summary}&rdquo;
        </div>
      )}

      <div className="mb-2 flex items-center justify-between">
        <span className="rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-muted-foreground">
          {timeframeLabel(idea.timeframe)}
        </span>
        <StarRating value={idea.conviction ?? 0} readonly size="xs" />
      </div>

      <div className="flex items-center gap-1">
        {PREV_STAGE[status] && (
          <button
            type="button"
            onClick={onBackward}
            className="flex items-center justify-center rounded border border-border px-2 py-1 text-muted-foreground hover:bg-white/5 hover:text-foreground"
            title="Move back"
            aria-label="Move back"
          >
            <ArrowLeft className="h-3 w-3" />
          </button>
        )}
        {NEXT_STAGE[status] && (
          <button
            type="button"
            onClick={onForward}
            className="flex flex-1 items-center justify-center gap-1 rounded border border-border py-1 text-[11px] text-muted-foreground hover:bg-white/5 hover:text-foreground"
            title={`Move to ${NEXT_STAGE[status]}`}
          >
            <ArrowRight className="h-3 w-3" />
            {NEXT_STAGE[status] === "conviction" && "Mark as Conviction"}
            {NEXT_STAGE[status] === "entered" && "Mark as Entered"}
            {NEXT_STAGE[status] === "exited" && "Mark as Exited"}
          </button>
        )}
        <button
          type="button"
          onClick={onEdit}
          className="flex items-center justify-center rounded border border-border px-2 py-1 text-muted-foreground hover:bg-white/5 hover:text-foreground"
          title="Edit"
          aria-label="Edit idea"
        >
          <Pencil className="h-3 w-3" />
        </button>
        <button
          type="button"
          onClick={onDelete}
          className="flex items-center justify-center rounded border border-border px-2 py-1 text-muted-foreground hover:bg-rose-500/10 hover:text-rose-300"
          title="Delete"
          aria-label="Delete idea"
        >
          <Trash2 className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}

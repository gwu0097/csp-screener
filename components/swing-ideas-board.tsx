"use client";

import { useEffect, useState } from "react";
import { ArrowRight, Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  SwingIdeaDialog,
  StarRating,
  type SwingIdea,
} from "@/components/swing-idea-dialog";

type Status = "watching" | "conviction" | "entered" | "exited";

const COLUMNS: Array<{ key: Status; label: string }> = [
  { key: "watching", label: "Watching" },
  { key: "conviction", label: "Conviction" },
  { key: "entered", label: "Entered" },
  { key: "exited", label: "Exited" },
];

const NEXT_STATUS: Partial<Record<Status, Status>> = {
  watching: "conviction",
  conviction: "entered",
  entered: "exited",
};

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
  if (n === null || !Number.isFinite(n)) return "";
  return `$${n.toFixed(2)}`;
}

export function SwingIdeasBoard() {
  const [ideas, setIdeas] = useState<SwingIdea[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<SwingIdea | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/swings/ideas", { cache: "no-store" });
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

  async function moveIdea(idea: SwingIdea) {
    const next = NEXT_STATUS[idea.status as Status];
    if (!next) return;
    try {
      const res = await fetch(`/api/swings/ideas/${idea.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: next }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      await load();
      // When an idea moves to ENTERED, nudge the user to log the trade.
      if (next === "entered") {
        const go = window.confirm(
          `${idea.symbol} moved to Entered. Log a trade now?`,
        );
        if (go) {
          window.location.href = `/swings/journal/trades?prefill=${encodeURIComponent(
            idea.symbol,
          )}&ideaId=${idea.id}`;
        }
      }
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed to move");
    }
  }

  async function deleteIdea(idea: SwingIdea) {
    if (!window.confirm(`Delete swing idea ${idea.symbol}?`)) return;
    try {
      const res = await fetch(`/api/swings/ideas/${idea.id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      await load();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed to delete");
    }
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
      {loading && ideas.length === 0 ? (
        <div className="text-sm text-muted-foreground">Loading ideas…</div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
          {COLUMNS.map((col) => {
            const list = byStatus[col.key];
            return (
              <div
                key={col.key}
                className="flex min-h-[400px] flex-col rounded-md border border-border bg-background/40"
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
                        onMove={() => moveIdea(idea)}
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
      />
      <SwingIdeaDialog
        open={editing !== null}
        onOpenChange={(v) => !v && setEditing(null)}
        mode={editing ? { kind: "edit", idea: editing } : { kind: "create" }}
        onSaved={load}
      />
    </div>
  );
}

function IdeaCard({
  idea,
  onMove,
  onEdit,
  onDelete,
}: {
  idea: SwingIdea;
  onMove: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const canMove = idea.status !== "exited";
  const summary =
    idea.catalyst?.trim() || idea.user_thesis?.trim() || idea.ai_summary?.trim() || "";
  return (
    <div className="rounded-md border border-border bg-zinc-900/60 p-3 text-xs">
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

      <div className="mb-1 flex gap-3 text-[11px] text-muted-foreground">
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

      {summary && (
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
        {canMove && (
          <button
            type="button"
            onClick={onMove}
            className="flex flex-1 items-center justify-center gap-1 rounded border border-border py-1 text-[11px] text-muted-foreground hover:bg-white/5 hover:text-foreground"
            title="Move to next stage"
          >
            <ArrowRight className="h-3 w-3" />
            Move
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

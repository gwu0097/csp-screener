"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, ArrowRight, ExternalLink, Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  SwingIdeaDialog,
  StarRating,
  type SwingIdea,
} from "@/components/swing-idea-dialog";
import { SwingConvictionGate } from "@/components/swing-conviction-gate";

type Status = "watching" | "conviction" | "entered" | "exited";

const COLUMNS: Array<{ key: Status; label: string }> = [
  { key: "watching", label: "Watching" },
  { key: "conviction", label: "Conviction" },
  { key: "entered", label: "Entered" },
  { key: "exited", label: "Exited" },
];

// Only the first two stages are user-controlled. ENTERED and EXITED
// follow from trade data — attempting to move manually (button or drag)
// would get out of sync with the trade log.
const MANUAL_STAGES: Status[] = ["watching", "conviction"];
const TRADE_STAGES: Status[] = ["entered", "exited"];

const DND_MIME = "application/x-swing-idea-id";

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

function fmtMoney(n: number | null, signed = false): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const sign = signed && n > 0 ? "+" : "";
  return `${sign}$${n.toFixed(2)}`;
}

function fmtPct(n: number | null, digits = 1): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${(n * 100).toFixed(digits)}%`;
}

function exitReasonLabel(r: string | null): string {
  if (r === "target_hit") return "Target hit";
  if (r === "stop_loss") return "Stop loss";
  if (r === "thesis_broken") return "Thesis broken";
  if (r === "manual") return "Manual";
  return "";
}

function daysBetween(fromIso: string | null, toIso: string | null): number | null {
  if (!fromIso) return null;
  const end = toIso ? Date.parse(toIso + "T00:00:00Z") : Date.now();
  const start = Date.parse(fromIso + "T00:00:00Z");
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, Math.round((end - start) / 86400000));
}

export function SwingIdeasBoard() {
  const [ideas, setIdeas] = useState<SwingIdea[]>([]);
  const [prices, setPrices] = useState<Record<string, number | null>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<SwingIdea | null>(null);

  const [dragOverCol, setDragOverCol] = useState<Status | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);

  // The conviction gate intercepts every watching → conviction move
  // (Move button or DnD) so the user has to articulate a thesis + exit
  // before promoting. Setting this opens the modal; the modal patches
  // the idea itself on confirm.
  const [convictionFor, setConvictionFor] = useState<SwingIdea | null>(null);

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

  // Batch-fetch current prices for ENTERED symbols after ideas load. Runs
  // once per unique symbol list — re-fetches only when the set changes so
  // we don't hammer Yahoo on every parent re-render.
  const enteredSymbols = useMemo(() => {
    const set = new Set<string>();
    for (const idea of ideas) {
      if (idea.status === "entered") set.add(idea.symbol);
    }
    return Array.from(set).sort();
  }, [ideas]);

  useEffect(() => {
    if (enteredSymbols.length === 0) return;
    let cancelled = false;
    (async () => {
      try {
        const url = `/api/swings/quotes?symbols=${enteredSymbols.join(",")}`;
        const res = await fetch(url, { cache: "no-store" });
        const json = (await res.json()) as {
          prices?: Record<string, number | null>;
          error?: string;
        };
        if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
        if (!cancelled) setPrices(json.prices ?? {});
      } catch (e) {
        console.warn("[swing-ideas] quote fetch failed:", e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enteredSymbols.join(",")]);

  async function changeStatus(idea: SwingIdea, next: Status): Promise<boolean> {
    setActionError(null);
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
      setIdeas((prev) =>
        prev.map((i) => (i.id === idea.id ? { ...i, status: next } : i)),
      );
      load();
      return true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to update";
      console.error("[swing-ideas] status change failed:", e);
      setActionError(`Could not move ${idea.symbol}: ${msg}`);
      return false;
    }
  }

  async function deleteIdea(idea: SwingIdea) {
    if (!window.confirm(`Delete swing idea ${idea.symbol}?`)) return;
    setActionError(null);
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
      const msg = e instanceof Error ? e.message : "Failed to delete";
      console.error("[swing-ideas] delete failed:", e);
      setActionError(`Could not delete ${idea.symbol}: ${msg}`);
    }
  }

  // DnD only between manual stages. Cards in ENTERED/EXITED are not
  // draggable, and those columns never accept drops.
  function onCardDragStart(e: React.DragEvent<HTMLDivElement>, idea: SwingIdea) {
    if (!MANUAL_STAGES.includes(idea.status as Status)) {
      e.preventDefault();
      return;
    }
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
    if (!MANUAL_STAGES.includes(col)) return; // not a drop target
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (dragOverCol !== col) setDragOverCol(col);
  }
  function onColumnDragLeave(col: Status) {
    setDragOverCol((cur) => (cur === col ? null : cur));
  }
  async function onColumnDrop(e: React.DragEvent<HTMLDivElement>, col: Status) {
    if (!MANUAL_STAGES.includes(col)) return;
    e.preventDefault();
    const id = e.dataTransfer.getData(DND_MIME) || e.dataTransfer.getData("text/plain");
    setDragOverCol(null);
    setDraggingId(null);
    if (!id) return;
    const idea = ideas.find((i) => i.id === id);
    if (!idea) return;
    if (!MANUAL_STAGES.includes(idea.status as Status)) return;
    if (idea.status === col) return;
    // Promotion to CONVICTION always goes through the gate so the user
    // has to write a thesis first. Other moves (back to watching) don't
    // need the ceremony.
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
            const isTradeDriven = TRADE_STAGES.includes(col.key);
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
                  {isTradeDriven && (
                    <span
                      className="text-[9px] text-muted-foreground/70"
                      title="Stage is controlled by trade data — not drag-droppable"
                    >
                      auto
                    </span>
                  )}
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
                        currentPrice={prices[idea.symbol] ?? null}
                        dragging={draggingId === idea.id}
                        onDragStart={(e) => onCardDragStart(e, idea)}
                        onDragEnd={onCardDragEnd}
                        onForward={() => setConvictionFor(idea)}
                        onBackward={() => changeStatus(idea, "watching")}
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
      <SwingConvictionGate
        idea={convictionFor}
        open={convictionFor !== null}
        onOpenChange={(v) => !v && setConvictionFor(null)}
        onConfirmed={load}
      />
    </div>
  );
}

// ---------- Card variants ----------

function IdeaCard(props: {
  idea: SwingIdea;
  currentPrice: number | null;
  dragging: boolean;
  onDragStart: (e: React.DragEvent<HTMLDivElement>) => void;
  onDragEnd: () => void;
  onForward: () => void;
  onBackward: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { idea } = props;
  if (idea.status === "entered") {
    return (
      <EnteredCard
        idea={idea}
        currentPrice={props.currentPrice}
        onEdit={props.onEdit}
      />
    );
  }
  if (idea.status === "exited") return <ExitedCard idea={idea} />;
  return (
    <ManualCard
      idea={idea}
      dragging={props.dragging}
      onDragStart={props.onDragStart}
      onDragEnd={props.onDragEnd}
      onForward={props.onForward}
      onBackward={props.onBackward}
      onEdit={props.onEdit}
      onDelete={props.onDelete}
    />
  );
}

// Shared header: symbol + sentiment pill.
function CardHeader({ idea }: { idea: SwingIdea }) {
  return (
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
  );
}

// Manual-stage card (WATCHING / CONVICTION) — directional Move + Edit + Delete.
function ManualCard({
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
  const isWatching = idea.status === "watching";
  const watchingSummary =
    idea.catalyst?.trim() || idea.user_thesis?.trim() || idea.ai_summary?.trim() || "";
  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className={`cursor-grab rounded-md border border-border bg-zinc-900/60 p-3 text-xs active:cursor-grabbing ${
        dragging ? "opacity-40" : ""
      }`}
    >
      <CardHeader idea={idea} />

      {isWatching ? (
        <>
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

          {watchingSummary && (
            <div className="mb-2 line-clamp-1 italic text-muted-foreground">
              &ldquo;{watchingSummary}&rdquo;
            </div>
          )}
        </>
      ) : (
        // CONVICTION card: lead with the user-articulated thesis +
        // exit condition that the gate captured. Fundamentals are
        // less load-bearing here than the trader's own framing.
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

      <div className="mb-2 flex items-center justify-between">
        <span className="rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-muted-foreground">
          {timeframeLabel(idea.timeframe)}
        </span>
        <StarRating value={idea.conviction ?? 0} readonly size="xs" />
      </div>

      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={isWatching ? onForward : onBackward}
          className="flex flex-1 items-center justify-center gap-1 rounded border border-border py-1 text-[11px] text-muted-foreground hover:bg-white/5 hover:text-foreground"
          title={isWatching ? "Mark as Conviction" : "Back to Watching"}
        >
          {isWatching ? (
            <>
              <ArrowRight className="h-3 w-3" />
              Mark as Conviction
            </>
          ) : (
            <>
              <ArrowLeft className="h-3 w-3" />
              Back to Watching
            </>
          )}
        </button>
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

function EnteredCard({
  idea,
  currentPrice,
  onEdit,
}: {
  idea: SwingIdea;
  currentPrice: number | null;
  onEdit: () => void;
}) {
  const trade = idea.active_trade ?? null;
  const entry = trade?.entry_price ?? null;
  const shares = trade?.shares ?? null;
  const heldDays = daysBetween(trade?.entry_date ?? null, null);

  const unrealizedPnl =
    currentPrice !== null && entry !== null && shares !== null
      ? (currentPrice - entry) * shares
      : null;
  const unrealizedPct =
    currentPrice !== null && entry !== null && entry > 0
      ? (currentPrice - entry) / entry
      : null;
  const pnlColor =
    unrealizedPnl === null
      ? "text-muted-foreground"
      : unrealizedPnl >= 0
        ? "text-emerald-300"
        : "text-rose-300";

  return (
    <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3 text-xs">
      <CardHeader idea={idea} />

      <div className="mb-1 flex items-baseline gap-2 text-[11px]">
        <span className="text-muted-foreground">Entry</span>
        <span className="font-mono text-foreground">{fmtMoney(entry)}</span>
        <span className="text-muted-foreground">→</span>
        <span className="font-mono text-foreground">
          {currentPrice !== null ? fmtMoney(currentPrice) : "…"}
        </span>
      </div>

      <div className="mb-1 text-[11px]">
        <span className="text-muted-foreground">Unrealized: </span>
        <span className={`font-medium ${pnlColor}`}>
          {fmtMoney(unrealizedPnl, true)}
        </span>
        <span className={`ml-1 ${pnlColor}`}>({fmtPct(unrealizedPct, 1)})</span>
      </div>

      <div className="mb-2 text-[11px] text-muted-foreground">
        {shares !== null && <>{shares} shares · </>}
        {heldDays !== null ? `${heldDays} day${heldDays === 1 ? "" : "s"} held` : "—"}
      </div>

      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={onEdit}
          className="flex flex-1 items-center justify-center gap-1 rounded border border-border py-1 text-[11px] text-muted-foreground hover:bg-white/5 hover:text-foreground"
        >
          <Pencil className="h-3 w-3" />
          Edit thesis
        </button>
        <Link
          href={`/swings/journal/trades?symbol=${encodeURIComponent(idea.symbol)}`}
          className="flex items-center justify-center gap-1 rounded border border-border px-2 py-1 text-[11px] text-muted-foreground hover:bg-white/5 hover:text-foreground"
        >
          <ExternalLink className="h-3 w-3" />
          Trades
        </Link>
      </div>
    </div>
  );
}

function ExitedCard({ idea }: { idea: SwingIdea }) {
  const trade = idea.active_trade ?? null;
  const entry = trade?.entry_price ?? null;
  const exit = trade?.exit_price ?? null;
  const realized = trade?.realized_pnl ?? null;
  const returnPct = trade?.return_pct ?? null;
  const heldDays = daysBetween(trade?.entry_date ?? null, trade?.exit_date ?? null);
  const reason = exitReasonLabel(trade?.exit_reason ?? null);
  const pnlColor =
    realized === null
      ? "text-muted-foreground"
      : realized >= 0
        ? "text-emerald-300"
        : "text-rose-300";

  return (
    <div className="rounded-md border border-border bg-zinc-900/60 p-3 text-xs opacity-90">
      <CardHeader idea={idea} />

      <div className="mb-1 flex items-baseline gap-2 text-[11px]">
        <span className="text-muted-foreground">Entry</span>
        <span className="font-mono text-foreground">{fmtMoney(entry)}</span>
        <span className="text-muted-foreground">→</span>
        <span className="text-muted-foreground">Exit</span>
        <span className="font-mono text-foreground">{fmtMoney(exit)}</span>
      </div>

      <div className="mb-1 text-[11px]">
        <span className="text-muted-foreground">Realized: </span>
        <span className={`font-medium ${pnlColor}`}>{fmtMoney(realized, true)}</span>
        <span className={`ml-1 ${pnlColor}`}>({fmtPct(returnPct, 1)})</span>
      </div>

      <div className="mb-2 flex items-center gap-2 text-[11px] text-muted-foreground">
        <span>
          {heldDays !== null
            ? `${heldDays} day${heldDays === 1 ? "" : "s"} held`
            : "—"}
        </span>
        {reason && (
          <>
            <span>·</span>
            <span>{reason}</span>
          </>
        )}
      </div>

      <div className="flex items-center gap-1">
        <Link
          href={`/swings/journal/trades?symbol=${encodeURIComponent(idea.symbol)}`}
          className="flex flex-1 items-center justify-center gap-1 rounded border border-border py-1 text-[11px] text-muted-foreground hover:bg-white/5 hover:text-foreground"
        >
          <ExternalLink className="h-3 w-3" />
          View in Trades
        </Link>
      </div>
    </div>
  );
}


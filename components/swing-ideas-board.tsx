"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ArrowRight, ExternalLink, Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  SwingIdeaDialog,
  type SwingIdea,
} from "@/components/swing-idea-dialog";

type Status = "setup_ready" | "entered" | "exited";

const COLUMNS: Array<{ key: Status; label: string }> = [
  { key: "setup_ready", label: "Setup Ready" },
  { key: "entered", label: "Entered" },
  { key: "exited", label: "Exited" },
];

// Only SETUP READY accepts manual moves. ENTERED/EXITED are reached either
// through the explicit "Move to Entered" button on a setup card or via
// trade import, both of which call PATCH directly — no drag/drop here.
const TRADE_STAGES: Status[] = ["entered", "exited"];

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

  const byStatus: Record<Status, SwingIdea[]> = {
    setup_ready: [],
    entered: [],
    exited: [],
  };
  for (const idea of ideas) {
    const key = (idea.status as Status) ?? "setup_ready";
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
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {COLUMNS.map((col) => {
            const list = byStatus[col.key];
            const isTradeDriven = TRADE_STAGES.includes(col.key);
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
                  {isTradeDriven && (
                    <span
                      className="text-[9px] text-muted-foreground/70"
                      title="Stage is controlled by trade data"
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
                        onMoveToEntered={() => changeStatus(idea, "entered")}
                        onEdit={() => setEditing(idea)}
                        onDelete={() => deleteIdea(idea)}
                      />
                    ))
                  )}
                </div>
                {col.key === "setup_ready" && (
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

// ---------- Card variants ----------

function IdeaCard(props: {
  idea: SwingIdea;
  currentPrice: number | null;
  onMoveToEntered: () => void;
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
    <SetupReadyCard
      idea={idea}
      onMoveToEntered={props.onMoveToEntered}
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

function SetupReadyCard({
  idea,
  onMoveToEntered,
  onEdit,
  onDelete,
}: {
  idea: SwingIdea;
  onMoveToEntered: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const summary =
    idea.catalyst?.trim() || idea.user_thesis?.trim() || idea.ai_summary?.trim() || "";
  return (
    <div className="rounded-md border border-border bg-zinc-900/60 p-3 text-xs">
      <CardHeader idea={idea} />

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
      </div>

      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={onMoveToEntered}
          className="flex flex-1 items-center justify-center gap-1 rounded border border-border py-1 text-[11px] text-muted-foreground hover:bg-white/5 hover:text-foreground"
          title="Move to Entered"
        >
          <ArrowRight className="h-3 w-3" />
          Move to Entered
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

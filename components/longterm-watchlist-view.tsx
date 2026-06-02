"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Plus, Trash2, X } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Allocation = "Large" | "Medium" | "Small";

type Row = {
  id: string;
  symbol: string;
  allocation: Allocation;
  notes: string | null;
  created_at: string;
  updated_at: string;
  companyName: string | null;
  price: number | null;
  changePct: number | null;
  fiftyTwoWeekLow: number | null;
  fiftyTwoWeekHigh: number | null;
  pctFromFiftyTwoWeekHigh: number | null;
  marketCap: number | null;
  trailingPE: number | null;
  forwardPE: number | null;
  pegRatio: number | null;
  twoHundredDayAverage: number | null;
  pctVs200dSma: number | null;
  aiSignal: "Bull" | "Neutral" | "Bear";
  aiScore: number;
  hasEncyclopedia: boolean;
};

function fmtMoney(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  return `$${n.toFixed(2)}`;
}

function fmtPct(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  const sign = n >= 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}

function fmtRatio(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  return n.toFixed(1);
}

function fmtMarketCap(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  if (n >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  return `$${n.toLocaleString()}`;
}

function allocationBadge(a: Allocation): string {
  switch (a) {
    case "Large":
      return "border-sky-500/40 bg-sky-500/10 text-sky-300";
    case "Medium":
      return "border-amber-500/40 bg-amber-500/10 text-amber-300";
    case "Small":
      return "border-muted-foreground/30 bg-muted-foreground/10 text-muted-foreground";
  }
}

function pegColor(peg: number | null): string {
  if (peg === null || !Number.isFinite(peg)) return "text-muted-foreground";
  if (peg < 1.5) return "text-emerald-300";
  if (peg <= 2) return "text-amber-300";
  return "text-rose-300";
}

function aiSignalBadge(signal: "Bull" | "Neutral" | "Bear"): string {
  switch (signal) {
    case "Bull":
      return "border-emerald-500/40 bg-emerald-500/10 text-emerald-300";
    case "Bear":
      return "border-rose-500/40 bg-rose-500/10 text-rose-300";
    case "Neutral":
      return "border-muted-foreground/30 bg-muted-foreground/10 text-muted-foreground";
  }
}

export function LongTermWatchlistView() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/longterm/watchlist", { cache: "no-store" });
      const json = (await res.json()) as { watchlist?: Row[]; error?: string };
      if (!res.ok || json.error) {
        throw new Error(json.error ?? `HTTP ${res.status}`);
      }
      setRows(json.watchlist ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  async function onDelete(row: Row) {
    if (!confirm(`Remove ${row.symbol} from the watchlist?`)) return;
    try {
      const res = await fetch(
        `/api/longterm/watchlist?id=${encodeURIComponent(row.id)}`,
        { method: "DELETE" },
      );
      const json = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || json.error) {
        throw new Error(json.error ?? `HTTP ${res.status}`);
      }
      setRows((prev) => (prev ? prev.filter((r) => r.id !== row.id) : prev));
      setToast(`${row.symbol} removed.`);
    } catch (e) {
      setToast(e instanceof Error ? e.message : "Delete failed");
    }
  }

  async function onSaveNotes(row: Row, notes: string) {
    try {
      const res = await fetch("/api/longterm/watchlist", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: row.id, notes }),
      });
      const json = (await res.json()) as { row?: Row; error?: string };
      if (!res.ok || json.error || !json.row) {
        throw new Error(json.error ?? `HTTP ${res.status}`);
      }
      // Merge DB-side fields (id/notes/updated_at); keep live enrichment.
      setRows((prev) =>
        prev
          ? prev.map((r) =>
              r.id === row.id
                ? { ...r, notes: json.row!.notes, updated_at: json.row!.updated_at }
                : r,
            )
          : prev,
      );
      setToast("Notes saved.");
    } catch (e) {
      setToast(e instanceof Error ? e.message : "Save failed");
    }
  }

  async function onSetAllocation(row: Row, allocation: Allocation) {
    try {
      const res = await fetch("/api/longterm/watchlist", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: row.id, allocation }),
      });
      const json = (await res.json()) as { row?: Row; error?: string };
      if (!res.ok || json.error || !json.row) {
        throw new Error(json.error ?? `HTTP ${res.status}`);
      }
      // Allocation change shuffles sort order — refetch is simpler than
      // re-sorting locally.
      void refetch();
      setToast(`${row.symbol} → ${allocation}.`);
    } catch (e) {
      setToast(e instanceof Error ? e.message : "Update failed");
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">
            Long-Term Portfolio
          </h1>
          <p className="text-sm text-muted-foreground">
            Allocation buckets + live valuation. Click a row to edit notes.
          </p>
        </div>
        <Button onClick={() => setAddOpen(true)}>
          <Plus className="mr-1 h-4 w-4" /> Add Stock
        </Button>
      </div>

      {toast && (
        <div className="rounded border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200">
          {toast}
        </div>
      )}
      {error && (
        <div className="rounded border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
          {error}
        </div>
      )}

      <div className="overflow-x-auto rounded-md border border-border bg-background/40">
        <table className="w-full text-xs">
          <thead className="border-b border-border bg-background/60 text-[11px] uppercase tracking-wider text-muted-foreground">
            <tr>
              <th className="px-2 py-2 text-left">Symbol</th>
              <th className="px-2 py-2 text-left">Name</th>
              <th className="px-2 py-2 text-left">Allocation</th>
              <th className="px-2 py-2 text-right">Price</th>
              <th className="px-2 py-2 text-right">Change%</th>
              <th className="px-2 py-2 text-right">vs 200d</th>
              <th className="px-2 py-2 text-right">P/E</th>
              <th className="px-2 py-2 text-right">Fwd P/E</th>
              <th className="px-2 py-2 text-right">PEG</th>
              <th className="px-2 py-2 text-right">52w Range</th>
              <th className="px-2 py-2 text-right">% off 52wH</th>
              <th className="px-2 py-2 text-right">Mkt Cap</th>
              <th className="px-2 py-2 text-center">AI Signal</th>
              <th className="px-2 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {loading && rows === null && (
              <tr>
                <td colSpan={14} className="px-2 py-8 text-center">
                  <Loader2 className="mx-auto h-4 w-4 animate-spin text-muted-foreground" />
                </td>
              </tr>
            )}
            {!loading && rows && rows.length === 0 && (
              <tr>
                <td colSpan={14} className="px-2 py-8 text-center text-muted-foreground">
                  No symbols yet. Use Add Stock to start.
                </td>
              </tr>
            )}
            {rows?.map((r) => (
              <WatchRow
                key={r.id}
                row={r}
                onDelete={() => onDelete(r)}
                onSaveNotes={(notes) => onSaveNotes(r, notes)}
                onSetAllocation={(a) => onSetAllocation(r, a)}
              />
            ))}
          </tbody>
        </table>
      </div>

      <AddStockDialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onAdded={(symbol) => {
          setAddOpen(false);
          setToast(`${symbol} added.`);
          void refetch();
        }}
      />
    </div>
  );
}

function WatchRow({
  row,
  onDelete,
  onSaveNotes,
  onSetAllocation,
}: {
  row: Row;
  onDelete: () => void;
  onSaveNotes: (notes: string) => void;
  onSetAllocation: (a: Allocation) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [draftNotes, setDraftNotes] = useState(row.notes ?? "");
  const changeColor =
    row.changePct === null
      ? "text-muted-foreground"
      : row.changePct >= 0
        ? "text-emerald-300"
        : "text-rose-300";
  const smaColor =
    row.pctVs200dSma === null
      ? "text-muted-foreground"
      : row.pctVs200dSma >= 0
        ? "text-emerald-300"
        : "text-rose-300";
  const high52Color =
    row.pctFromFiftyTwoWeekHigh === null
      ? "text-muted-foreground"
      : row.pctFromFiftyTwoWeekHigh >= -5
        ? "text-emerald-300"
        : row.pctFromFiftyTwoWeekHigh >= -20
          ? "text-amber-300"
          : "text-rose-300";

  return (
    <>
      <tr
        onClick={() => setExpanded((s) => !s)}
        className="cursor-pointer border-b border-border/40 hover:bg-background/60"
      >
        <td className="px-2 py-1.5 font-mono font-semibold">{row.symbol}</td>
        <td className="px-2 py-1.5 text-muted-foreground">{row.companyName ?? "—"}</td>
        <td className="px-2 py-1.5">
          <span
            className={cn(
              "rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider",
              allocationBadge(row.allocation),
            )}
          >
            {row.allocation}
          </span>
        </td>
        <td className="px-2 py-1.5 text-right font-mono">{fmtMoney(row.price)}</td>
        <td className={cn("px-2 py-1.5 text-right font-mono", changeColor)}>
          {fmtPct(row.changePct)}
        </td>
        <td className={cn("px-2 py-1.5 text-right font-mono", smaColor)}>
          {fmtPct(row.pctVs200dSma)}
        </td>
        <td className="px-2 py-1.5 text-right font-mono">{fmtRatio(row.trailingPE)}</td>
        <td className="px-2 py-1.5 text-right font-mono">{fmtRatio(row.forwardPE)}</td>
        <td className={cn("px-2 py-1.5 text-right font-mono", pegColor(row.pegRatio))}>
          {row.pegRatio !== null && Number.isFinite(row.pegRatio)
            ? row.pegRatio.toFixed(2)
            : "—"}
        </td>
        <td className="px-2 py-1.5 text-right font-mono text-muted-foreground">
          {row.fiftyTwoWeekLow !== null && row.fiftyTwoWeekHigh !== null
            ? `${row.fiftyTwoWeekLow.toFixed(0)}–${row.fiftyTwoWeekHigh.toFixed(0)}`
            : "—"}
        </td>
        <td className={cn("px-2 py-1.5 text-right font-mono", high52Color)}>
          {fmtPct(row.pctFromFiftyTwoWeekHigh)}
        </td>
        <td className="px-2 py-1.5 text-right font-mono text-muted-foreground">
          {fmtMarketCap(row.marketCap)}
        </td>
        <td className="px-2 py-1.5 text-center">
          <span
            className={cn(
              "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider",
              aiSignalBadge(row.aiSignal),
            )}
            title={`Score ${row.aiScore >= 0 ? "+" : ""}${row.aiScore} — see route.ts computeAiSignal for the rule cascade${row.hasEncyclopedia ? "\nEncyclopedia research available — click the symbol header." : ""}`}
          >
            {row.aiSignal}
            {row.hasEncyclopedia && <span className="ml-0.5">📚</span>}
          </span>
        </td>
        <td className="px-2 py-1.5 text-right">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            className="rounded p-1 text-muted-foreground hover:bg-rose-500/15 hover:text-rose-300"
            title="Remove from watchlist"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </td>
      </tr>
      {expanded && (
        <tr className="border-b border-border/40 bg-background/30">
          <td colSpan={14} className="px-3 py-3">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-[1fr_auto]">
              <label className="block">
                <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
                  Notes
                </span>
                <textarea
                  value={draftNotes}
                  onChange={(e) => setDraftNotes(e.target.value)}
                  rows={3}
                  className="mt-1 w-full rounded border border-border bg-background px-2 py-1 text-xs"
                  placeholder="Thesis, watch levels, exit triggers…"
                />
                <div className="mt-2 flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => onSaveNotes(draftNotes)}
                    disabled={draftNotes === (row.notes ?? "")}
                  >
                    Save Notes
                  </Button>
                  {draftNotes !== (row.notes ?? "") && (
                    <button
                      type="button"
                      onClick={() => setDraftNotes(row.notes ?? "")}
                      className="text-[11px] text-muted-foreground hover:text-foreground"
                    >
                      Reset
                    </button>
                  )}
                </div>
              </label>
              <div className="flex flex-col items-start gap-2">
                <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
                  Move to
                </span>
                <div className="flex gap-1">
                  {(["Large", "Medium", "Small"] as Allocation[]).map((a) => (
                    <button
                      key={a}
                      type="button"
                      onClick={() => onSetAllocation(a)}
                      disabled={a === row.allocation}
                      className={cn(
                        "rounded border px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider",
                        a === row.allocation
                          ? allocationBadge(a)
                          : "border-border bg-background text-muted-foreground hover:border-foreground/40 hover:text-foreground",
                      )}
                    >
                      {a}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function AddStockDialog({
  open,
  onClose,
  onAdded,
}: {
  open: boolean;
  onClose: () => void;
  onAdded: (symbol: string) => void;
}) {
  const [symbol, setSymbol] = useState("");
  const [allocation, setAllocation] = useState<Allocation>("Large");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setSymbol("");
      setAllocation("Large");
      setNotes("");
      setError(null);
    }
  }, [open]);

  async function submit() {
    const s = symbol.trim().toUpperCase();
    if (!s) {
      setError("Symbol required");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/longterm/watchlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol: s,
          allocation,
          notes: notes.trim() || undefined,
        }),
      });
      const json = (await res.json()) as { row?: Row; error?: string };
      if (!res.ok || json.error) {
        throw new Error(json.error ?? `HTTP ${res.status}`);
      }
      onAdded(s);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to add");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add stock to watchlist</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <label className="block">
            <span className="text-xs text-muted-foreground">Symbol</span>
            <input
              value={symbol}
              onChange={(e) => setSymbol(e.target.value.toUpperCase())}
              placeholder="e.g. MSFT"
              className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1 uppercase"
            />
          </label>
          <label className="block">
            <span className="text-xs text-muted-foreground">Allocation</span>
            <select
              value={allocation}
              onChange={(e) => setAllocation(e.target.value as Allocation)}
              className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1"
            >
              <option value="Large">Large</option>
              <option value="Medium">Medium</option>
              <option value="Small">Small</option>
            </select>
          </label>
          <label className="block">
            <span className="text-xs text-muted-foreground">Notes (optional)</span>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1"
              placeholder="Thesis, target, watch levels…"
            />
          </label>
          {error && (
            <div className="rounded border border-rose-500/40 bg-rose-500/10 px-2 py-1 text-xs text-rose-200">
              {error}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose} disabled={submitting}>
            <X className="mr-1 h-3.5 w-3.5" />
            Cancel
          </Button>
          <Button onClick={submit} disabled={submitting}>
            {submitting ? (
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Plus className="mr-1 h-3.5 w-3.5" />
            )}
            Add
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

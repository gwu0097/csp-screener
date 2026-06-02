"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ChevronDown, ChevronUp, Loader2, Plus, Trash2, X } from "lucide-react";
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
type Action = "TAKE_PROFIT" | "DCA" | "CUT" | "HOLD";

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
  momentum3mPct: number | null;
  aiSignal: "Bull" | "Neutral" | "Bear";
  aiScore: number;
  action: Action;
  hasEncyclopedia: boolean;
};

type Alert = {
  kind: "big_move" | "falling_knife" | "extended";
  symbol: string;
  message: string;
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

function actionLabel(a: Action): string {
  switch (a) {
    case "TAKE_PROFIT":
      return "🟡 Take Profit";
    case "DCA":
      return "🟢 DCA";
    case "CUT":
      return "🔴 Cut";
    case "HOLD":
      return "⚪ Hold";
  }
}

function actionBadge(a: Action): string {
  switch (a) {
    case "TAKE_PROFIT":
      return "border-amber-500/40 bg-amber-500/10 text-amber-300";
    case "DCA":
      return "border-emerald-500/40 bg-emerald-500/10 text-emerald-300";
    case "CUT":
      return "border-rose-500/40 bg-rose-500/10 text-rose-300";
    case "HOLD":
      return "border-muted-foreground/30 bg-muted-foreground/10 text-muted-foreground";
  }
}

function alertBadgeClass(kind: Alert["kind"]): string {
  switch (kind) {
    case "big_move":
      return "border-sky-500/40 bg-sky-500/10 text-sky-200";
    case "falling_knife":
      return "border-rose-500/40 bg-rose-500/10 text-rose-200";
    case "extended":
      return "border-amber-500/40 bg-amber-500/10 text-amber-200";
  }
}

function alertKindLabel(kind: Alert["kind"]): string {
  switch (kind) {
    case "big_move":
      return "BIG MOVE";
    case "falling_knife":
      return "FALLING KNIFE";
    case "extended":
      return "EXTENDED";
  }
}

// Visual 52-week range bar. Left portion (low → current) tinted to
// flag headroom-already-consumed; right portion (current → high)
// stays neutral. Dot marks current price. Used inline in the row.
function FiftyTwoWeekBar({
  price,
  low,
  high,
}: {
  price: number | null;
  low: number | null;
  high: number | null;
}) {
  if (price === null || low === null || high === null || high <= low) {
    return <span className="text-muted-foreground">—</span>;
  }
  const fraction = Math.max(0, Math.min(1, (price - low) / (high - low)));
  const pctLeft = fraction * 100;
  return (
    <div className="flex flex-col items-stretch gap-0.5">
      <div className="relative h-2 w-24 overflow-hidden rounded bg-muted/30">
        <div
          className="absolute inset-y-0 left-0 bg-amber-500/50"
          style={{ width: `${pctLeft}%` }}
        />
        <div
          className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border border-background bg-foreground"
          style={{ left: `${pctLeft}%` }}
        />
      </div>
      <div className="flex justify-between text-[9px] font-mono text-muted-foreground/70">
        <span>{low.toFixed(0)}</span>
        <span>{high.toFixed(0)}</span>
      </div>
    </div>
  );
}

export function LongTermWatchlistView() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [alertsOpen, setAlertsOpen] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/longterm/watchlist", { cache: "no-store" });
      const json = (await res.json()) as {
        watchlist?: Row[];
        alerts?: Alert[];
        error?: string;
      };
      if (!res.ok || json.error) {
        throw new Error(json.error ?? `HTTP ${res.status}`);
      }
      setRows(json.watchlist ?? []);
      setAlerts(json.alerts ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
      setRows([]);
      setAlerts([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const alertGroups = useMemo(() => {
    const byKind: Record<Alert["kind"], Alert[]> = {
      big_move: [],
      falling_knife: [],
      extended: [],
    };
    for (const a of alerts) byKind[a.kind].push(a);
    return byKind;
  }, [alerts]);

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

      <AlertsPanel
        alerts={alerts}
        groups={alertGroups}
        open={alertsOpen}
        onToggle={() => setAlertsOpen((s) => !s)}
      />

      <div className="overflow-x-auto rounded-md border border-border bg-background/40">
        <table className="w-full min-w-[1100px] text-xs">
          <thead className="border-b border-border bg-background/60 text-[11px] uppercase tracking-wider text-muted-foreground">
            <tr>
              <th className="px-2 py-2 text-left">Symbol</th>
              <th className="px-2 py-2 text-left">Name</th>
              <th className="px-2 py-2 text-left">Allocation</th>
              <th className="px-2 py-2 text-right">Price</th>
              <th className="px-2 py-2 text-right">Change%</th>
              <th className="px-2 py-2 text-center">52W Range</th>
              <th className="px-2 py-2 text-right">Trend (200d)</th>
              <th className="px-2 py-2 text-right">3M Mom</th>
              <th className="px-2 py-2 text-right">P/E</th>
              <th className="px-2 py-2 text-right">PEG</th>
              <th className="px-2 py-2 text-center">AI Signal</th>
              <th className="px-2 py-2 text-center">Action</th>
              <th className="px-2 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {loading && rows === null && (
              <tr>
                <td colSpan={13} className="px-2 py-8 text-center">
                  <Loader2 className="mx-auto h-4 w-4 animate-spin text-muted-foreground" />
                </td>
              </tr>
            )}
            {!loading && rows && rows.length === 0 && (
              <tr>
                <td colSpan={13} className="px-2 py-8 text-center text-muted-foreground">
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

function AlertsPanel({
  alerts,
  groups,
  open,
  onToggle,
}: {
  alerts: Alert[];
  groups: Record<Alert["kind"], Alert[]>;
  open: boolean;
  onToggle: () => void;
}) {
  if (alerts.length === 0) return null;
  const ordered = (
    [
      { kind: "falling_knife", items: groups.falling_knife },
      { kind: "extended", items: groups.extended },
      { kind: "big_move", items: groups.big_move },
    ] as Array<{ kind: Alert["kind"]; items: Alert[] }>
  ).filter((g) => g.items.length > 0);
  const total = alerts.length;
  return (
    <div className="rounded-md border border-border bg-background/40">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-background/60"
      >
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold">Signals & Alerts</span>
          <span className="rounded border border-border bg-background px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            {total} active
          </span>
        </div>
        {open ? (
          <ChevronUp className="h-4 w-4 text-muted-foreground" />
        ) : (
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        )}
      </button>
      {open && (
        <div className="space-y-2 border-t border-border px-3 py-3 text-xs">
          {ordered.map(({ kind, items }) => (
            <div key={kind} className="space-y-1">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                {alertKindLabel(kind)} · {items.length}
              </div>
              <ul className="space-y-1">
                {items.map((a, i) => (
                  <li
                    key={`${a.kind}-${a.symbol}-${i}`}
                    className="flex items-center justify-between gap-3 rounded border border-border/60 bg-background/40 px-2 py-1.5"
                  >
                    <span className="flex items-center gap-2">
                      <span
                        className={cn(
                          "rounded border px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wider",
                          alertBadgeClass(a.kind),
                        )}
                      >
                        {alertKindLabel(a.kind)}
                      </span>
                      <span>{a.message}</span>
                    </span>
                    <Link
                      href={`/longterm/research?symbol=${encodeURIComponent(a.symbol)}`}
                      className="rounded border border-border bg-background px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground hover:border-foreground/40 hover:text-foreground"
                    >
                      Deep Research →
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
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

  const momentumColor =
    row.momentum3mPct === null
      ? "text-muted-foreground"
      : row.momentum3mPct >= 0
        ? "text-emerald-300"
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
        <td
          className={cn("px-2 py-1.5 align-middle", high52Color)}
          title={
            row.pctFromFiftyTwoWeekHigh !== null
              ? `${row.pctFromFiftyTwoWeekHigh.toFixed(1)}% from 52w high`
              : undefined
          }
        >
          <div className="flex items-center justify-center">
            <FiftyTwoWeekBar
              price={row.price}
              low={row.fiftyTwoWeekLow}
              high={row.fiftyTwoWeekHigh}
            />
          </div>
        </td>
        <td className={cn("px-2 py-1.5 text-right font-mono", smaColor)}>
          {fmtPct(row.pctVs200dSma)}
        </td>
        <td className={cn("px-2 py-1.5 text-right font-mono", momentumColor)}>
          {fmtPct(row.momentum3mPct)}
        </td>
        <td className="px-2 py-1.5 text-right font-mono">{fmtRatio(row.trailingPE)}</td>
        <td className={cn("px-2 py-1.5 text-right font-mono", pegColor(row.pegRatio))}>
          {row.pegRatio !== null && Number.isFinite(row.pegRatio)
            ? row.pegRatio.toFixed(2)
            : "—"}
        </td>
        <td className="px-2 py-1.5 text-center">
          <span
            className={cn(
              "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider",
              aiSignalBadge(row.aiSignal),
            )}
            title={`Score ${row.aiScore >= 0 ? "+" : ""}${row.aiScore} — see route.ts computeAiSignal for the rule cascade${row.hasEncyclopedia ? "\nEncyclopedia research available." : ""}`}
          >
            {row.aiSignal}
            {row.hasEncyclopedia && <span className="ml-0.5">📚</span>}
          </span>
        </td>
        <td className="px-2 py-1.5 text-center">
          <span
            className={cn(
              "inline-block rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider whitespace-nowrap",
              actionBadge(row.action),
            )}
            title="Action signal — see route.ts computeAction"
          >
            {actionLabel(row.action)}
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
          <td colSpan={13} className="px-3 py-3">
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

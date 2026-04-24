"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Camera, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  SwingTradeDialog,
  type SwingTrade,
} from "@/components/swing-trade-dialog";
import { ImportStockScreenshotModal } from "@/components/import-stock-screenshot-modal";

function fmtMoney(n: number | null, signed = false): string {
  if (n === null || !Number.isFinite(n)) return "—";
  const sign = signed && n > 0 ? "+" : "";
  return `${sign}$${n.toFixed(2)}`;
}

function fmtPct(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  return `${(n * 100).toFixed(2)}%`;
}

function exitReasonLabel(r: string | null): string {
  if (r === "target_hit") return "Target hit";
  if (r === "stop_loss") return "Stop loss";
  if (r === "thesis_broken") return "Thesis broken";
  if (r === "manual") return "Manual";
  return "—";
}

export function SwingTradesView() {
  const searchParams = useSearchParams();
  const prefillSymbol = searchParams.get("prefill");
  const prefillIdeaId = searchParams.get("ideaId");

  const [trades, setTrades] = useState<SwingTrade[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/swings/trades", { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setTrades(json.trades as SwingTrade[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    if (prefillSymbol) setDialogOpen(true);
  }, [prefillSymbol]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return trades;
    return trades.filter((t) => t.symbol.toLowerCase().includes(q));
  }, [trades, search]);

  // Drop selections that are no longer visible after a filter change or
  // after deletes — prevents "ghost" selections piling up.
  useEffect(() => {
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const visible = new Set(filtered.map((t) => t.id));
      let changed = false;
      const next = new Set<string>();
      Array.from(prev).forEach((id) => {
        if (visible.has(id)) next.add(id);
        else changed = true;
      });
      return changed ? next : prev;
    });
  }, [filtered]);

  const visibleIds = useMemo(() => filtered.map((t) => t.id), [filtered]);
  const allVisibleSelected =
    visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
  const someVisibleSelected =
    !allVisibleSelected && visibleIds.some((id) => selected.has(id));

  const headerCheckboxRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (headerCheckboxRef.current) {
      headerCheckboxRef.current.indeterminate = someVisibleSelected;
    }
  }, [someVisibleSelected]);

  function toggleRow(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAllVisible() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) {
        for (const id of visibleIds) next.delete(id);
      } else {
        for (const id of visibleIds) next.add(id);
      }
      return next;
    });
  }

  async function deleteTrades(ids: string[]) {
    if (ids.length === 0) return;
    setDeleting(true);
    setError(null);
    let ok = 0;
    let failed = 0;
    let reverted = 0;
    // Sequential: deletes for the same symbol must see each other so the
    // revert check on the final delete observes 0 remaining trades.
    for (const id of ids) {
      try {
        const res = await fetch(`/api/swings/trades/${id}`, { method: "DELETE" });
        const json = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          idea_reverted?: boolean;
          error?: string;
        };
        if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
        ok += 1;
        if (json.idea_reverted) reverted += 1;
      } catch (e) {
        failed += 1;
        console.error(`[swings/trades] delete ${id} failed:`, e);
      }
    }
    setDeleting(false);
    setSelected(new Set());
    await load();
    const parts = [
      `Deleted ${ok} ${ok === 1 ? "trade" : "trades"}`,
      reverted > 0 ? `${reverted} idea${reverted === 1 ? "" : "s"} reverted` : null,
      failed > 0 ? `${failed} failed` : null,
    ].filter(Boolean);
    setToast(parts.join(" · "));
    setTimeout(() => setToast(null), 5000);
  }

  async function onBulkDelete() {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    if (
      !window.confirm(
        `Delete ${ids.length} ${ids.length === 1 ? "trade" : "trades"}? This cannot be undone.`,
      )
    )
      return;
    await deleteTrades(ids);
  }

  async function onDeleteRow(trade: SwingTrade) {
    if (!window.confirm(`Delete ${trade.symbol} trade? This cannot be undone.`)) return;
    await deleteTrades([trade.id]);
  }

  const selectedCount = selected.size;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search ticker..."
          className="w-full max-w-xs rounded border border-border bg-background px-3 py-1.5 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-foreground/40"
        />
        <div className="flex items-center gap-2">
          {selectedCount > 0 ? (
            <Button
              onClick={onBulkDelete}
              disabled={deleting}
              className="bg-rose-600 text-white hover:bg-rose-500"
            >
              <Trash2 className="mr-1 h-4 w-4" />
              {deleting
                ? `Deleting…`
                : `Delete Selected (${selectedCount})`}
            </Button>
          ) : (
            <>
              <Button onClick={() => setImportOpen(true)}>
                <Camera className="mr-1 h-4 w-4" /> Import from screenshot
              </Button>
              <Button variant="outline" onClick={() => setDialogOpen(true)}>
                <Plus className="mr-1 h-4 w-4" /> Log Trade
              </Button>
            </>
          )}
        </div>
      </div>

      <div className="text-xs text-muted-foreground">
        Showing {filtered.length} of {trades.length}{" "}
        {trades.length === 1 ? "trade" : "trades"}
      </div>

      {toast && (
        <div className="rounded border border-emerald-500/40 bg-emerald-500/10 p-2 text-xs text-emerald-200">
          {toast}
        </div>
      )}

      {error && (
        <div className="rounded border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-300">
          {error}
        </div>
      )}

      {loading && trades.length === 0 ? (
        <div className="text-sm text-muted-foreground">Loading trades…</div>
      ) : trades.length === 0 ? (
        <div className="rounded border border-border bg-background/40 p-6 text-sm text-muted-foreground">
          No swing trades logged yet. Click &ldquo;Log Trade&rdquo; to add one.
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded border border-border bg-background/40 p-6 text-sm text-muted-foreground">
          No trades match &ldquo;{search}&rdquo;.
        </div>
      ) : (
        <div className="overflow-x-auto rounded border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8">
                  <input
                    ref={headerCheckboxRef}
                    type="checkbox"
                    checked={allVisibleSelected}
                    onChange={toggleAllVisible}
                    aria-label="Select all visible trades"
                    className="h-3.5 w-3.5 cursor-pointer rounded border-border bg-background"
                  />
                </TableHead>
                <TableHead>Symbol</TableHead>
                <TableHead>Entry</TableHead>
                <TableHead className="text-right">Entry $</TableHead>
                <TableHead className="text-right">Exit $</TableHead>
                <TableHead className="text-right">Shares</TableHead>
                <TableHead className="text-right">P&amp;L</TableHead>
                <TableHead className="text-right">Return %</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Exit Reason</TableHead>
                <TableHead className="w-8" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((t) => {
                const pnlColor =
                  t.realized_pnl === null
                    ? ""
                    : t.realized_pnl >= 0
                      ? "text-emerald-300"
                      : "text-rose-300";
                const isSelected = selected.has(t.id);
                return (
                  <TableRow
                    key={t.id}
                    className={isSelected ? "bg-muted/20" : undefined}
                  >
                    <TableCell className="w-8">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleRow(t.id)}
                        aria-label={`Select ${t.symbol} trade`}
                        className="h-3.5 w-3.5 cursor-pointer rounded border-border bg-background"
                      />
                    </TableCell>
                    <TableCell className="font-mono">{t.symbol}</TableCell>
                    <TableCell className="text-xs">{t.entry_date ?? "—"}</TableCell>
                    <TableCell className="text-right">
                      {fmtMoney(t.entry_price)}
                    </TableCell>
                    <TableCell className="text-right">
                      {fmtMoney(t.exit_price)}
                    </TableCell>
                    <TableCell className="text-right">{t.shares ?? "—"}</TableCell>
                    <TableCell className={`text-right ${pnlColor}`}>
                      {fmtMoney(t.realized_pnl, true)}
                    </TableCell>
                    <TableCell className={`text-right ${pnlColor}`}>
                      {fmtPct(t.return_pct)}
                    </TableCell>
                    <TableCell className="text-xs capitalize">{t.status}</TableCell>
                    <TableCell className="text-xs">
                      {exitReasonLabel(t.exit_reason)}
                    </TableCell>
                    <TableCell className="w-8 text-right">
                      <button
                        type="button"
                        onClick={() => onDeleteRow(t)}
                        disabled={deleting}
                        className="text-muted-foreground hover:text-rose-300 disabled:opacity-50"
                        aria-label={`Delete ${t.symbol} trade`}
                        title="Delete trade"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      <SwingTradeDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        prefill={{
          symbol: prefillSymbol ?? undefined,
          swing_idea_id: prefillIdeaId ?? undefined,
        }}
        onSaved={load}
      />
      <ImportStockScreenshotModal
        open={importOpen}
        onOpenChange={setImportOpen}
        onSuccess={(msg) => {
          setToast(msg);
          setTimeout(() => setToast(null), 5000);
          load();
        }}
      />
    </div>
  );
}

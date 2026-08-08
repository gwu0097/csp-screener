"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Camera, Plus, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
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
import { SwingTradeExitDialog, EXIT_REASONS } from "@/components/swing-trade-exit-dialog";
import { ImportStockScreenshotModal } from "@/components/import-stock-screenshot-modal";

function fmtMoney(n: number | null, signed = false): string {
  if (n === null || !Number.isFinite(n)) return "—";
  const sign = signed && n > 0 ? "+" : "";
  return `${sign}$${n.toFixed(2)}`;
}

function fmtR(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}R`;
}

function fmtPct(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  return `${n.toFixed(1)}%`;
}

function exitReasonLabel(r: string | null): string {
  return EXIT_REASONS.find((x) => x.value === r)?.label ?? "—";
}

type FollowUpRow = {
  id: string;
  symbol: string;
  exit_date: string;
  exit_price: number | null;
  r_multiple: number | null;
  target_date: string;
  suggested_price: number | null;
};

function FollowUpPanel({ onDone }: { onDone: () => void }) {
  const [rows, setRows] = useState<FollowUpRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      const res = await fetch("/api/swings/trades/followups", { cache: "no-store" });
      const json = (await res.json()) as { trades?: FollowUpRow[] };
      const list = json.trades ?? [];
      setRows(list);
      setPrices((prev) => {
        const next = { ...prev };
        for (const r of list) {
          if (next[r.id] === undefined) {
            next[r.id] = r.suggested_price !== null ? String(r.suggested_price) : "";
          }
        }
        return next;
      });
    } catch {
      setRows([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  if (loading || rows.length === 0) return null;

  async function save(id: string) {
    setSaving(id);
    try {
      const price = prices[id]?.trim();
      const res = await fetch(`/api/swings/trades/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          price_two_weeks_after_exit: price ? Number(price) : null,
          exit_quality_note: notes[id]?.trim() || null,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setRows((prev) => prev.filter((r) => r.id !== id));
      onDone();
    } catch {
      // leave the row in place — user can retry
    } finally {
      setSaving(null);
    }
  }

  return (
    <div className="rounded border border-sky-500/40 bg-sky-500/5 p-3">
      <div className="mb-2 text-sm font-medium text-sky-200">
        {rows.length} closed {rows.length === 1 ? "trade needs" : "trades need"} a two-week
        follow-up — the only way to learn if an exit was early, late, or right.
      </div>
      <div className="space-y-2">
        {rows.map((r) => (
          <div key={r.id} className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-mono font-medium">{r.symbol}</span>
            <span className="text-xs text-muted-foreground">
              exited {fmtMoney(r.exit_price)} ({fmtR(r.r_multiple)}) on {r.exit_date}
            </span>
            <input
              type="number"
              step="0.01"
              value={prices[r.id] ?? ""}
              onChange={(e) => setPrices((p) => ({ ...p, [r.id]: e.target.value }))}
              placeholder="price ~2wk later"
              className="w-28 rounded border border-border bg-background px-2 py-1 text-sm"
            />
            <input
              type="text"
              value={notes[r.id] ?? ""}
              onChange={(e) => setNotes((n) => ({ ...n, [r.id]: e.target.value }))}
              placeholder="note (optional)"
              className="w-48 rounded border border-border bg-background px-2 py-1 text-sm"
            />
            <Button size="sm" onClick={() => void save(r.id)} disabled={saving === r.id}>
              {saving === r.id ? "Saving…" : "Save"}
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}

export function SwingTradesView() {
  const searchParams = useSearchParams();
  // swing-ideas-board.tsx links here with ?symbol=..., not ?prefill= — the
  // pre-rebuild view read the wrong param name (a pre-existing bug, not
  // introduced here) so "log trade" from an Ideas card silently didn't
  // prefill the symbol. Accept both; prefer symbol since that's what the
  // real caller sends.
  const prefillSymbol = searchParams.get("symbol") ?? searchParams.get("prefill");
  const prefillIdeaId = searchParams.get("ideaId");

  const [trades, setTrades] = useState<SwingTrade[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [exitTrade, setExitTrade] = useState<SwingTrade | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [refreshingExcursion, setRefreshingExcursion] = useState(false);

  const [search, setSearch] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [closedSort, setClosedSort] = useState<"asc" | "desc">("desc");
  const [livePrices, setLivePrices] = useState<Record<string, number | null>>({});

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

  const openTrades = useMemo(() => trades.filter((t) => t.status === "open"), [trades]);
  const closedTrades = useMemo(() => trades.filter((t) => t.status === "closed"), [trades]);

  // Live prices for the Open tab — same batch quote endpoint the Ideas
  // board already uses for entered positions.
  useEffect(() => {
    if (openTrades.length === 0) return;
    const symbols = Array.from(new Set(openTrades.map((t) => t.symbol))).join(",");
    fetch(`/api/swings/quotes?symbols=${encodeURIComponent(symbols)}`)
      .then((r) => r.json())
      .then((j: { prices?: Record<string, number | null> }) => setLivePrices(j.prices ?? {}))
      .catch(() => {});
  }, [openTrades]);

  async function refreshExcursion() {
    setRefreshingExcursion(true);
    try {
      await fetch("/api/swings/trades/excursion", { method: "POST", body: "{}" });
      await load();
    } finally {
      setRefreshingExcursion(false);
    }
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return trades;
    return trades.filter((t) => t.symbol.toLowerCase().includes(q));
  }, [trades, search]);

  const filteredOpen = useMemo(() => filtered.filter((t) => t.status === "open"), [filtered]);
  const filteredClosed = useMemo(() => {
    const rows = filtered.filter((t) => t.status === "closed");
    return [...rows].sort((a, b) => {
      const av = a.r_multiple ?? -Infinity;
      const bv = b.r_multiple ?? -Infinity;
      return closedSort === "asc" ? av - bv : bv - av;
    });
  }, [filtered, closedSort]);

  async function deleteTrades(ids: string[]) {
    if (ids.length === 0) return;
    setDeleting(true);
    setError(null);
    let ok = 0;
    let failed = 0;
    let reverted = 0;
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
    await load();
    const parts = [
      `Deleted ${ok} ${ok === 1 ? "trade" : "trades"}`,
      reverted > 0 ? `${reverted} idea${reverted === 1 ? "" : "s"} reverted` : null,
      failed > 0 ? `${failed} failed` : null,
    ].filter(Boolean);
    setToast(parts.join(" · "));
    setTimeout(() => setToast(null), 5000);
  }

  async function onDeleteRow(trade: SwingTrade) {
    if (!window.confirm(`Delete ${trade.symbol} trade? This cannot be undone.`)) return;
    await deleteTrades([trade.id]);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search ticker..."
          className="w-full max-w-xs rounded border border-border bg-background px-3 py-1.5 text-base placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-foreground/40"
        />
        <div className="flex items-center gap-2">
          <Button onClick={() => setImportOpen(true)}>
            <Camera className="mr-1 h-4 w-4" /> Import from screenshot
          </Button>
          <Button variant="outline" onClick={() => setDialogOpen(true)}>
            <Plus className="mr-1 h-4 w-4" /> Log Trade
          </Button>
        </div>
      </div>

      <FollowUpPanel onDone={load} />

      {toast && (
        <div className="rounded border border-emerald-500/40 bg-emerald-500/10 p-2 text-sm text-emerald-200">
          {toast}
        </div>
      )}
      {error && (
        <div className="rounded border border-rose-500/40 bg-rose-500/10 p-3 text-base text-rose-300">
          {error}
        </div>
      )}

      {loading && trades.length === 0 ? (
        <div className="text-base text-muted-foreground">Loading trades…</div>
      ) : trades.length === 0 ? (
        <div className="rounded border border-border bg-background/40 p-6 text-base text-muted-foreground">
          No swing trades logged yet. Click &ldquo;Log Trade&rdquo; to add one.
        </div>
      ) : (
        <Tabs defaultValue="open">
          <TabsList>
            <TabsTrigger value="open">Open ({openTrades.length})</TabsTrigger>
            <TabsTrigger value="closed">Closed ({closedTrades.length})</TabsTrigger>
          </TabsList>

          <TabsContent value="open">
            <div className="mb-2 flex items-center justify-between">
              <div className="text-sm text-muted-foreground">
                {filteredOpen.length} open position{filteredOpen.length === 1 ? "" : "s"}
              </div>
              <Button size="sm" variant="outline" onClick={() => void refreshExcursion()} disabled={refreshingExcursion}>
                <RefreshCw className={`mr-1 h-3.5 w-3.5 ${refreshingExcursion ? "animate-spin" : ""}`} />
                {refreshingExcursion ? "Refreshing…" : "Refresh MFE/MAE"}
              </Button>
            </div>
            {filteredOpen.length === 0 ? (
              <div className="rounded border border-border bg-background/40 p-6 text-base text-muted-foreground">
                No open positions.
              </div>
            ) : (
              <div className="overflow-x-auto rounded border border-border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Symbol</TableHead>
                      <TableHead className="text-right">Entry</TableHead>
                      <TableHead className="text-right">Stop</TableHead>
                      <TableHead className="text-right">Target</TableHead>
                      <TableHead className="text-right">Current</TableHead>
                      <TableHead className="text-right">Current R</TableHead>
                      <TableHead className="text-right">Dist to stop</TableHead>
                      <TableHead className="text-right">Days held</TableHead>
                      <TableHead className="w-20" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredOpen.map((t) => {
                      const current = livePrices[t.symbol] ?? null;
                      const riskPerShare = t.entry_price - t.planned_stop;
                      const currentR =
                        current !== null && riskPerShare > 0
                          ? (current - t.entry_price) / riskPerShare
                          : null;
                      const distToStop =
                        current !== null && current > 0 ? ((current - t.planned_stop) / current) * 100 : null;
                      const daysHeld = Math.round(
                        (Date.now() - new Date(t.entry_date + "T00:00:00Z").getTime()) / 86_400_000,
                      );
                      return (
                        <TableRow key={t.id}>
                          <TableCell className="font-mono">{t.symbol}</TableCell>
                          <TableCell className="text-right">{fmtMoney(t.entry_price)}</TableCell>
                          <TableCell className="text-right text-rose-300">{fmtMoney(t.planned_stop)}</TableCell>
                          <TableCell className="text-right text-emerald-300">
                            {t.planned_target !== null ? fmtMoney(t.planned_target) : "—"}
                          </TableCell>
                          <TableCell className="text-right">{fmtMoney(current)}</TableCell>
                          <TableCell
                            className={`text-right font-mono ${
                              currentR === null ? "" : currentR >= 0 ? "text-emerald-300" : "text-rose-300"
                            }`}
                          >
                            {fmtR(currentR)}
                          </TableCell>
                          <TableCell className="text-right">{fmtPct(distToStop)}</TableCell>
                          <TableCell className="text-right">{daysHeld}</TableCell>
                          <TableCell className="w-20 text-right">
                            <div className="flex justify-end gap-2">
                              <button
                                type="button"
                                onClick={() => setExitTrade(t)}
                                className="text-xs text-muted-foreground hover:text-foreground"
                              >
                                Close
                              </button>
                              <button
                                type="button"
                                onClick={() => onDeleteRow(t)}
                                disabled={deleting}
                                className="text-muted-foreground hover:text-rose-300 disabled:opacity-50"
                                aria-label={`Delete ${t.symbol} trade`}
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
          </TabsContent>

          <TabsContent value="closed">
            <div className="mb-2 text-sm text-muted-foreground">
              {filteredClosed.length} closed trade{filteredClosed.length === 1 ? "" : "s"}
            </div>
            {filteredClosed.length === 0 ? (
              <div className="rounded border border-border bg-background/40 p-6 text-base text-muted-foreground">
                No closed trades.
              </div>
            ) : (
              <div className="overflow-x-auto rounded border border-border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Symbol</TableHead>
                      <TableHead>Setup</TableHead>
                      <TableHead>Entry date</TableHead>
                      <TableHead>Exit date</TableHead>
                      <TableHead
                        className="cursor-pointer text-right select-none"
                        onClick={() => setClosedSort((s) => (s === "asc" ? "desc" : "asc"))}
                      >
                        R multiple {closedSort === "asc" ? "▲" : "▼"}
                      </TableHead>
                      <TableHead>Exit reason</TableHead>
                      <TableHead className="text-right">Days held</TableHead>
                      <TableHead className="w-8" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredClosed.map((t) => {
                      const rColor =
                        t.r_multiple === null ? "" : t.r_multiple >= 0 ? "text-emerald-300" : "text-rose-300";
                      return (
                        <TableRow key={t.id}>
                          <TableCell className="font-mono">{t.symbol}</TableCell>
                          <TableCell className="text-sm">{t.setup_name ?? "—"}</TableCell>
                          <TableCell className="text-sm">{t.entry_date}</TableCell>
                          <TableCell className="text-sm">{t.exit_date ?? "—"}</TableCell>
                          <TableCell className={`text-right font-mono ${rColor}`}>{fmtR(t.r_multiple)}</TableCell>
                          <TableCell className="text-sm">{exitReasonLabel(t.exit_reason)}</TableCell>
                          <TableCell className="text-right">{t.days_held ?? "—"}</TableCell>
                          <TableCell className="w-8 text-right">
                            <button
                              type="button"
                              onClick={() => onDeleteRow(t)}
                              disabled={deleting}
                              className="text-muted-foreground hover:text-rose-300 disabled:opacity-50"
                              aria-label={`Delete ${t.symbol} trade`}
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
          </TabsContent>
        </Tabs>
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
      <SwingTradeExitDialog
        open={exitTrade !== null}
        onOpenChange={(v) => !v && setExitTrade(null)}
        trade={exitTrade}
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

"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Camera, Plus } from "lucide-react";
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

  // If we arrive with ?prefill=SYM from the Ideas board, open the log
  // dialog pre-filled with that symbol + linked idea id.
  useEffect(() => {
    if (prefillSymbol) setDialogOpen(true);
  }, [prefillSymbol]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm text-muted-foreground">
          {trades.length} {trades.length === 1 ? "trade" : "trades"}
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={() => setImportOpen(true)}>
            <Camera className="mr-1 h-4 w-4" /> Import from screenshot
          </Button>
          <Button variant="outline" onClick={() => setDialogOpen(true)}>
            <Plus className="mr-1 h-4 w-4" /> Log Trade
          </Button>
        </div>
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
      ) : (
        <div className="overflow-x-auto rounded border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Symbol</TableHead>
                <TableHead>Entry</TableHead>
                <TableHead className="text-right">Entry $</TableHead>
                <TableHead className="text-right">Exit $</TableHead>
                <TableHead className="text-right">Shares</TableHead>
                <TableHead className="text-right">P&amp;L</TableHead>
                <TableHead className="text-right">Return %</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Exit Reason</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {trades.map((t) => {
                const pnlColor =
                  t.realized_pnl === null
                    ? ""
                    : t.realized_pnl >= 0
                      ? "text-emerald-300"
                      : "text-rose-300";
                return (
                  <TableRow key={t.id}>
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

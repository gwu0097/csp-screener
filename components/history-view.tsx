"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { TradeRow } from "@/lib/supabase";

type Props = { trades: TradeRow[]; error: string | null };

function pnl(t: TradeRow): number | null {
  if (t.premium_bought === null || t.premium_bought === undefined) return null;
  return Math.round((t.premium_sold - t.premium_bought) * 100) / 100;
}

export function HistoryView({ trades, error }: Props) {
  const router = useRouter();
  const [closeTarget, setCloseTarget] = useState<TradeRow | null>(null);

  const stats = useMemo(() => {
    const closed = trades.filter((t) => t.closed_at && t.premium_bought !== null);
    const wins = closed.filter((t) => t.outcome === "win").length;
    const totalPremium = trades.reduce((sum, t) => sum + (t.premium_sold ?? 0), 0);
    return {
      totalTrades: trades.length,
      winRate: closed.length > 0 ? Math.round((wins / closed.length) * 1000) / 10 : null,
      totalPremium: Math.round(totalPremium * 100) / 100,
      avgPremium: trades.length > 0 ? Math.round((totalPremium / trades.length) * 100) / 100 : 0,
    };
  }, [trades]);

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Trade history</h1>

      {error && (
        <div className="rounded-md border border-rose-500/30 bg-rose-500/10 p-2 text-sm text-rose-300">
          {error}
        </div>
      )}

      <div className="grid gap-3 md:grid-cols-4">
        <Stat label="Total trades" value={stats.totalTrades.toString()} />
        <Stat label="Win rate" value={stats.winRate !== null ? `${stats.winRate}%` : "—"} />
        <Stat label="Total premium" value={`$${stats.totalPremium.toFixed(2)}`} />
        <Stat label="Avg premium" value={`$${stats.avgPremium.toFixed(2)}`} />
      </div>

      <div className="overflow-hidden rounded-lg border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Symbol</TableHead>
              <TableHead>Strike</TableHead>
              <TableHead>Expiry</TableHead>
              <TableHead>Sold</TableHead>
              <TableHead>Bought</TableHead>
              <TableHead>P&L</TableHead>
              <TableHead>Outcome</TableHead>
              <TableHead>Notes</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {trades.length === 0 && (
              <TableRow>
                <TableCell colSpan={10} className="py-8 text-center text-sm text-muted-foreground">
                  No trades logged yet.
                </TableCell>
              </TableRow>
            )}
            {trades.map((t) => {
              const p = pnl(t);
              const open = !t.closed_at;
              return (
                <TableRow key={t.id}>
                  <TableCell className="text-xs">{t.trade_date}</TableCell>
                  <TableCell className="font-medium">{t.symbol}</TableCell>
                  <TableCell>${t.strike.toFixed(2)}</TableCell>
                  <TableCell className="text-xs">{t.expiry}</TableCell>
                  <TableCell>${t.premium_sold.toFixed(2)}</TableCell>
                  <TableCell>{t.premium_bought !== null ? `$${t.premium_bought.toFixed(2)}` : "—"}</TableCell>
                  <TableCell className={p === null ? "" : p >= 0 ? "text-emerald-300" : "text-rose-300"}>
                    {p === null ? "—" : `$${p.toFixed(2)}`}
                  </TableCell>
                  <TableCell className="text-xs capitalize">{t.outcome ?? (open ? "open" : "—")}</TableCell>
                  <TableCell className="max-w-xs truncate text-xs text-muted-foreground">{t.notes ?? ""}</TableCell>
                  <TableCell>
                    {open && (
                      <Button size="sm" variant="secondary" onClick={() => setCloseTarget(t)}>
                        Close
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      {closeTarget && (
        <CloseTradeDialog
          trade={closeTarget}
          open={!!closeTarget}
          onOpenChange={(o) => !o && setCloseTarget(null)}
          onSuccess={() => {
            setCloseTarget(null);
            router.refresh();
          }}
        />
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-xs font-medium text-muted-foreground">{label}</CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="text-2xl font-semibold">{value}</div>
      </CardContent>
    </Card>
  );
}

function CloseTradeDialog({
  trade,
  open,
  onOpenChange,
  onSuccess,
}: {
  trade: TradeRow;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}) {
  const [premiumBought, setPremiumBought] = useState(0);
  const [outcome, setOutcome] = useState<"win" | "loss" | "assigned">("win");
  const [notes, setNotes] = useState(trade.notes ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/trade-log", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: trade.id,
          premium_bought: premiumBought,
          outcome,
          closed_at: new Date().toISOString(),
          notes,
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      onSuccess();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Close trade · {trade.symbol}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <label className="block">
            <span className="mb-1 block text-xs text-muted-foreground">Premium bought to close</span>
            <input
              type="number"
              step="0.01"
              value={premiumBought}
              onChange={(e) => setPremiumBought(Number(e.target.value))}
              className="w-full rounded-md border border-border bg-background px-2 py-1"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-muted-foreground">Outcome</span>
            <select
              value={outcome}
              onChange={(e) => setOutcome(e.target.value as "win" | "loss" | "assigned")}
              className="w-full rounded-md border border-border bg-background px-2 py-1"
            >
              <option value="win">Win</option>
              <option value="loss">Loss</option>
              <option value="assigned">Assigned</option>
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-muted-foreground">Notes</span>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              className="w-full rounded-md border border-border bg-background px-2 py-1"
            />
          </label>
          {error && <div className="text-rose-300">{error}</div>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy}>
            {busy ? "Saving…" : "Close trade"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

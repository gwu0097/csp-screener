"use client";

import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import type { SwingTrade } from "@/components/swing-trade-dialog";

export const EXIT_REASONS = [
  { value: "stop_hit", label: "Stop hit" },
  { value: "target_hit", label: "Target hit" },
  { value: "time_stop", label: "Time stop" },
  { value: "trailing_stop", label: "Trailing stop" },
  { value: "discretionary_override", label: "Discretionary override" },
] as const;

export function SwingTradeExitDialog({
  open,
  onOpenChange,
  trade,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  trade: SwingTrade | null;
  onSaved: () => void;
}) {
  const todayIso = new Date().toISOString().slice(0, 10);

  const [exitDate, setExitDate] = useState(todayIso);
  const [exitPrice, setExitPrice] = useState("");
  // Intentionally no default — exit_reason is the highest-value field in
  // the table and must be a deliberate selection, not a pre-checked one.
  const [exitReason, setExitReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setExitDate(todayIso);
    setExitPrice("");
    setExitReason("");
    setError(null);
  }, [open, todayIso]);

  if (!trade) return null;

  const exitPriceNum = Number(exitPrice);
  const disabled =
    submitting ||
    !exitDate ||
    !Number.isFinite(exitPriceNum) ||
    exitPriceNum <= 0 ||
    exitReason === "";

  async function submit() {
    if (!trade) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/swings/trades/${trade.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          exit_date: exitDate,
          exit_price: exitPriceNum,
          exit_reason: exitReason,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      onSaved();
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to close trade");
    } finally {
      setSubmitting(false);
    }
  }

  const riskPerShare = trade.entry_price - trade.planned_stop;
  const previewPnl =
    Number.isFinite(exitPriceNum) && exitPriceNum > 0
      ? (exitPriceNum - trade.entry_price) * trade.shares
      : null;
  const previewR =
    previewPnl !== null && trade.initial_risk_dollars > 0
      ? previewPnl / trade.initial_risk_dollars
      : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Close {trade.symbol}</DialogTitle>
        </DialogHeader>

        <div className="grid gap-3 py-2 text-sm">
          <div className="grid grid-cols-3 gap-2 rounded border border-border/60 bg-background/40 p-2 text-xs">
            <div>
              <div className="text-muted-foreground">Entry</div>
              <div className="font-mono">${trade.entry_price.toFixed(2)}</div>
            </div>
            <div>
              <div className="text-muted-foreground">Stop</div>
              <div className="font-mono">${trade.planned_stop.toFixed(2)}</div>
            </div>
            <div>
              <div className="text-muted-foreground">Risk/share</div>
              <div className="font-mono">${riskPerShare.toFixed(2)}</div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <label className="grid gap-1">
              <span className="text-muted-foreground">Exit date</span>
              <input
                type="date"
                value={exitDate}
                onChange={(e) => setExitDate(e.target.value)}
                className="rounded border border-border bg-background px-2 py-1.5 text-base"
              />
            </label>
            <label className="grid gap-1">
              <span className="text-muted-foreground">Exit price</span>
              <input
                type="number"
                step="0.01"
                value={exitPrice}
                onChange={(e) => setExitPrice(e.target.value)}
                className="rounded border border-border bg-background px-2 py-1.5 text-base"
                autoFocus
              />
            </label>
          </div>

          <label className="grid gap-1">
            <span className="text-muted-foreground">Exit reason *</span>
            <select
              value={exitReason}
              onChange={(e) => setExitReason(e.target.value)}
              className="rounded border border-border bg-background px-2 py-1.5 text-base"
            >
              <option value="" disabled>
                Select a reason…
              </option>
              {EXIT_REASONS.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
          </label>

          {previewPnl !== null && (
            <div className="text-xs text-muted-foreground">
              Preview: {previewPnl >= 0 ? "+" : ""}
              ${previewPnl.toFixed(2)}
              {previewR !== null ? ` · ${previewR >= 0 ? "+" : ""}${previewR.toFixed(2)}R` : ""}
            </div>
          )}

          {error && (
            <div className="rounded border border-rose-500/40 bg-rose-500/10 p-2 text-sm text-rose-300">
              {error}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={disabled}>
            {submitting ? "Closing…" : "Close trade"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

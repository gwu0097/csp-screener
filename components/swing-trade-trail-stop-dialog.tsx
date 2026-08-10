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

// Updates current_stop only — never initial_stop, which is immutable
// and is the only stop any R-multiple is ever computed against. Trailing
// the stop here changes where a future exit would be triggered and what
// "distance to stop" shows; it cannot change any already-recorded R.
export function SwingTradeTrailStopDialog({
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
  const [newStop, setNewStop] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !trade) return;
    setNewStop(String(trade.current_stop));
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, trade?.id]);

  if (!trade) return null;

  const newStopNum = Number(newStop);
  const disabled = submitting || !Number.isFinite(newStopNum) || newStopNum <= 0;

  async function submit() {
    if (!trade) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/swings/trades/${trade.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ current_stop: newStopNum }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      onSaved();
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update stop");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Trail stop — {trade.symbol}</DialogTitle>
        </DialogHeader>

        <div className="grid gap-3 py-2 text-sm">
          <div className="grid grid-cols-2 gap-2 rounded border border-border/60 bg-background/40 p-2 text-xs">
            <div>
              <div className="text-muted-foreground">Initial stop (fixed)</div>
              <div className="font-mono">${trade.initial_stop.toFixed(2)}</div>
            </div>
            <div>
              <div className="text-muted-foreground">Current stop</div>
              <div className="font-mono">${trade.current_stop.toFixed(2)}</div>
            </div>
          </div>

          <label className="grid gap-1">
            <span className="text-muted-foreground">New stop</span>
            <input
              type="number"
              step="0.01"
              value={newStop}
              onChange={(e) => setNewStop(e.target.value)}
              className="rounded border border-border bg-background px-2 py-1.5 text-base"
              autoFocus
            />
          </label>

          <p className="text-xs text-muted-foreground">
            This never changes the initial stop or any already-recorded R-multiple — only where a
            future exit would trigger.
          </p>

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
            {submitting ? "Saving…" : "Update stop"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

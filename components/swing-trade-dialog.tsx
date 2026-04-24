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

export type SwingTrade = {
  id: string;
  swing_idea_id: string | null;
  symbol: string;
  broker: string | null;
  shares: number | null;
  entry_price: number | null;
  entry_date: string | null;
  exit_price: number | null;
  exit_date: string | null;
  realized_pnl: number | null;
  return_pct: number | null;
  thesis: string | null;
  exit_reason: string | null;
  status: string;
  created_at: string;
  updated_at: string;
};

type ExitReason = "target_hit" | "stop_loss" | "thesis_broken" | "manual";

export function SwingTradeDialog({
  open,
  onOpenChange,
  prefill,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  prefill?: { symbol?: string; swing_idea_id?: string };
  onSaved: () => void;
}) {
  const todayIso = new Date().toISOString().slice(0, 10);

  const [symbol, setSymbol] = useState("");
  const [broker, setBroker] = useState<"schwab" | "robinhood" | "other">("schwab");
  const [shares, setShares] = useState("");
  const [entryPrice, setEntryPrice] = useState("");
  const [entryDate, setEntryDate] = useState(todayIso);
  const [exitPrice, setExitPrice] = useState("");
  const [exitDate, setExitDate] = useState("");
  const [thesis, setThesis] = useState("");
  const [exitReason, setExitReason] = useState<ExitReason>("manual");

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setSymbol(prefill?.symbol ?? "");
    setBroker("schwab");
    setShares("");
    setEntryPrice("");
    setEntryDate(todayIso);
    setExitPrice("");
    setExitDate("");
    setThesis("");
    setExitReason("manual");
    setError(null);
  }, [open, prefill?.symbol, todayIso]);

  const isClosing = exitPrice.trim() !== "" && Number(exitPrice) > 0;

  const disabled =
    submitting ||
    symbol.trim().length === 0 ||
    !shares ||
    Number(shares) <= 0 ||
    !entryPrice ||
    Number(entryPrice) <= 0 ||
    !entryDate;

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      const body = {
        swing_idea_id: prefill?.swing_idea_id ?? null,
        symbol: symbol.trim().toUpperCase(),
        broker,
        shares: Number(shares),
        entry_price: Number(entryPrice),
        entry_date: entryDate,
        exit_price: isClosing ? Number(exitPrice) : null,
        exit_date: isClosing && exitDate ? exitDate : null,
        thesis: thesis.trim() || null,
        exit_reason: isClosing ? exitReason : null,
      };
      const res = await fetch("/api/swings/trades", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      onSaved();
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Log swing trade</DialogTitle>
        </DialogHeader>

        <div className="grid gap-3 py-2">
          <div className="grid grid-cols-2 gap-3">
            <label className="grid gap-1 text-xs">
              <span className="text-muted-foreground">Symbol *</span>
              <input
                type="text"
                value={symbol}
                onChange={(e) => setSymbol(e.target.value.toUpperCase())}
                className="rounded border border-border bg-background px-2 py-1.5 font-mono text-sm uppercase"
                placeholder="AMD"
                autoFocus
              />
            </label>
            <label className="grid gap-1 text-xs">
              <span className="text-muted-foreground">Broker</span>
              <select
                value={broker}
                onChange={(e) =>
                  setBroker(e.target.value as "schwab" | "robinhood" | "other")
                }
                className="rounded border border-border bg-background px-2 py-1.5 text-sm"
              >
                <option value="schwab">Schwab</option>
                <option value="robinhood">Robinhood</option>
                <option value="other">Other</option>
              </select>
            </label>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <label className="grid gap-1 text-xs">
              <span className="text-muted-foreground">Shares *</span>
              <input
                type="number"
                step="0.01"
                value={shares}
                onChange={(e) => setShares(e.target.value)}
                className="rounded border border-border bg-background px-2 py-1.5 text-sm"
              />
            </label>
            <label className="grid gap-1 text-xs">
              <span className="text-muted-foreground">Entry price *</span>
              <input
                type="number"
                step="0.01"
                value={entryPrice}
                onChange={(e) => setEntryPrice(e.target.value)}
                className="rounded border border-border bg-background px-2 py-1.5 text-sm"
              />
            </label>
            <label className="grid gap-1 text-xs">
              <span className="text-muted-foreground">Entry date *</span>
              <input
                type="date"
                value={entryDate}
                onChange={(e) => setEntryDate(e.target.value)}
                className="rounded border border-border bg-background px-2 py-1.5 text-sm"
              />
            </label>
          </div>

          <div className="rounded-md border border-border/60 bg-background/40 p-3">
            <div className="mb-2 text-xs font-medium text-muted-foreground">
              Exit (leave blank if still open)
            </div>
            <div className="grid grid-cols-2 gap-3">
              <label className="grid gap-1 text-xs">
                <span className="text-muted-foreground">Exit price</span>
                <input
                  type="number"
                  step="0.01"
                  value={exitPrice}
                  onChange={(e) => setExitPrice(e.target.value)}
                  className="rounded border border-border bg-background px-2 py-1.5 text-sm"
                />
              </label>
              <label className="grid gap-1 text-xs">
                <span className="text-muted-foreground">Exit date</span>
                <input
                  type="date"
                  value={exitDate}
                  onChange={(e) => setExitDate(e.target.value)}
                  disabled={!isClosing}
                  className="rounded border border-border bg-background px-2 py-1.5 text-sm disabled:opacity-50"
                />
              </label>
            </div>
            {isClosing && (
              <label className="mt-2 grid gap-1 text-xs">
                <span className="text-muted-foreground">Exit reason</span>
                <select
                  value={exitReason}
                  onChange={(e) => setExitReason(e.target.value as ExitReason)}
                  className="rounded border border-border bg-background px-2 py-1.5 text-sm"
                >
                  <option value="target_hit">Target Hit</option>
                  <option value="stop_loss">Stop Loss</option>
                  <option value="thesis_broken">Thesis Broken</option>
                  <option value="manual">Manual</option>
                </select>
              </label>
            )}
          </div>

          <label className="grid gap-1 text-xs">
            <span className="text-muted-foreground">Thesis</span>
            <textarea
              value={thesis}
              onChange={(e) => setThesis(e.target.value)}
              rows={2}
              className="rounded border border-border bg-background px-2 py-1.5 text-sm"
            />
          </label>

          {error && (
            <div className="rounded border border-rose-500/40 bg-rose-500/10 p-2 text-xs text-rose-300">
              {error}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button onClick={submit} disabled={disabled}>
            {submitting ? "Saving…" : "Log trade"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

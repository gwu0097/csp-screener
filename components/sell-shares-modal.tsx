"use client";

// Sell-shares prompt fired from the "Sell Shares" button on a stock
// row in the positions view. Posts to /api/trades/bulk-create with
// stockTrades[] — see app/api/trades/bulk-create/route.ts for the
// matching server-side branch. Supports full and partial closes;
// previews stock P&L live as the user types.

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

export type SellSharesTarget = {
  positionId: string;
  symbol: string;
  broker: string;
  totalShares: number;
  costBasis: number | null;
};

type Props = {
  open: boolean;
  target: SellSharesTarget | null;
  onCancel: () => void;
  // Resolves after /api/trades/bulk-create returns and the parent has
  // refreshed the positions list. Receives the parsed response so the
  // parent can surface counts in a toast.
  onConfirm: (response: { ok: boolean; message: string }) => Promise<void>;
};

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function SellSharesModal({ open, target, onCancel, onConfirm }: Props) {
  const [shares, setShares] = useState<string>("");
  const [price, setPrice] = useState<string>("");
  const [date, setDate] = useState<string>(todayIso());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset form whenever a new target is selected.
  useEffect(() => {
    if (target) {
      setShares(String(target.totalShares));
      setPrice("");
      setDate(todayIso());
      setError(null);
    }
  }, [target?.positionId]);

  if (!target) return null;

  const sharesNum = Number(shares);
  const priceNum = Number(price);
  const sharesValid =
    Number.isFinite(sharesNum) && sharesNum > 0 && sharesNum <= target.totalShares;
  const priceValid = Number.isFinite(priceNum) && priceNum >= 0;
  const dateValid = /^\d{4}-\d{2}-\d{2}$/.test(date);
  const canSubmit = sharesValid && priceValid && dateValid && !submitting;

  const previewPnl =
    sharesValid && priceValid && target.costBasis !== null
      ? Math.round((priceNum - target.costBasis) * sharesNum * 100) / 100
      : null;
  const previewColor =
    previewPnl === null
      ? "text-muted-foreground"
      : previewPnl >= 0
        ? "text-emerald-300"
        : "text-rose-300";
  const remainingAfter = sharesValid ? target.totalShares - sharesNum : null;

  async function handleSubmit() {
    if (!canSubmit || !target) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/trades/bulk-create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          stockTrades: [
            {
              symbol: target.symbol,
              action: "sell",
              shares: sharesNum,
              price: priceNum,
              date,
              broker: target.broker,
            },
          ],
        }),
      });
      const json = (await res.json()) as {
        stocks_closed?: number;
        stocks_partial?: number;
        errors?: string[];
        error?: string;
      };
      if (!res.ok) {
        throw new Error(json.error ?? `HTTP ${res.status}`);
      }
      if (json.errors && json.errors.length > 0) {
        throw new Error(json.errors.join("; "));
      }
      const message =
        (json.stocks_closed ?? 0) > 0
          ? `Closed ${target.symbol} stock position.`
          : `Sold ${sharesNum} ${target.symbol} shares (${remainingAfter} remaining).`;
      await onConfirm({ ok: true, message });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sell failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o && !submitting) onCancel();
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Sell {target.symbol} Shares</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 text-base">
          <div className="flex items-baseline justify-between text-sm text-muted-foreground">
            <span>
              {target.totalShares} shares held @ cost basis{" "}
              <span className="font-mono text-foreground">
                {target.costBasis !== null
                  ? `$${target.costBasis.toFixed(2)}`
                  : "—"}
              </span>
            </span>
            <span className="uppercase tracking-wide">{target.broker}</span>
          </div>

          <label className="block">
            <span className="text-sm text-muted-foreground">Shares to sell</span>
            <input
              type="number"
              min={1}
              max={target.totalShares}
              step={1}
              value={shares}
              onChange={(e) => setShares(e.target.value)}
              className="mt-1 w-full rounded border border-border bg-background px-2 py-1.5 font-mono text-base"
            />
          </label>

          <label className="block">
            <span className="text-sm text-muted-foreground">Sale price (per share)</span>
            <div className="mt-1 flex items-center rounded border border-border bg-background px-2 py-1.5">
              <span className="mr-1 font-mono text-muted-foreground">$</span>
              <input
                type="number"
                min={0}
                step={0.01}
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                placeholder="0.00"
                className="w-full bg-transparent font-mono text-base outline-none"
              />
            </div>
          </label>

          <label className="block">
            <span className="text-sm text-muted-foreground">Date</span>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="mt-1 w-full rounded border border-border bg-background px-2 py-1.5 text-base"
            />
          </label>

          <div className="rounded border border-border bg-background/40 p-2 text-sm">
            <div className="mb-1 font-semibold uppercase tracking-wide text-muted-foreground">
              Preview P&L
            </div>
            {previewPnl !== null && target.costBasis !== null && sharesValid && priceValid ? (
              <>
                <div className="flex items-baseline justify-between">
                  <span className="text-muted-foreground">Stock P&L:</span>
                  <span className={`font-mono font-semibold ${previewColor}`}>
                    {previewPnl >= 0 ? "+" : ""}${previewPnl.toFixed(2)}
                  </span>
                </div>
                <div className="font-mono text-[11px] text-muted-foreground/80">
                  (${priceNum.toFixed(2)} − ${target.costBasis.toFixed(2)}) × {sharesNum}
                </div>
                {remainingAfter !== null && remainingAfter > 0 && (
                  <div className="mt-1 text-[11px] text-muted-foreground">
                    Remaining after sale: {remainingAfter} shares
                  </div>
                )}
                {remainingAfter === 0 && (
                  <div className="mt-1 text-[11px] text-amber-300">
                    Full close — position will be marked closed.
                  </div>
                )}
              </>
            ) : (
              <div className="text-muted-foreground">
                Enter shares + price to see P&L
              </div>
            )}
          </div>

          {error && (
            <div className="rounded border border-rose-500/40 bg-rose-500/10 px-2 py-1.5 text-sm text-rose-200">
              {error}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={!canSubmit}>
            {submitting && <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />}
            Confirm Sale
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

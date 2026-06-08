"use client";

// Quick close-to-buy modal for an open option position. Fired from the
// "Close" button in the Grade column on an open option row. Same UX
// shape as SellSharesModal (qty / price / date + live P&L preview)
// but posts a buy-to-close fill to /api/positions/{id}/fills.

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

export type CloseOptionTarget = {
  positionId: string;
  symbol: string;
  strike: number;
  expiry: string;
  optionType: "put" | "call";
  // Flips the P&L preview sign: short profits when buy-back is cheap;
  // long profits when sell price exceeds entry. Defaults handled by the
  // caller (position-card threads OpenPositionClientView.direction).
  direction: "short" | "long";
  remainingContracts: number;
  avgPremiumSold: number | null;
  broker: string;
};

type Props = {
  open: boolean;
  target: CloseOptionTarget | null;
  onCancel: () => void;
  // Called after the fill insert succeeds and the parent has had a
  // chance to refresh. Parent threads through the same toast handler
  // used by import paths so the user sees a consistent "logged" toast.
  onConfirm: (response: { ok: boolean; message: string }) => Promise<void>;
};

// PT calendar today — matches the server's todayPst() so the max attr
// on the date picker and the bulk-create / fills route checks agree
// regardless of browser timezone.
function todayPstIso(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export function CloseOptionModal({ open, target, onCancel, onConfirm }: Props) {
  const today = todayPstIso();
  const [qty, setQty] = useState<string>("");
  const [price, setPrice] = useState<string>("");
  const [date, setDate] = useState<string>(today);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (target) {
      setQty(String(target.remainingContracts));
      setPrice("");
      setDate(today);
      setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.positionId]);

  if (!target) return null;

  const qtyNum = Number(qty);
  const priceNum = Number(price);
  const qtyValid =
    Number.isFinite(qtyNum) &&
    qtyNum > 0 &&
    qtyNum <= target.remainingContracts;
  // Buy-to-close premium is the price you PAY — allow $0 (deep OTM
  // expired-without-buyback edge case).
  const priceValid = Number.isFinite(priceNum) && priceNum >= 0;
  const dateValid = /^\d{4}-\d{2}-\d{2}$/.test(date) && date <= today;
  const canSubmit = qtyValid && priceValid && dateValid && !submitting;

  // Per-contract P&L = (avg sold − close paid) × 100. Multiplied out
  // by the qty closing here. Avg sold is null on legacy rows that
  // never had open fills attached — we skip the preview rather than
  // show a misleading number.
  // Direction-aware P&L preview. Short = sold-to-open, profit when we
  // buy back cheaper than what we sold for. Long = bought-to-open,
  // profit when we sell for more than we paid.
  const previewPnl =
    qtyValid && priceValid && target.avgPremiumSold !== null
      ? Math.round(
          (target.direction === "long"
            ? priceNum - target.avgPremiumSold
            : target.avgPremiumSold - priceNum) *
            qtyNum *
            100 *
            100,
        ) / 100
      : null;
  const previewColor =
    previewPnl === null
      ? "text-muted-foreground"
      : previewPnl >= 0
        ? "text-emerald-300"
        : "text-rose-300";
  const remainingAfter = qtyValid
    ? target.remainingContracts - qtyNum
    : null;

  async function handleSubmit() {
    if (!canSubmit || !target) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/positions/${target.positionId}/fills`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          side: "close",
          contracts: qtyNum,
          premium: priceNum,
          fill_date: date,
        }),
      });
      const json = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || json.error) {
        throw new Error(json.error ?? `HTTP ${res.status}`);
      }
      const isFullClose = remainingAfter === 0;
      const message = isFullClose
        ? `Closed ${target.symbol} $${target.strike}${target.optionType === "put" ? "P" : "C"}.`
        : `Bought to close ${qtyNum} ${target.symbol} (${remainingAfter} remaining).`;
      await onConfirm({ ok: true, message });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Close failed");
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
          <DialogTitle>
            Close {target.symbol} ${target.strike}
            {target.optionType === "put" ? "P" : "C"} {target.expiry}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3 text-base">
          <div className="flex items-baseline justify-between text-sm text-muted-foreground">
            <span>
              {target.remainingContracts} contract
              {target.remainingContracts === 1 ? "" : "s"} remaining · avg
              sold{" "}
              <span className="font-mono text-foreground">
                {target.avgPremiumSold !== null
                  ? `$${target.avgPremiumSold.toFixed(2)}`
                  : "—"}
              </span>
            </span>
            <span className="uppercase tracking-wide">{target.broker}</span>
          </div>

          <label className="block">
            <span className="text-sm text-muted-foreground">Contracts to close</span>
            <input
              type="number"
              min={1}
              max={target.remainingContracts}
              step={1}
              value={qty}
              onChange={(e) => setQty(e.target.value)}
              className="mt-1 w-full rounded border border-border bg-background px-2 py-1.5 font-mono text-base"
            />
          </label>

          <label className="block">
            <span className="text-sm text-muted-foreground">
              Close price (per contract)
            </span>
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
              max={today}
              onChange={(e) => setDate(e.target.value)}
              className="mt-1 w-full rounded border border-border bg-background px-2 py-1.5 text-base"
            />
            {date > today && (
              <div className="mt-1 text-[11px] text-rose-300">
                Fill date cannot be in the future
              </div>
            )}
          </label>

          <div className="rounded border border-border bg-background/40 p-2 text-sm">
            <div className="mb-1 font-semibold uppercase tracking-wide text-muted-foreground">
              Preview P&L
            </div>
            {previewPnl !== null &&
            target.avgPremiumSold !== null &&
            qtyValid &&
            priceValid ? (
              <>
                <div className="flex items-baseline justify-between">
                  <span className="text-muted-foreground">Realized:</span>
                  <span className={`font-mono font-semibold ${previewColor}`}>
                    {previewPnl >= 0 ? "+" : ""}${previewPnl.toFixed(2)}
                  </span>
                </div>
                <div className="font-mono text-[11px] text-muted-foreground/80">
                  {target.direction === "long"
                    ? `($${priceNum.toFixed(2)} − $${target.avgPremiumSold.toFixed(2)})`
                    : `($${target.avgPremiumSold.toFixed(2)} − $${priceNum.toFixed(2)})`}{" "}
                  × {qtyNum} × 100
                </div>
                {remainingAfter !== null && remainingAfter > 0 && (
                  <div className="mt-1 text-[11px] text-muted-foreground">
                    Remaining after close: {remainingAfter} contract
                    {remainingAfter === 1 ? "" : "s"}
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
                Enter qty + price to see P&L
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
            Confirm Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

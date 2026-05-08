"use client";

// Follow-up prompt that fires after the expire-confirmation modal
// finishes when /api/positions/confirm-expire returns one or more
// assigned positions. For each assignment, offer to auto-create a
// stock_long row at cost basis (= strike − avg entry premium per
// share). User can uncheck any row before confirming; checked rows
// POST to /api/positions/create-from-assignment.

import { useEffect, useState } from "react";
import { CheckSquare, Loader2, Square } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

export type AssignmentRow = {
  positionId: string;
  symbol: string;
  broker: string | null;
  strike: number;
  contracts: number;
  avgPremiumSold: number | null;
  costBasis: number;
  shares: number;
  expiry: string;
};

type Props = {
  open: boolean;
  rows: AssignmentRow[];
  onCancel: () => void;
  // Resolves only after the create-from-assignment round-trip and
  // the parent has refreshed the positions list.
  onConfirm: (positionIds: string[]) => Promise<void>;
};

export function AssignmentStockPromptModal({
  open,
  rows,
  onCancel,
  onConfirm,
}: Props) {
  const [submitting, setSubmitting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(rows.map((r) => r.positionId)),
  );
  useEffect(() => {
    setSelected(new Set(rows.map((r) => r.positionId)));
  }, [rows]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleConfirm() {
    const ids = rows
      .filter((r) => selected.has(r.positionId))
      .map((r) => r.positionId);
    if (ids.length === 0) {
      onCancel();
      return;
    }
    setSubmitting(true);
    try {
      await onConfirm(ids);
    } finally {
      setSubmitting(false);
    }
  }

  const checkedCount = selected.size;

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v && !submitting) onCancel();
      }}
    >
      <DialogContent className="flex max-h-[85vh] max-w-xl flex-col">
        <DialogHeader className="shrink-0">
          <DialogTitle>Stock positions from assignment</DialogTitle>
        </DialogHeader>

        <p className="shrink-0 text-sm text-muted-foreground">
          The following {rows.length === 1 ? "position was" : "positions were"}{" "}
          assigned. Create stock {rows.length === 1 ? "position" : "positions"}{" "}
          at cost basis? Uncheck any you don&apos;t want to track.
        </p>

        <div className="-mx-6 min-h-0 flex-1 space-y-2 overflow-y-auto px-6">
          {rows.map((r) => {
            const checked = selected.has(r.positionId);
            const premiumStr =
              r.avgPremiumSold !== null
                ? `$${r.avgPremiumSold.toFixed(2)}`
                : "—";
            return (
              <button
                key={r.positionId}
                type="button"
                onClick={() => toggle(r.positionId)}
                disabled={submitting}
                className="flex w-full items-start gap-2 rounded border border-border bg-background/40 px-3 py-2 text-left text-sm hover:bg-background/60 disabled:opacity-50"
              >
                {checked ? (
                  <CheckSquare className="mt-0.5 h-4 w-4 shrink-0 text-emerald-300" />
                ) : (
                  <Square className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                )}
                <div className="flex-1 space-y-0.5">
                  <div className="font-mono">
                    <span className="font-semibold text-foreground">
                      {r.symbol}
                    </span>{" "}
                    <span className="text-muted-foreground">
                      ${r.strike}P ×{r.contracts} assigned
                    </span>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Cost basis = ${r.strike.toFixed(2)} − {premiumStr} premium ={" "}
                    <span className="font-mono text-foreground">
                      ${r.costBasis.toFixed(2)}
                    </span>{" "}
                    per share
                  </div>
                  <div className="text-xs">
                    <span className="font-mono font-semibold text-foreground">
                      {r.shares} shares
                    </span>{" "}
                    of <span className="text-foreground">{r.symbol}</span> at{" "}
                    <span className="font-mono">${r.costBasis.toFixed(2)}</span>
                    {r.broker ? (
                      <span className="ml-2 text-[10px] uppercase tracking-wider text-muted-foreground">
                        {r.broker}
                      </span>
                    ) : null}
                  </div>
                </div>
              </button>
            );
          })}
        </div>

        <DialogFooter className="shrink-0">
          <Button variant="secondary" onClick={onCancel} disabled={submitting}>
            No thanks
          </Button>
          <Button onClick={handleConfirm} disabled={submitting || checkedCount === 0}>
            {submitting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Creating…
              </>
            ) : (
              `Yes — Add ${checkedCount} stock position${checkedCount === 1 ? "" : "s"}`
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

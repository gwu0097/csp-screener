"use client";

// Early-assignment confirmation for an open short put. Fired from the
// "Assigned" button on an open put row. Shows exactly what will happen
// (close N puts at $0.00, open N×100 shares at strike) with an
// editable assignment date, then POSTs /api/positions/{id}/mark-assigned.

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

export type MarkAssignedTarget = {
  positionId: string;
  symbol: string;
  strike: number;
  expiry: string;
  remainingContracts: number;
};

type Props = {
  open: boolean;
  target: MarkAssignedTarget | null;
  onCancel: () => void;
  onConfirm: (response: { ok: boolean; message: string }) => Promise<void>;
};

// PT calendar today — consistent with the close-option modal's date
// handling so server/browser timezones can't disagree on "today".
function todayPstIso(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export function MarkAssignedModal({ open, target, onCancel, onConfirm }: Props) {
  const [date, setDate] = useState(todayPstIso());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset per target so a previous run's date/error doesn't leak in.
  useEffect(() => {
    if (target) {
      setDate(todayPstIso());
      setError(null);
      setBusy(false);
    }
  }, [target]);

  if (!target) return null;
  const shares = target.remainingContracts * 100;

  async function confirm() {
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/positions/${encodeURIComponent(target.positionId)}/mark-assigned`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ assignmentDate: date }),
          cache: "no-store",
        },
      );
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        message?: string;
        error?: string;
      };
      if (!res.ok || !json.ok) {
        setError(json.error ?? `HTTP ${res.status}`);
        return;
      }
      await onConfirm({ ok: true, message: json.message ?? "Marked as assigned" });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onCancel();
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            Mark {target.symbol} ${target.strike.toFixed(2)}P ×{" "}
            {target.remainingContracts} as assigned
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3 text-sm">
          <p className="text-muted-foreground">
            This will close{" "}
            <span className="font-mono text-foreground">
              {target.remainingContracts} put
              {target.remainingContracts === 1 ? "" : "s"}
            </span>{" "}
            at <span className="font-mono text-foreground">$0.00</span>{" "}
            (assignment) and open{" "}
            <span className="font-mono text-foreground">{shares} shares</span>{" "}
            of {target.symbol} at{" "}
            <span className="font-mono text-foreground">
              ${target.strike.toFixed(2)}
            </span>
            .
          </p>
          <p className="text-xs text-muted-foreground">
            Premium already collected stays as the put&apos;s realized P&amp;L.
            The stock&apos;s cost basis is the strike — the market move lives
            on the share position, nothing is double-counted.
          </p>
          <label className="block space-y-1">
            <span className="text-xs text-muted-foreground">Assignment date</span>
            <input
              type="date"
              value={date}
              max={todayPstIso()}
              onChange={(e) => setDate(e.target.value)}
              className="w-44 rounded border border-border bg-background px-2 py-1.5 text-sm"
            />
          </label>
          {error && (
            <div className="rounded border border-rose-500/40 bg-rose-500/10 p-2 text-xs text-rose-200">
              {error}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => void confirm()} disabled={busy}>
            {busy ? (
              <>
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                Marking…
              </>
            ) : (
              `Confirm assignment`
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

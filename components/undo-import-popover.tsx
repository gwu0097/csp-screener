"use client";

// Popover for the Positions page "Undo import" button. Lists up to
// the last 5 bulk-create batches and lets the user roll back any
// undoable one. Backed by /api/positions/import-batches (GET) and
// /api/positions/import-batches/[batch_id] (DELETE).
//
// Eligibility is computed server-side and the row's Undo button is
// disabled with a tooltip when the batch can't be safely undone
// (positions closed, realized P&L, or close fills in the batch).

import { useEffect, useState } from "react";
import { AlertTriangle, Loader2, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";

type ImportBatchPosition = {
  id: string;
  symbol: string;
  strike: number;
  expiry: string;
  qty: number;
  status: string;
  realizedPnl: number | null;
};

type ImportBatch = {
  batchId: string;
  importedAt: string;
  broker: string;
  positionCount: number;
  positions: ImportBatchPosition[];
  undoable: boolean;
  undoBlockedReason: string | null;
};

function fmtBatchTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const yest = new Date(now);
  yest.setDate(now.getDate() - 1);
  const isYesterday =
    d.getFullYear() === yest.getFullYear() &&
    d.getMonth() === yest.getMonth() &&
    d.getDate() === yest.getDate();
  const time = d.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  if (sameDay) return `Today ${time}`;
  if (isYesterday) return `Yesterday ${time}`;
  return `${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })} ${time}`;
}

function summarizePositions(positions: ImportBatchPosition[]): string {
  const labels = positions.map((p) => `${p.symbol} $${p.strike}P`);
  const joined = labels.join(", ");
  if (joined.length <= 64) return joined;
  // Trim to first ~3 then "+N more"
  const first = labels.slice(0, 3).join(", ");
  return `${first} +${labels.length - 3} more`;
}

type Props = {
  open: boolean;
  onClose: () => void;
  onUndone: () => void;
};

export function UndoImportPopover({ open, onClose, onUndone }: Props) {
  const [batches, setBatches] = useState<ImportBatch[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [undoingId, setUndoingId] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setBatches(null);
      setError(null);
      setConfirmId(null);
      setUndoingId(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const res = await fetch("/api/positions/import-batches", {
          cache: "no-store",
        });
        const json = (await res.json()) as {
          batches?: ImportBatch[];
          error?: string;
        };
        if (cancelled) return;
        if (!res.ok || json.error) {
          throw new Error(json.error ?? `HTTP ${res.status}`);
        }
        setBatches(json.batches ?? []);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Failed to load batches");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  async function doUndo(batchId: string) {
    setUndoingId(batchId);
    setError(null);
    try {
      const res = await fetch(
        `/api/positions/import-batches/${encodeURIComponent(batchId)}`,
        { method: "DELETE" },
      );
      const json = (await res.json()) as {
        positions_deleted?: number;
        error?: string;
      };
      if (!res.ok || json.error) {
        throw new Error(json.error ?? `HTTP ${res.status}`);
      }
      // Tell the parent to refetch and close.
      onUndone();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Undo failed");
    } finally {
      setUndoingId(null);
      setConfirmId(null);
    }
  }

  if (!open) return null;

  return (
    <>
      {/* Backdrop — click to close (modal-light, no Radix dep). */}
      <div
        className="fixed inset-0 z-40"
        onClick={onClose}
        aria-hidden="true"
      />
      <div className="absolute right-0 top-full z-50 mt-1 w-[24rem] rounded-lg border border-border bg-background/95 p-3 shadow-lg backdrop-blur">
        <div className="mb-2 flex items-center justify-between">
          <div className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            <Undo2 className="mr-1 inline h-3 w-3" />
            Undo Import
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-sm text-muted-foreground hover:text-foreground"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        {loading && (
          <div className="flex items-center gap-2 px-2 py-3 text-sm text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            Loading recent imports…
          </div>
        )}

        {!loading && error && (
          <div className="rounded border border-rose-500/40 bg-rose-500/10 px-2 py-1.5 text-sm text-rose-200">
            <AlertTriangle className="mr-1 inline h-3 w-3" />
            {error}
          </div>
        )}

        {!loading && !error && batches && batches.length === 0 && (
          <div className="rounded border border-border bg-background/60 px-2 py-3 text-sm text-muted-foreground">
            No recent imports to undo. (Pre-migration imports aren&apos;t
            tracked.)
          </div>
        )}

        {!loading && !error && batches && batches.length > 0 && (
          <div className="space-y-1.5">
            {batches.map((b) => {
              const summary = summarizePositions(b.positions);
              const isConfirming = confirmId === b.batchId;
              const isUndoing = undoingId === b.batchId;
              return (
                <div
                  key={b.batchId}
                  className="rounded border border-border bg-background/60 px-2 py-1.5 text-sm"
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 text-muted-foreground">
                        <span className="font-mono text-foreground">
                          {fmtBatchTime(b.importedAt)}
                        </span>
                        <span className="rounded bg-background px-1 py-0.5 text-[10px] uppercase tracking-wider">
                          {b.broker}
                        </span>
                        <span className="text-[10px]">
                          ({b.positionCount} pos)
                        </span>
                      </div>
                      <div
                        className="mt-0.5 truncate text-foreground/90"
                        title={b.positions
                          .map((p) => `${p.symbol} $${p.strike}P`)
                          .join(", ")}
                      >
                        {summary}
                      </div>
                    </div>
                    {b.undoable ? (
                      isConfirming ? (
                        <div className="flex shrink-0 gap-1">
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={isUndoing}
                            onClick={() => setConfirmId(null)}
                          >
                            Cancel
                          </Button>
                          <Button
                            size="sm"
                            disabled={isUndoing}
                            onClick={() => doUndo(b.batchId)}
                          >
                            {isUndoing ? (
                              <>
                                <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                                …
                              </>
                            ) : (
                              "Confirm"
                            )}
                          </Button>
                        </div>
                      ) : (
                        <Button
                          size="sm"
                          variant="secondary"
                          className="shrink-0"
                          onClick={() => setConfirmId(b.batchId)}
                        >
                          Undo
                        </Button>
                      )
                    ) : (
                      <span
                        title={b.undoBlockedReason ?? ""}
                        className="shrink-0 text-[10px] text-muted-foreground/70"
                      >
                        locked
                      </span>
                    )}
                  </div>
                  {isConfirming && (
                    <div className="mt-1 text-[11px] text-amber-200">
                      Undo {b.positionCount} position
                      {b.positionCount === 1 ? "" : "s"} from{" "}
                      {fmtBatchTime(b.importedAt)}? This cannot be undone.
                    </div>
                  )}
                  {!b.undoable && b.undoBlockedReason && (
                    <div className="mt-0.5 text-[10px] text-muted-foreground/70">
                      {b.undoBlockedReason}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}

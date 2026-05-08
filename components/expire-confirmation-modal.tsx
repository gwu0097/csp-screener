"use client";

// Expired-position confirmation modal. Shown when the Positions GET
// response includes a non-empty pending_confirmation list, gated by
// a sessionStorage flag in positions-view so the modal only fires
// once per browser session even if the user dismisses without
// acting. Each row is individually selectable — uncheck a row to
// leave it open (e.g. one within the assignment window the user
// wants to verify against the broker before closing).

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { fmtDollarsSigned } from "@/lib/format";

export type PendingConfirmationRow = {
  positionId: string;
  symbol: string;
  strike: number;
  expiry: string;
  // REMAINING contract count — already net of any close fills.
  totalContracts: number;
  avgPremiumSold?: number | null;
  pctFromStrike: number | null;
  stockPrice: number | null;
  optionPrice: number | null;
  broker: string | null;
};

export type ConfirmItem = {
  positionId: string;
  action: "worthless" | "assigned";
  stockPrice: number | null;
  // Only meaningful when action='assigned'. When true, the parent
  // chains a follow-up call to /api/positions/create-from-assignment
  // for this id. Default for assigned rows = true.
  createStock?: boolean;
};

const BROKER_LABEL: Record<string, string> = {
  schwab: "SCHWAB",
  schwab2: "SCHWAB 2",
  robinhood: "ROBINHOOD",
};

const BROKER_ORDER = ["schwab", "schwab2", "robinhood"] as const;

function shortExpiry(iso: string): string {
  const d = new Date(iso + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function fmtPctOtm(p: number | null): string {
  if (p === null || !Number.isFinite(p)) return "—";
  const pct = p * 100;
  return `${pct > 0 ? "+" : ""}${pct.toFixed(1)}% OTM`;
}

// Deterministic ITM/OTM rule for puts:
//   stockPrice > strike  → expired worthless
//   stockPrice <= strike → assigned
// Rows with no stockPrice (Yahoo + Schwab both failed) default to
// 'assigned' as the defensive choice — better to mis-tag as a no-op
// assignment than silently let a real assignment slip through as
// worthless.
function isExpiredWorthless(r: PendingConfirmationRow): boolean {
  return r.stockPrice !== null && r.stockPrice > r.strike;
}

type Props = {
  open: boolean;
  rows: PendingConfirmationRow[];
  onCancel: () => void;
  // Should resolve only after the bulk-confirm round-trip completes
  // and the parent has refreshed the positions list. Items carry the
  // per-row action (worthless vs assigned + the stock price) so the
  // route can record assignments with the correct intrinsic-value
  // P&L.
  onConfirm: (items: ConfirmItem[]) => Promise<void>;
};

export function ExpireConfirmationModal({ open, rows, onCancel, onConfirm }: Props) {
  const [submitting, setSubmitting] = useState(false);
  // Default selection: every row checked. Reset whenever the row set
  // changes (a refresh after partial confirm shrinks the list).
  const [selectedIds, setSelectedIds] = useState<Set<string>>(
    () => new Set(rows.map((r) => r.positionId)),
  );
  // Per-row "Create stock position from this assignment" checkbox.
  // Default-checked for every row currently labeled assigned. Reset
  // alongside the main selection whenever the row set changes.
  const [createStockIds, setCreateStockIds] = useState<Set<string>>(
    () =>
      new Set(
        rows.filter((r) => !isExpiredWorthless(r)).map((r) => r.positionId),
      ),
  );
  useEffect(() => {
    setSelectedIds(new Set(rows.map((r) => r.positionId)));
    setCreateStockIds(
      new Set(
        rows.filter((r) => !isExpiredWorthless(r)).map((r) => r.positionId),
      ),
    );
  }, [rows]);

  // Sort the broker buckets in canonical order (Schwab first, then
  // Schwab 2, then Robinhood, then anything else alphabetically).
  const grouped = useMemo(() => {
    const m = new Map<string, PendingConfirmationRow[]>();
    for (const r of rows) {
      const key = (r.broker ?? "other").toLowerCase();
      const arr = m.get(key) ?? [];
      arr.push(r);
      m.set(key, arr);
    }
    const ordered: Array<{ key: string; label: string; items: PendingConfirmationRow[] }> = [];
    for (const k of BROKER_ORDER) {
      const items = m.get(k);
      if (items && items.length > 0) {
        ordered.push({ key: k, label: BROKER_LABEL[k] ?? k.toUpperCase(), items });
        m.delete(k);
      }
    }
    for (const [k, items] of Array.from(m.entries()).sort()) {
      ordered.push({ key: k, label: BROKER_LABEL[k] ?? k.toUpperCase(), items });
    }
    return ordered;
  }, [rows]);

  function toggle(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleCreateStock(id: string) {
    setCreateStockIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const allChecked = selectedIds.size === rows.length && rows.length > 0;
  const noneChecked = selectedIds.size === 0;
  const selectedCount = selectedIds.size;
  const selectedContracts = rows
    .filter((r) => selectedIds.has(r.positionId))
    .reduce((s, r) => s + r.totalContracts, 0);
  const assignedCount = rows.filter(
    (r) => selectedIds.has(r.positionId) && !isExpiredWorthless(r),
  ).length;
  const createStockCount = rows.filter(
    (r) =>
      selectedIds.has(r.positionId) &&
      !isExpiredWorthless(r) &&
      createStockIds.has(r.positionId),
  ).length;

  async function handleConfirm() {
    if (noneChecked) return;
    setSubmitting(true);
    try {
      const items: ConfirmItem[] = rows
        .filter((r) => selectedIds.has(r.positionId))
        .map((r) => {
          const worthless = isExpiredWorthless(r);
          return {
            positionId: r.positionId,
            action: worthless ? "worthless" : "assigned",
            stockPrice: r.stockPrice,
            createStock: !worthless && createStockIds.has(r.positionId),
          };
        });
      await onConfirm(items);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v && !submitting) onCancel(); }}>
      {/* flex column + max-h so the row list scrolls internally on
          short viewports (mobile). Without this, a long expiring
          list pushes the Cancel/Confirm buttons off-screen, leaving
          the user unable to dismiss while Radix keeps body scroll
          locked — the page then appears frozen. */}
      <DialogContent className="flex max-h-[90vh] max-w-2xl flex-col">
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-2 text-amber-200">
            <AlertTriangle className="h-5 w-5" />
            Expiring Positions
          </DialogTitle>
        </DialogHeader>

        <p className="shrink-0 text-sm text-muted-foreground">
          These positions are at or past expiry. Rows labeled{" "}
          <span className="text-emerald-300">Worthless</span> are comfortably
          out-of-the-money (&gt;5%) and safe to close. Rows labeled{" "}
          <span className="text-amber-300">Verify Assignment</span> are within
          5% of strike — verify against your broker before confirming, or
          uncheck to leave them open.
        </p>

        <div className="flex shrink-0 items-center justify-between text-xs">
          <button
            type="button"
            className="text-foreground/70 underline-offset-2 hover:text-foreground hover:underline disabled:opacity-50"
            onClick={() => {
              if (allChecked) setSelectedIds(new Set());
              else setSelectedIds(new Set(rows.map((r) => r.positionId)));
            }}
            disabled={submitting || rows.length === 0}
          >
            {allChecked ? "Clear all" : "Select all"}
          </button>
          <span className="text-muted-foreground">
            {selectedCount} of {rows.length} selected
          </span>
        </div>

        <div className="-mx-6 min-h-0 flex-1 space-y-3 overflow-y-auto px-6">
          {grouped.map((g) => (
            <div key={g.key} className="space-y-1.5">
              <div className="text-xs font-bold uppercase tracking-wider text-foreground/80">
                {g.label}
              </div>
              <ul className="space-y-1.5 rounded border border-border bg-background/40 px-3 py-2 text-sm">
                {g.items.map((r) => {
                  const worthless = isExpiredWorthless(r);
                  const checked = selectedIds.has(r.positionId);
                  const wantStock = createStockIds.has(r.positionId);
                  // Cost basis = strike − avg entry premium per share.
                  // Falls back to just strike when we don't have an
                  // entry premium recorded.
                  const avgPremium: number | null =
                    typeof r.avgPremiumSold === "number" &&
                    Number.isFinite(r.avgPremiumSold)
                      ? r.avgPremiumSold
                      : null;
                  // Option A cost basis = strike. Premium stays on
                  // the put as realized P&L; the stock entry is the
                  // raw strike. (spot − strike) × shares tracks
                  // assignment-side market loss without
                  // double-counting against the put's premium kept.
                  const costBasis = r.strike;
                  const shares = r.totalContracts * 100;
                  return (
                    <li
                      key={r.positionId}
                      className="space-y-1 font-mono"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <label className="flex flex-1 cursor-pointer items-center gap-2">
                          <input
                            type="checkbox"
                            className="h-4 w-4 cursor-pointer accent-emerald-500"
                            checked={checked}
                            onChange={() => toggle(r.positionId)}
                            disabled={submitting}
                          />
                          <span>
                            <span className="font-semibold text-foreground">{r.symbol}</span>{" "}
                            <span className="text-muted-foreground">
                              ${r.strike}P {shortExpiry(r.expiry)} ×{r.totalContracts}
                            </span>
                          </span>
                        </label>
                        <span className="flex items-center gap-2 whitespace-nowrap">
                          <span className={worthless ? "text-emerald-300" : "text-amber-300"}>
                            {fmtPctOtm(r.pctFromStrike)}
                          </span>
                          {worthless ? (
                            <span className="inline-flex items-center gap-1 rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-300">
                              <CheckCircle2 className="h-3 w-3" />
                              Worthless
                            </span>
                          ) : (
                            <span
                              className="inline-flex items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-200"
                              title="Stock at or below strike — position will be recorded as assigned with intrinsic-value P&L."
                            >
                              <AlertTriangle className="h-3 w-3" />
                              Assigned
                            </span>
                          )}
                        </span>
                      </div>
                      {!worthless && (
                        <div className="ml-6 space-y-0.5 text-xs">
                          <div className="text-muted-foreground">
                            Cost basis ={" "}
                            <span className="text-foreground">
                              ${costBasis.toFixed(2)}
                            </span>{" "}
                            /share (strike).{" "}
                            {avgPremium !== null
                              ? `Premium $${avgPremium.toFixed(2)} stays as realized P&L.`
                              : null}
                          </div>
                          <label
                            className={`flex cursor-pointer items-center gap-2 ${
                              checked ? "text-foreground/90" : "text-muted-foreground/60"
                            }`}
                          >
                            <input
                              type="checkbox"
                              className="h-3.5 w-3.5 cursor-pointer accent-emerald-500"
                              checked={wantStock}
                              onChange={() => toggleCreateStock(r.positionId)}
                              disabled={submitting || !checked}
                            />
                            <span>
                              Create {shares} shares of {r.symbol} at{" "}
                              <span className="font-mono">${costBasis.toFixed(2)}</span>
                            </span>
                          </label>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>

        <div className="shrink-0 rounded border border-border bg-background/40 px-3 py-1.5 text-xs text-muted-foreground">
          {selectedCount} position{selectedCount === 1 ? "" : "s"} ·{" "}
          {selectedContracts} contract{selectedContracts === 1 ? "" : "s"}
          {assignedCount > 0 ? (
            <>
              {" "}·{" "}
              <span className="text-amber-300">
                {assignedCount} assigned
                {createStockCount > 0
                  ? ` · ${createStockCount} stock position${createStockCount === 1 ? "" : "s"} will be created`
                  : ""}
              </span>
            </>
          ) : null}
        </div>

        <DialogFooter className="shrink-0">
          <Button variant="secondary" onClick={onCancel} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={handleConfirm} disabled={submitting || noneChecked}>
            {submitting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Expiring…
              </>
            ) : (
              `Confirm — Expire Worthless${selectedCount > 0 ? ` (${selectedCount})` : ""}`
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// fmtDollarsSigned re-export so positions-view can use a single
// import. (Avoids importing from lib/format directly elsewhere.)
export { fmtDollarsSigned };

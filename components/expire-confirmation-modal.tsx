"use client";

// Same-day after-close auto-expire confirmation. Shown after the
// Positions GET response includes a non-empty pending_confirmation
// list, gated by a sessionStorage flag in positions-view so the
// modal only fires once per browser session even if the user
// dismisses without acting.

import { useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
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
  totalContracts: number;
  pctFromStrike: number | null;
  stockPrice: number | null;
  optionPrice: number | null;
  broker: string | null;
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

type Props = {
  open: boolean;
  rows: PendingConfirmationRow[];
  onCancel: () => void;
  // Should resolve only after the bulk-confirm round-trip completes
  // and the parent has refreshed the positions list.
  onConfirm: (positionIds: string[]) => Promise<void>;
};

export function ExpireConfirmationModal({ open, rows, onCancel, onConfirm }: Props) {
  const [submitting, setSubmitting] = useState(false);

  // Sort the broker buckets in canonical order (Schwab first, then
  // Schwab 2, then Robinhood, then anything else alphabetically).
  const grouped = (() => {
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
  })();

  const totalContracts = rows.reduce((s, r) => s + r.totalContracts, 0);

  async function handleConfirm() {
    setSubmitting(true);
    try {
      await onConfirm(rows.map((r) => r.positionId));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v && !submitting) onCancel(); }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-amber-200">
            <AlertTriangle className="h-5 w-5" />
            Options Expiring Today
          </DialogTitle>
        </DialogHeader>

        <p className="text-sm text-muted-foreground">
          The following {rows.length === 1 ? "option" : "options"} expire today
          and are comfortably out-of-the-money (&gt;5%). Please confirm you have
          no remaining trades or positions on these before marking them as
          expired worthless.
        </p>

        <div className="space-y-3">
          {grouped.map((g) => (
            <div key={g.key} className="space-y-1.5">
              <div className="text-xs font-bold uppercase tracking-wider text-foreground/80">
                {g.label}
              </div>
              <ul className="space-y-1 rounded border border-border bg-background/40 px-3 py-2 text-sm">
                {g.items.map((r) => (
                  <li
                    key={r.positionId}
                    className="flex items-baseline justify-between gap-2 font-mono"
                  >
                    <span>
                      <span className="font-semibold text-foreground">{r.symbol}</span>{" "}
                      <span className="text-muted-foreground">
                        ${r.strike}P {shortExpiry(r.expiry)} ×{r.totalContracts}
                      </span>
                    </span>
                    <span className="text-emerald-300">{fmtPctOtm(r.pctFromStrike)}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="rounded border border-border bg-background/40 px-3 py-1.5 text-xs text-muted-foreground">
          {rows.length} position{rows.length === 1 ? "" : "s"} ·{" "}
          {totalContracts} contract{totalContracts === 1 ? "" : "s"} ·
          P&L is calculated from the entry premium on confirm.
        </div>

        <DialogFooter>
          <Button variant="secondary" onClick={onCancel} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={handleConfirm} disabled={submitting}>
            {submitting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Expiring…
              </>
            ) : (
              `Confirm — Expire Worthless${rows.length > 1 ? ` (${rows.length})` : ""}`
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

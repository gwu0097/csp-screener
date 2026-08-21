"use client";

// Surfaces Schwab account activity the auto-import poller couldn't
// turn into a position update — a close/expiration/assignment with no
// matching open position (the common case: a position opened before
// this connection existed and never manually entered), or a
// bulk-create validation failure. This is the "doesn't fit the model,
// tell me" half of lib/schwab-account-import.ts's design — anything
// that DOES fit applies automatically and never shows up here.
// Persistent panel, not a toast: this can land from an unattended cron
// run with nobody watching.
import { useEffect, useState } from "react";
import { AlertOctagon } from "lucide-react";
import { BROKER_LABEL } from "@/lib/brokers";
import { Button } from "@/components/ui/button";

export type UnresolvedItem = {
  id: string;
  activityId: number;
  type: string;
  transactionTime: string;
  broker: string;
  accountNumber: string;
  description: string | null;
  symbol: string | null;
  strike: number | null;
  putCall: string | null;
  expiry: string | null;
  positionEffect: string | null;
  amount: number | null;
  price: number | null;
  contracts: number | null;
  direction: "short" | "long" | null;
  outcome: string;
  detail: string | null;
};

type Props = {
  onImport: (item: UnresolvedItem) => void;
  // Bumped by the parent after a successful "Import" submission so
  // this panel refetches and drops the now-resolved row.
  refreshToken?: number;
};

export function SchwabUnresolvedActivityPanel({ onImport, refreshToken }: Props) {
  const [items, setItems] = useState<UnresolvedItem[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [dismissing, setDismissing] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/schwab-account/unresolved", { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<{ items: UnresolvedItem[] }>) : null))
      .then((j) => {
        if (!cancelled) setItems(j?.items ?? null);
      })
      .catch(() => {
        if (!cancelled) setItems(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshToken]);

  async function dismiss(id: string) {
    setDismissing(id);
    try {
      const res = await fetch(`/api/schwab-account/unresolved/${id}/dismiss`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "user_dismissed" }),
      });
      if (res.ok) {
        setItems((prev) => (prev ? prev.filter((it) => it.id !== id) : prev));
      }
    } finally {
      setDismissing(null);
    }
  }

  if (loading || !items || items.length === 0) return null;

  return (
    <div className="rounded-lg border-2 border-amber-500 bg-amber-500/10 p-4 shadow-[0_0_0_1px_rgba(245,158,11,0.3)]">
      <div className="flex items-center gap-2">
        <AlertOctagon className="h-5 w-5 shrink-0 text-amber-400" />
        <span className="text-base font-bold text-amber-200">
          Schwab activity detected, not applied: {items.length}
        </span>
      </div>
      <p className="mt-1 text-xs text-amber-200/80">
        Real Schwab account activity that doesn&apos;t match anything in this app — most often a
        close/assignment/expiration for a position that was opened before this connection existed.
        Nothing was guessed or written, and this won&apos;t be retried automatically. Import opens a
        prefilled manual entry for it; Dismiss hides it for good without logging anything.
      </p>
      <ul className="mt-3 space-y-2">
        {items.map((it) => (
          <li
            key={it.id}
            className="rounded border border-amber-500/30 bg-amber-500/5 p-2 text-xs text-amber-100"
          >
            <div className="font-mono font-semibold">
              {it.symbol ?? "?"}
              {it.strike !== null ? ` $${it.strike}${it.putCall === "CALL" ? "C" : "P"}` : ""}
              {it.expiry ? ` ${it.expiry}` : ""} · {BROKER_LABEL[it.broker] ?? it.broker}
            </div>
            <div className="mt-1 text-amber-200/90">
              {it.description ??
                `${it.positionEffect ?? it.type}${it.amount !== null ? ` · ${Math.abs(it.amount)}x` : ""}${
                  it.price !== null ? ` @ $${it.price}` : ""
                }`}
            </div>
            <div className="text-amber-200/70">{it.detail ?? it.outcome}</div>
            <div className="text-amber-200/50">{new Date(it.transactionTime).toLocaleString()}</div>
            <div className="mt-2 flex gap-2">
              <Button
                variant="outline"
                size="sm"
                className="h-6 border-amber-500/40 px-2 text-[11px] text-amber-100 hover:bg-amber-500/20"
                onClick={() => onImport(it)}
              >
                Import
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-[11px] text-amber-200/70 hover:bg-amber-500/10 hover:text-amber-100"
                disabled={dismissing === it.id}
                onClick={() => dismiss(it.id)}
              >
                {dismissing === it.id ? "Dismissing…" : "Dismiss"}
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

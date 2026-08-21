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

type UnresolvedItem = {
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
  outcome: string;
  detail: string | null;
};

export function SchwabUnresolvedActivityPanel() {
  const [items, setItems] = useState<UnresolvedItem[] | null>(null);
  const [loading, setLoading] = useState(true);

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
  }, []);

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
        Nothing was guessed or written. Add the missing position manually (Import), then it&apos;ll
        match automatically on the next poll.
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
          </li>
        ))}
      </ul>
    </div>
  );
}

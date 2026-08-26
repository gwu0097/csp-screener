"use client";

// Review feed for robinhood_account_transactions rows the courier-fed
// importer has touched but the user hasn't dismissed yet — mirrors
// components/schwab-activity-panel.tsx exactly (same shape: "applied"
// rows show what auto-imported so it can be validated, "needs_review"
// rows show an Import button that opens a prefilled manual entry).
// Simpler than the Schwab version because a Robinhood row IS one
// execution already (no raw-jsonb leg to unpack, no admin-noise
// outcomes to filter — see the activity route's header comment).
import { useEffect, useState } from "react";
import { AlertOctagon, CheckCircle2 } from "lucide-react";
import { BROKER_LABEL } from "@/lib/brokers";
import { Button } from "@/components/ui/button";

export type RobinhoodActivityItem = {
  id: string;
  executionId: string;
  orderId: string;
  transactionTime: string;
  broker: string;
  accountNumber: string;
  symbol: string | null;
  strike: number | null;
  putCall: string | null;
  expiry: string | null;
  positionEffect: string | null; // "OPENING" | "CLOSING"
  contracts: number | null;
  price: number | null;
  direction: "short" | "long" | null;
  outcome: string;
  detail: string | null;
  status: "applied" | "needs_review";
};

type Props = {
  onImport: (item: RobinhoodActivityItem) => void;
  // Fires once with every currently-loaded needs_review item — the
  // parent walks them through the same prefilled-manual-entry modal a
  // single Import opens, one after another (not a silent bulk submit),
  // so each one still gets a look before it's confirmed.
  onImportAll: (items: RobinhoodActivityItem[]) => void;
  // Bumped by the parent after a successful "Import" submission so
  // this panel refetches and drops the now-resolved row.
  refreshToken?: number;
};

export function RobinhoodActivityPanel({ onImport, onImportAll, refreshToken }: Props) {
  const [items, setItems] = useState<RobinhoodActivityItem[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [dismissing, setDismissing] = useState<string | null>(null);
  const [dismissingAll, setDismissingAll] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/robinhood-account/activity", { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<{ items: RobinhoodActivityItem[] }>) : null))
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

  async function dismissOne(id: string, reason: string) {
    const res = await fetch(`/api/robinhood-account/activity/${id}/dismiss`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason }),
    });
    return res.ok;
  }

  async function dismiss(id: string) {
    setDismissing(id);
    try {
      if (await dismissOne(id, "user_dismissed")) {
        setItems((prev) => (prev ? prev.filter((it) => it.id !== id) : prev));
      }
    } finally {
      setDismissing(null);
    }
  }

  async function dismissAll() {
    if (!items || items.length === 0) return;
    setDismissingAll(true);
    // Only the ids currently loaded — anything that lands after this
    // click starts a fresh, unread notification.
    const ids = items.map((it) => it.id);
    try {
      const results = await Promise.all(ids.map((id) => dismissOne(id, "user_dismissed_all")));
      const failed = new Set(ids.filter((_, i) => !results[i]));
      setItems((prev) => (prev ? prev.filter((it) => failed.has(it.id)) : prev));
    } finally {
      setDismissingAll(false);
    }
  }

  if (loading || !items || items.length === 0) return null;

  const needsReviewItems = items.filter((it) => it.status === "needs_review");
  const needsReviewCount = needsReviewItems.length;
  const alarmed = needsReviewCount > 0;

  return (
    <div
      className={
        "rounded-lg border-2 p-4 shadow-[0_0_0_1px_rgba(0,0,0,0.15)] " +
        (alarmed
          ? "border-amber-500 bg-amber-500/10"
          : "border-emerald-500/60 bg-emerald-500/10")
      }
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {alarmed ? (
            <AlertOctagon className="h-5 w-5 shrink-0 text-amber-400" />
          ) : (
            <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-400" />
          )}
          <span className={"text-base font-bold " + (alarmed ? "text-amber-200" : "text-emerald-200")}>
            Robinhood activity: {items.length} to review
          </span>
        </div>
        <div className="flex items-center gap-1">
          {needsReviewCount > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-[11px] text-amber-200/70 hover:text-amber-100"
              disabled={dismissingAll}
              onClick={() => onImportAll(needsReviewItems)}
            >
              {`Import all (${needsReviewCount})`}
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            className={
              "h-6 px-2 text-[11px] " +
              (alarmed ? "text-amber-200/70 hover:text-amber-100" : "text-emerald-200/70 hover:text-emerald-100")
            }
            disabled={dismissingAll}
            onClick={() => dismissAll()}
          >
            {dismissingAll ? "Dismissing…" : "Dismiss all"}
          </Button>
        </div>
      </div>
      <p className={"mt-1 text-xs " + (alarmed ? "text-amber-200/80" : "text-emerald-200/80")}>
        What the Robinhood courier detected and what it couldn&apos;t apply. Applied rows are already
        reflected in your positions — validate, then Dismiss. Needs-review rows weren&apos;t written
        anywhere and won&apos;t be retried: Import opens a prefilled manual entry, Import all walks
        through the same prefilled entry for every needs-review row one after another so each still
        gets a look before it&apos;s confirmed, or Dismiss to ignore for good.
      </p>
      <ul className="mt-3 space-y-2">
        {items.map((it) => {
          const rowAmber = it.status === "needs_review";
          return (
            <li
              key={it.id}
              className={
                "rounded border p-2 text-xs " +
                (rowAmber
                  ? "border-amber-500/30 bg-amber-500/5 text-amber-100"
                  : "border-emerald-500/30 bg-emerald-500/5 text-emerald-100")
              }
            >
              <div className="flex items-center gap-2 font-mono font-semibold">
                <span
                  className={
                    "rounded px-1 py-0.5 text-[9px] font-bold uppercase tracking-wide " +
                    (rowAmber ? "bg-amber-500/30 text-amber-100" : "bg-emerald-500/30 text-emerald-100")
                  }
                >
                  {rowAmber ? "Needs review" : "Applied"}
                </span>
                {it.symbol ?? "?"}
                {it.strike !== null ? ` $${it.strike}${it.putCall === "call" ? "C" : "P"}` : ""}
                {it.expiry ? ` ${it.expiry}` : ""} · {BROKER_LABEL[it.broker] ?? it.broker}
              </div>
              <div className={"mt-1 " + (rowAmber ? "text-amber-200/90" : "text-emerald-200/90")}>
                {it.positionEffect ?? "?"}
                {it.contracts !== null ? ` · ${it.contracts}x` : ""}
                {it.price !== null ? ` @ $${it.price}` : ""}
              </div>
              <div className={rowAmber ? "text-amber-200/70" : "text-emerald-200/70"}>
                {it.detail ?? it.outcome}
              </div>
              <div className={rowAmber ? "text-amber-200/50" : "text-emerald-200/50"}>
                {new Date(it.transactionTime).toLocaleString()}
              </div>
              <div className="mt-2 flex gap-2">
                {rowAmber && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-6 border-amber-500/40 px-2 text-[11px] text-amber-100 hover:bg-amber-500/20"
                    onClick={() => onImport(it)}
                  >
                    Import
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  className={
                    "h-6 px-2 text-[11px] " +
                    (rowAmber
                      ? "text-amber-200/70 hover:bg-amber-500/10 hover:text-amber-100"
                      : "text-emerald-200/70 hover:bg-emerald-500/10 hover:text-emerald-100")
                  }
                  disabled={dismissing === it.id}
                  onClick={() => dismiss(it.id)}
                >
                  {dismissing === it.id ? "Dismissing…" : "Dismiss"}
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

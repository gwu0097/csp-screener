"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

type Props = {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onSuccess: (msg: string) => void;
  prefill?: {
    symbol?: string;
    strike?: number;
    expiry?: string;
    premium?: number;
    action?: "open" | "close";
    broker?: string;
  };
};

const BROKERS = ["schwab", "robinhood", "fidelity", "other"] as const;

export function ImportManualModal({ open, onOpenChange, onSuccess, prefill }: Props) {
  const [symbol, setSymbol] = useState(prefill?.symbol ?? "");
  const [action, setAction] = useState<"open" | "close">(prefill?.action ?? "open");
  const [strike, setStrike] = useState<number | "">(prefill?.strike ?? "");
  const [expiry, setExpiry] = useState(prefill?.expiry ?? "");
  const [premium, setPremium] = useState<number | "">(prefill?.premium ?? "");
  const [contracts, setContracts] = useState<number>(1);
  const [broker, setBroker] = useState<string>(prefill?.broker ?? "schwab");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setError(null);
    if (!symbol || !expiry || strike === "" || premium === "") {
      setError("Fill in symbol, strike, expiry, and premium");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/trades/bulk-create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          trades: [
            {
              symbol,
              action,
              contracts,
              strike: Number(strike),
              expiry,
              optionType: "put",
              premium: Number(premium),
              broker,
            },
          ],
        }),
      });
      const json = (await res.json()) as {
        created?: number;
        matched?: number;
        unmatched?: number;
        errors?: string[];
        error?: string;
      };
      if (!res.ok || json.error) {
        throw new Error(json.error ?? `HTTP ${res.status}`);
      }
      const parts = [
        `Logged ${json.created ?? 0}`,
        (json.matched ?? 0) > 0 ? `matched ${json.matched}` : null,
        (json.unmatched ?? 0) > 0 ? `unmatched ${json.unmatched}` : null,
      ].filter(Boolean);
      onSuccess(parts.join(", "));
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to log");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add trade manually</DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <Field label="Symbol">
            <input
              value={symbol}
              onChange={(e) => setSymbol(e.target.value.toUpperCase())}
              className="w-full rounded-md border border-border bg-background px-2 py-1 uppercase"
              placeholder="TSLA"
            />
          </Field>
          <Field label="Action">
            <select
              value={action}
              onChange={(e) => setAction(e.target.value as "open" | "close")}
              className="w-full rounded-md border border-border bg-background px-2 py-1"
            >
              <option value="open">Sell to open</option>
              <option value="close">Buy to close</option>
            </select>
          </Field>
          <Field label="Strike">
            <input
              type="number"
              step="0.5"
              value={strike}
              onChange={(e) => setStrike(e.target.value === "" ? "" : Number(e.target.value))}
              className="w-full rounded-md border border-border bg-background px-2 py-1"
            />
          </Field>
          <Field label="Expiry">
            <input
              type="date"
              value={expiry}
              onChange={(e) => setExpiry(e.target.value)}
              className="w-full rounded-md border border-border bg-background px-2 py-1"
            />
          </Field>
          <Field label="Premium">
            <input
              type="number"
              step="0.01"
              value={premium}
              onChange={(e) => setPremium(e.target.value === "" ? "" : Number(e.target.value))}
              className="w-full rounded-md border border-border bg-background px-2 py-1"
            />
          </Field>
          <Field label="Contracts">
            <input
              type="number"
              min="1"
              value={contracts}
              onChange={(e) => setContracts(Math.max(1, Number(e.target.value) || 1))}
              className="w-full rounded-md border border-border bg-background px-2 py-1"
            />
          </Field>
          <Field label="Broker">
            <select
              value={broker}
              onChange={(e) => setBroker(e.target.value)}
              className="w-full rounded-md border border-border bg-background px-2 py-1"
            >
              {BROKERS.map((b) => (
                <option key={b} value={b}>
                  {b[0].toUpperCase() + b.slice(1)}
                </option>
              ))}
            </select>
          </Field>
        </div>
        {error && (
          <div className="mt-2 rounded border border-rose-500/40 bg-rose-500/10 px-2 py-1 text-xs text-rose-200">
            {error}
          </div>
        )}
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={submitting}>
            {submitting ? "Logging…" : "Log trade"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

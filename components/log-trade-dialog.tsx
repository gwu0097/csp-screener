"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import type { ScreenerResult } from "@/lib/screener";

type Props = {
  row: ScreenerResult;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
};

export function LogTradeDialog({ row, open, onOpenChange, onSuccess }: Props) {
  const [strike, setStrike] = useState(row.stageFour?.suggestedStrike ?? 0);
  const [premium, setPremium] = useState(row.stageFour?.premium ?? 0);
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/trade-log", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol: row.symbol,
          trade_date: new Date().toISOString().slice(0, 10),
          earnings_date: row.earningsDate,
          entry_stock_price: row.price,
          strike,
          expiry: row.expiry,
          premium_sold: premium,
          crush_grade: row.stageThree?.crushGrade ?? null,
          opportunity_grade: row.stageFour?.opportunityGrade ?? null,
          notes,
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      onSuccess();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Log trade · {row.symbol}</DialogTitle>
          <DialogDescription>
            Sell to open · expiry {row.expiry} · grade {row.stageThree?.crushGrade}/{row.stageFour?.opportunityGrade}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <Field label="Strike">
            <input
              type="number"
              step="0.5"
              value={strike}
              onChange={(e) => setStrike(Number(e.target.value))}
              className="w-full rounded-md border border-border bg-background px-2 py-1"
            />
          </Field>
          <Field label="Premium sold">
            <input
              type="number"
              step="0.01"
              value={premium}
              onChange={(e) => setPremium(Number(e.target.value))}
              className="w-full rounded-md border border-border bg-background px-2 py-1"
            />
          </Field>
          <Field label="Notes">
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              className="w-full rounded-md border border-border bg-background px-2 py-1"
            />
          </Field>
          {error && <div className="text-rose-300">{error}</div>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={submitting || strike <= 0 || premium <= 0}>
            {submitting ? "Saving…" : "Save trade"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

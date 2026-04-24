"use client";

import { useEffect, useState } from "react";
import { Star } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

export type SwingIdeaTrade = {
  id: string;
  swing_idea_id: string | null;
  symbol: string;
  shares: number | null;
  entry_price: number | null;
  entry_date: string | null;
  exit_price: number | null;
  exit_date: string | null;
  realized_pnl: number | null;
  return_pct: number | null;
  exit_reason: string | null;
  status: string;
};

export type SwingIdea = {
  id: string;
  symbol: string;
  catalyst: string | null;
  thesis: string | null;
  ai_summary: string | null;
  analyst_sentiment: string | null;
  analyst_target: number | null;
  forward_pe: number | null;
  week_52_low: number | null;
  week_52_high: number | null;
  price_at_discovery: number | null;
  user_thesis: string | null;
  timeframe: string | null;
  conviction: number | null;
  status: string;
  discovered_at: string;
  updated_at: string;
  created_at: string;
  // Populated by /api/swings/ideas when the idea is in a trade-driven stage
  // (ENTERED → latest open trade, EXITED → latest closed trade). null for
  // WATCHING / CONVICTION and when no linked trade exists.
  active_trade?: SwingIdeaTrade | null;
};

type Mode =
  | { kind: "create" }
  | { kind: "edit"; idea: SwingIdea };

export function SwingIdeaDialog({
  open,
  onOpenChange,
  mode,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  mode: Mode;
  onSaved: () => void;
}) {
  const seed = mode.kind === "edit" ? mode.idea : null;

  const [symbol, setSymbol] = useState("");
  const [catalyst, setCatalyst] = useState("");
  const [userThesis, setUserThesis] = useState("");
  const [timeframe, setTimeframe] = useState<"1month" | "3months" | "6months">(
    "3months",
  );
  const [conviction, setConviction] = useState<number>(3);
  const [sentiment, setSentiment] = useState<
    "bullish" | "bearish" | "mixed" | "neutral"
  >("bullish");
  const [analystTarget, setAnalystTarget] = useState("");
  const [priceAtDiscovery, setPriceAtDiscovery] = useState("");
  const [forwardPe, setForwardPe] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset form whenever the dialog opens or the seed changes.
  useEffect(() => {
    if (!open) return;
    if (seed) {
      setSymbol(seed.symbol);
      setCatalyst(seed.catalyst ?? "");
      setUserThesis(seed.user_thesis ?? "");
      setTimeframe(
        (seed.timeframe as "1month" | "3months" | "6months") ?? "3months",
      );
      setConviction(seed.conviction ?? 3);
      setSentiment(
        (seed.analyst_sentiment as
          | "bullish"
          | "bearish"
          | "mixed"
          | "neutral") ?? "bullish",
      );
      setAnalystTarget(
        seed.analyst_target !== null ? String(seed.analyst_target) : "",
      );
      setPriceAtDiscovery(
        seed.price_at_discovery !== null
          ? String(seed.price_at_discovery)
          : "",
      );
      setForwardPe(seed.forward_pe !== null ? String(seed.forward_pe) : "");
    } else {
      setSymbol("");
      setCatalyst("");
      setUserThesis("");
      setTimeframe("3months");
      setConviction(3);
      setSentiment("bullish");
      setAnalystTarget("");
      setPriceAtDiscovery("");
      setForwardPe("");
    }
    setError(null);
  }, [open, seed]);

  const disabled = submitting || symbol.trim().length === 0;

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      const body = {
        symbol: symbol.trim().toUpperCase(),
        catalyst: catalyst.trim() || null,
        user_thesis: userThesis.trim() || null,
        timeframe,
        conviction,
        analyst_sentiment: sentiment,
        analyst_target: analystTarget ? Number(analystTarget) : null,
        price_at_discovery: priceAtDiscovery ? Number(priceAtDiscovery) : null,
        forward_pe: forwardPe ? Number(forwardPe) : null,
      };
      const url =
        mode.kind === "edit"
          ? `/api/swings/ideas/${mode.idea.id}`
          : "/api/swings/ideas";
      const method = mode.kind === "edit" ? "PATCH" : "POST";
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      onSaved();
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {mode.kind === "edit" ? `Edit idea · ${seed?.symbol}` : "Add swing idea"}
          </DialogTitle>
        </DialogHeader>

        <div className="grid gap-3 py-2">
          <label className="grid gap-1 text-xs">
            <span className="text-muted-foreground">Symbol *</span>
            <input
              type="text"
              value={symbol}
              onChange={(e) => setSymbol(e.target.value.toUpperCase())}
              className="rounded border border-border bg-background px-2 py-1.5 font-mono text-sm uppercase"
              placeholder="AMD"
              autoFocus
            />
          </label>

          <label className="grid gap-1 text-xs">
            <span className="text-muted-foreground">
              Catalyst{" "}
              <span className="text-[10px]">(near-term driver — Phase 2 will auto-fill)</span>
            </span>
            <input
              type="text"
              value={catalyst}
              onChange={(e) => setCatalyst(e.target.value)}
              className="rounded border border-border bg-background px-2 py-1.5 text-sm"
              placeholder="MI350 launch + MSFT deal"
            />
          </label>

          <label className="grid gap-1 text-xs">
            <span className="text-muted-foreground">Your thesis</span>
            <textarea
              value={userThesis}
              onChange={(e) => setUserThesis(e.target.value)}
              rows={3}
              className="rounded border border-border bg-background px-2 py-1.5 text-sm"
              placeholder="Why do you like this?"
            />
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="grid gap-1 text-xs">
              <span className="text-muted-foreground">Timeframe</span>
              <select
                value={timeframe}
                onChange={(e) =>
                  setTimeframe(e.target.value as "1month" | "3months" | "6months")
                }
                className="rounded border border-border bg-background px-2 py-1.5 text-sm"
              >
                <option value="1month">1 month</option>
                <option value="3months">3 months</option>
                <option value="6months">6 months</option>
              </select>
            </label>

            <label className="grid gap-1 text-xs">
              <span className="text-muted-foreground">Conviction</span>
              <StarRating value={conviction} onChange={setConviction} />
            </label>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <label className="grid gap-1 text-xs">
              <span className="text-muted-foreground">Analyst sentiment</span>
              <select
                value={sentiment}
                onChange={(e) =>
                  setSentiment(
                    e.target.value as "bullish" | "bearish" | "mixed" | "neutral",
                  )
                }
                className="rounded border border-border bg-background px-2 py-1.5 text-sm"
              >
                <option value="bullish">Bullish</option>
                <option value="bearish">Bearish</option>
                <option value="mixed">Mixed</option>
                <option value="neutral">Neutral</option>
              </select>
            </label>

            <label className="grid gap-1 text-xs">
              <span className="text-muted-foreground">Analyst target</span>
              <input
                type="number"
                step="0.01"
                value={analystTarget}
                onChange={(e) => setAnalystTarget(e.target.value)}
                className="rounded border border-border bg-background px-2 py-1.5 text-sm"
                placeholder="optional"
              />
            </label>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <label className="grid gap-1 text-xs">
              <span className="text-muted-foreground">Price at discovery</span>
              <input
                type="number"
                step="0.01"
                value={priceAtDiscovery}
                onChange={(e) => setPriceAtDiscovery(e.target.value)}
                className="rounded border border-border bg-background px-2 py-1.5 text-sm"
                placeholder="175.40"
              />
            </label>

            <label className="grid gap-1 text-xs">
              <span className="text-muted-foreground">Forward P/E</span>
              <input
                type="number"
                step="0.1"
                value={forwardPe}
                onChange={(e) => setForwardPe(e.target.value)}
                className="rounded border border-border bg-background px-2 py-1.5 text-sm"
                placeholder="28"
              />
            </label>
          </div>

          {error && (
            <div className="rounded border border-rose-500/40 bg-rose-500/10 p-2 text-xs text-rose-300">
              {error}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button onClick={submit} disabled={disabled}>
            {submitting ? "Saving…" : mode.kind === "edit" ? "Save changes" : "Add idea"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function StarRating({
  value,
  onChange,
  readonly = false,
  size = "sm",
}: {
  value: number;
  onChange?: (v: number) => void;
  readonly?: boolean;
  size?: "sm" | "xs";
}) {
  const sizeClass = size === "xs" ? "h-3 w-3" : "h-4 w-4";
  return (
    <div className="flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map((n) => {
        const filled = n <= value;
        return (
          <button
            key={n}
            type="button"
            onClick={() => !readonly && onChange?.(n)}
            disabled={readonly}
            className={`${readonly ? "cursor-default" : "cursor-pointer hover:scale-110"}`}
            aria-label={`${n} star${n === 1 ? "" : "s"}`}
          >
            <Star
              className={`${sizeClass} ${filled ? "fill-amber-400 text-amber-400" : "text-muted-foreground"}`}
            />
          </button>
        );
      })}
    </div>
  );
}

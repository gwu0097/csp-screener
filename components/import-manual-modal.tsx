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

const BROKERS = ["schwab", "schwab2", "robinhood", "fidelity", "other"] as const;
const BROKER_LABELS: Record<(typeof BROKERS)[number], string> = {
  schwab: "Schwab",
  schwab2: "Schwab 2",
  robinhood: "Robinhood",
  fidelity: "Fidelity",
  other: "Other",
};

function todayPstIso(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

type TradeType = "option" | "stock";
type StockAction = "buy" | "sell";

export function ImportManualModal({ open, onOpenChange, onSuccess, prefill }: Props) {
  const today = todayPstIso();
  // Trade-type toggle. Defaults to option since prefill only ever
  // carries option fields and most manual entries are options.
  const [tradeType, setTradeType] = useState<TradeType>("option");

  // Shared
  const [symbol, setSymbol] = useState(prefill?.symbol ?? "");
  const [broker, setBroker] = useState<string>(prefill?.broker ?? "schwab");
  const [date, setDate] = useState<string>(today);

  // Option-only
  const [action, setAction] = useState<"open" | "close">(prefill?.action ?? "open");
  const [strike, setStrike] = useState<number | "">(prefill?.strike ?? "");
  const [expiry, setExpiry] = useState(prefill?.expiry ?? "");
  const [premium, setPremium] = useState<number | "">(prefill?.premium ?? "");
  const [contracts, setContracts] = useState<number>(1);
  const [direction, setDirection] = useState<"short" | "long">("short");
  const [optionType, setOptionType] = useState<"put" | "call">("put");

  // Stock-only
  const [stockAction, setStockAction] = useState<StockAction>("sell");
  const [shares, setShares] = useState<number | "">("");
  const [price, setPrice] = useState<number | "">("");

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setError(null);
    if (!symbol) {
      setError("Symbol required");
      return;
    }
    if (date > today) {
      setError("Date cannot be in the future");
      return;
    }
    if (tradeType === "option") {
      if (!expiry || strike === "" || premium === "") {
        setError("Fill in strike, expiry, and premium");
        return;
      }
    } else {
      if (stockAction !== "buy" && stockAction !== "sell") {
        setError("Pick buy or sell");
        return;
      }
      if (shares === "" || Number(shares) <= 0) {
        setError("Shares must be > 0");
        return;
      }
      if (price === "" || Number(price) < 0) {
        setError("Price must be ≥ 0");
        return;
      }
      // The bulk-create stockTrades branch is sell-only — the buy
      // side comes from option assignment, not manual entry. Surface
      // this up front rather than 422-ing from the server.
      if (stockAction === "buy") {
        setError(
          "Manual stock buys aren't supported — shares originate from option assignment. Use the assignment flow.",
        );
        return;
      }
    }
    setSubmitting(true);
    try {
      const body =
        tradeType === "option"
          ? {
              trades: [
                {
                  symbol,
                  action,
                  contracts,
                  strike: Number(strike),
                  expiry,
                  optionType,
                  direction,
                  premium: Number(premium),
                  broker,
                  trade_date: date,
                },
              ],
            }
          : {
              stockTrades: [
                {
                  symbol,
                  action: stockAction,
                  shares: Number(shares),
                  price: Number(price),
                  date,
                  broker,
                },
              ],
            };
      const res = await fetch("/api/trades/bulk-create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as {
        positions_created?: number;
        positions_updated?: number;
        fills_inserted?: number;
        stocks_closed?: number;
        stocks_partial?: number;
        errors?: string[];
        error?: string;
      };
      // Phase-1 422 returns structured errors[]; surface them all.
      if (json.errors && json.errors.length > 0) {
        throw new Error(json.errors.join("; "));
      }
      if (!res.ok || json.error) {
        throw new Error(json.error ?? `HTTP ${res.status}`);
      }
      const parts = [
        `Logged ${json.fills_inserted ?? 0} fill${(json.fills_inserted ?? 0) === 1 ? "" : "s"}`,
        (json.positions_created ?? 0) > 0 ? `${json.positions_created} new position${json.positions_created === 1 ? "" : "s"}` : null,
        (json.positions_updated ?? 0) > 0 ? `${json.positions_updated} updated` : null,
        (json.stocks_closed ?? 0) > 0 ? `${json.stocks_closed} stock closed` : null,
        (json.stocks_partial ?? 0) > 0 ? `${json.stocks_partial} stock partial` : null,
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

        {/* Trade-type toggle — sits above the fields so the form below
            re-renders into the matching shape. Stock fields are a
            distinct set (Shares / Price) and don't share the option grid. */}
        <div className="mb-3 flex gap-2 text-xs">
          <button
            type="button"
            onClick={() => setTradeType("option")}
            className={
              "rounded border px-3 py-1 font-semibold uppercase tracking-wider " +
              (tradeType === "option"
                ? "border-foreground/60 bg-foreground/10 text-foreground"
                : "border-border bg-background text-muted-foreground hover:border-foreground/40")
            }
          >
            Option
          </button>
          <button
            type="button"
            onClick={() => setTradeType("stock")}
            className={
              "rounded border px-3 py-1 font-semibold uppercase tracking-wider " +
              (tradeType === "stock"
                ? "border-foreground/60 bg-foreground/10 text-foreground"
                : "border-border bg-background text-muted-foreground hover:border-foreground/40")
            }
          >
            Stock
          </button>
        </div>

        {tradeType === "option" ? (
          <div className="grid grid-cols-2 gap-3 text-sm">
            <Field label="Symbol">
              <input
                value={symbol}
                onChange={(e) => setSymbol(e.target.value.toUpperCase())}
                className="w-full rounded-md border border-border bg-background px-2 py-1 uppercase"
                placeholder="TSLA"
              />
            </Field>
            <Field label="Direction">
              <select
                value={direction}
                onChange={(e) =>
                  setDirection(e.target.value as "short" | "long")
                }
                className="w-full rounded-md border border-border bg-background px-2 py-1"
              >
                <option value="short">Short (sell to open)</option>
                <option value="long">Long (buy to open)</option>
              </select>
            </Field>
            <Field label="Option type">
              <select
                value={optionType}
                onChange={(e) =>
                  setOptionType(e.target.value as "put" | "call")
                }
                className="w-full rounded-md border border-border bg-background px-2 py-1"
              >
                <option value="put">Put</option>
                <option value="call">Call</option>
              </select>
            </Field>
            <Field label="Action">
              <select
                value={action}
                onChange={(e) => setAction(e.target.value as "open" | "close")}
                className="w-full rounded-md border border-border bg-background px-2 py-1"
              >
                <option value="open">
                  {direction === "long" ? "Buy to open" : "Sell to open"}
                </option>
                <option value="close">
                  {direction === "long" ? "Sell to close" : "Buy to close"}
                </option>
              </select>
            </Field>
            <Field label="Strike">
              <input
                type="number"
                step="0.5"
                value={strike}
                onChange={(e) =>
                  setStrike(e.target.value === "" ? "" : Number(e.target.value))
                }
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
                onChange={(e) =>
                  setPremium(e.target.value === "" ? "" : Number(e.target.value))
                }
                className="w-full rounded-md border border-border bg-background px-2 py-1"
              />
            </Field>
            <Field label="Contracts">
              <input
                type="number"
                min="1"
                value={contracts}
                onChange={(e) =>
                  setContracts(Math.max(1, Number(e.target.value) || 1))
                }
                className="w-full rounded-md border border-border bg-background px-2 py-1"
              />
            </Field>
            <Field label="Trade date">
              <input
                type="date"
                value={date}
                max={today}
                onChange={(e) => setDate(e.target.value)}
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
                    {BROKER_LABELS[b]}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 text-sm">
            <Field label="Symbol">
              <input
                value={symbol}
                onChange={(e) => setSymbol(e.target.value.toUpperCase())}
                className="w-full rounded-md border border-border bg-background px-2 py-1 uppercase"
                placeholder="ZS"
              />
            </Field>
            <Field label="Action">
              <select
                value={stockAction}
                onChange={(e) => setStockAction(e.target.value as StockAction)}
                className="w-full rounded-md border border-border bg-background px-2 py-1"
              >
                <option value="sell">Sell shares</option>
                <option value="buy">Buy shares</option>
              </select>
            </Field>
            <Field label="Shares">
              <input
                type="number"
                min="1"
                step="1"
                value={shares}
                onChange={(e) =>
                  setShares(e.target.value === "" ? "" : Number(e.target.value))
                }
                className="w-full rounded-md border border-border bg-background px-2 py-1"
              />
            </Field>
            <Field label="Price (per share)">
              <input
                type="number"
                min="0"
                step="0.01"
                value={price}
                onChange={(e) =>
                  setPrice(e.target.value === "" ? "" : Number(e.target.value))
                }
                className="w-full rounded-md border border-border bg-background px-2 py-1"
              />
            </Field>
            <Field label="Trade date">
              <input
                type="date"
                value={date}
                max={today}
                onChange={(e) => setDate(e.target.value)}
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
                    {BROKER_LABELS[b]}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        )}

        {error && (
          <div className="mt-2 rounded border border-rose-500/40 bg-rose-500/10 px-2 py-1 text-xs text-rose-200">
            {error}
          </div>
        )}
        <DialogFooter>
          <Button
            variant="secondary"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button onClick={submit} disabled={submitting || date > today}>
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

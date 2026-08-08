"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

export type SwingTrade = {
  id: string;
  swing_idea_id: string | null;
  symbol: string;
  broker: string | null;
  created_at: string;
  updated_at: string;
  setup_name: string | null;
  thesis: string;
  entry_date: string;
  entry_price: number;
  shares: number;
  planned_stop: number;
  planned_target: number | null;
  initial_risk_dollars: number;
  risk_pct_of_portfolio: number | null;
  portfolio_value_at_entry: number | null;
  risk_limit_overridden: boolean;
  atr_at_entry: number | null;
  adr_pct_at_entry: number | null;
  conviction: number | null;
  market_regime: string | null;
  exit_date: string | null;
  exit_price: number | null;
  exit_reason: string | null;
  realized_pnl: number | null;
  r_multiple: number | null;
  return_pct: number | null;
  days_held: number | null;
  max_favorable_excursion_r: number | null;
  max_adverse_excursion_r: number | null;
  price_two_weeks_after_exit: number | null;
  exit_quality_note: string | null;
  status: "open" | "closed";
};

type Prefill = {
  price: number | null;
  sma20: number | null;
  sma50: number | null;
  sma200: number | null;
  atr14: number | null;
  adr_pct: number | null;
};

type PendingConfirmation = {
  risk_pct_of_portfolio: number;
  max_risk_pct: number;
  initial_risk_dollars: number;
};

function fmtMoney(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  return `$${n.toFixed(2)}`;
}

function fmtPct(n: number | null, digits = 2): string {
  if (n === null || !Number.isFinite(n)) return "—";
  return `${n.toFixed(digits)}%`;
}

export function SwingTradeDialog({
  open,
  onOpenChange,
  prefill,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  prefill?: { symbol?: string; swing_idea_id?: string };
  onSaved: () => void;
}) {
  const todayIso = new Date().toISOString().slice(0, 10);

  const [symbol, setSymbol] = useState("");
  const [broker, setBroker] = useState<"schwab" | "schwab2" | "robinhood" | "other">("schwab");
  const [setupName, setSetupName] = useState("");
  const [thesis, setThesis] = useState("");
  const [entryDate, setEntryDate] = useState(todayIso);
  const [entryPrice, setEntryPrice] = useState("");
  const [shares, setShares] = useState("");
  const [plannedStop, setPlannedStop] = useState("");
  const [plannedTarget, setPlannedTarget] = useState("");
  const [conviction, setConviction] = useState<number | "">("");
  const [marketRegime, setMarketRegime] = useState("");

  const [marketData, setMarketData] = useState<Prefill | null>(null);
  const [loadingPrefill, setLoadingPrefill] = useState(false);

  const [portfolioValue, setPortfolioValue] = useState("");
  const [maxRiskPct, setMaxRiskPct] = useState(0.5);

  const [pendingConfirmation, setPendingConfirmation] = useState<PendingConfirmation | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setSymbol(prefill?.symbol ?? "");
    setBroker("schwab");
    setSetupName("");
    setThesis("");
    setEntryDate(todayIso);
    setEntryPrice("");
    setShares("");
    setPlannedStop("");
    setPlannedTarget("");
    setConviction("");
    setMarketRegime("");
    setMarketData(null);
    setPendingConfirmation(null);
    setError(null);
    fetch("/api/swings/journal-settings")
      .then((r) => r.json())
      .then((j: { max_risk_pct?: number; portfolio_value?: number | null }) => {
        setMaxRiskPct(j.max_risk_pct ?? 0.5);
        setPortfolioValue(j.portfolio_value ? String(j.portfolio_value) : "");
      })
      .catch(() => {});
    if (prefill?.symbol) void loadPrefill(prefill.symbol);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, prefill?.symbol, todayIso]);

  async function loadPrefill(sym: string) {
    const s = sym.trim().toUpperCase();
    if (!s) return;
    setLoadingPrefill(true);
    try {
      const res = await fetch(`/api/swings/trades/prefill?symbol=${encodeURIComponent(s)}`);
      const json = (await res.json()) as Prefill & { error?: string };
      if (!res.ok || json.error) return;
      setMarketData(json);
      setEntryPrice((prev) => (prev.trim() === "" && json.price !== null ? String(json.price) : prev));
    } catch {
      // best-effort — the form still works without prefill
    } finally {
      setLoadingPrefill(false);
    }
  }

  const entryPriceNum = Number(entryPrice);
  const sharesNum = Number(shares);
  const plannedStopNum = Number(plannedStop);
  const plannedTargetNum = plannedTarget.trim() === "" ? null : Number(plannedTarget);
  const portfolioValueNum = portfolioValue.trim() === "" ? null : Number(portfolioValue);

  const validGeometry =
    Number.isFinite(entryPriceNum) &&
    entryPriceNum > 0 &&
    Number.isFinite(sharesNum) &&
    sharesNum > 0 &&
    Number.isFinite(plannedStopNum) &&
    plannedStopNum > 0 &&
    plannedStopNum < entryPriceNum;

  const initialRiskDollars = useMemo(
    () => (validGeometry ? (entryPriceNum - plannedStopNum) * sharesNum : null),
    [validGeometry, entryPriceNum, plannedStopNum, sharesNum],
  );
  const stopDistancePct = useMemo(
    () => (validGeometry ? ((entryPriceNum - plannedStopNum) / entryPriceNum) * 100 : null),
    [validGeometry, entryPriceNum, plannedStopNum],
  );
  const rr = useMemo(() => {
    if (!validGeometry || plannedTargetNum === null || !Number.isFinite(plannedTargetNum)) return null;
    const risk = entryPriceNum - plannedStopNum;
    if (risk <= 0) return null;
    return (plannedTargetNum - entryPriceNum) / risk;
  }, [validGeometry, entryPriceNum, plannedStopNum, plannedTargetNum]);
  const riskPctOfPortfolio = useMemo(() => {
    if (initialRiskDollars === null || portfolioValueNum === null || portfolioValueNum <= 0) return null;
    return (initialRiskDollars / portfolioValueNum) * 100;
  }, [initialRiskDollars, portfolioValueNum]);

  const overLimit = riskPctOfPortfolio !== null && riskPctOfPortfolio > maxRiskPct;

  const disabled =
    submitting ||
    symbol.trim().length === 0 ||
    thesis.trim().length === 0 ||
    !validGeometry ||
    !entryDate;

  async function submit(confirmedOverride: boolean) {
    setSubmitting(true);
    setError(null);
    try {
      const body = {
        swing_idea_id: prefill?.swing_idea_id ?? null,
        symbol: symbol.trim().toUpperCase(),
        broker,
        setup_name: setupName.trim() || null,
        thesis: thesis.trim(),
        entry_date: entryDate,
        entry_price: entryPriceNum,
        shares: sharesNum,
        planned_stop: plannedStopNum,
        planned_target: plannedTargetNum,
        portfolio_value_at_entry: portfolioValueNum,
        atr_at_entry: marketData?.atr14 ?? null,
        adr_pct_at_entry: marketData?.adr_pct ?? null,
        conviction: conviction === "" ? null : conviction,
        market_regime: marketRegime.trim() || null,
        confirmed_override: confirmedOverride,
      };
      const res = await fetch("/api/swings/trades", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error ?? `HTTP ${res.status}`);
      }
      if (json.needs_confirmation) {
        setPendingConfirmation({
          risk_pct_of_portfolio: json.risk_pct_of_portfolio,
          max_risk_pct: json.max_risk_pct,
          initial_risk_dollars: json.initial_risk_dollars,
        });
        return;
      }
      setPendingConfirmation(null);
      // Persist the portfolio value the user entered so the next trade's
      // risk % starts pre-filled instead of blank. Best-effort — a failed
      // settings save shouldn't block a successfully logged trade.
      if (portfolioValueNum !== null) {
        fetch("/api/swings/journal-settings", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ portfolio_value: portfolioValueNum }),
        }).catch(() => {});
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
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Log swing trade — plan</DialogTitle>
        </DialogHeader>

        <div className="grid gap-3 py-2">
          <div className="grid grid-cols-3 gap-3">
            <label className="grid gap-1 text-sm">
              <span className="text-muted-foreground">Symbol *</span>
              <input
                type="text"
                value={symbol}
                onChange={(e) => setSymbol(e.target.value.toUpperCase())}
                onBlur={() => void loadPrefill(symbol)}
                className="rounded border border-border bg-background px-2 py-1.5 font-mono text-base uppercase"
                placeholder="AMD"
                autoFocus
              />
            </label>
            <label className="grid gap-1 text-sm">
              <span className="text-muted-foreground">Broker</span>
              <select
                value={broker}
                onChange={(e) =>
                  setBroker(e.target.value as "schwab" | "schwab2" | "robinhood" | "other")
                }
                className="rounded border border-border bg-background px-2 py-1.5 text-base"
              >
                <option value="schwab">Schwab</option>
                <option value="schwab2">Schwab 2</option>
                <option value="robinhood">Robinhood</option>
                <option value="other">Other</option>
              </select>
            </label>
            <label className="grid gap-1 text-sm">
              <span className="text-muted-foreground">Setup</span>
              <input
                type="text"
                value={setupName}
                onChange={(e) => setSetupName(e.target.value)}
                placeholder="e.g. pullback-to-trend"
                className="rounded border border-border bg-background px-2 py-1.5 text-base"
              />
            </label>
          </div>

          {(loadingPrefill || marketData) && (
            <div className="rounded border border-border/60 bg-background/40 px-3 py-2 text-xs text-muted-foreground">
              {loadingPrefill ? (
                "Loading market context…"
              ) : (
                <span className="flex flex-wrap gap-x-4 gap-y-1">
                  <span>Price {fmtMoney(marketData?.price ?? null)}</span>
                  <span>ATR14 {fmtMoney(marketData?.atr14 ?? null)}</span>
                  <span>ADR% {fmtPct(marketData?.adr_pct ?? null, 1)}</span>
                  <span>SMA20 {fmtMoney(marketData?.sma20 ?? null)}</span>
                  <span>SMA50 {fmtMoney(marketData?.sma50 ?? null)}</span>
                  <span>SMA200 {fmtMoney(marketData?.sma200 ?? null)}</span>
                </span>
              )}
            </div>
          )}

          <label className="grid gap-1 text-sm">
            <span className="text-muted-foreground">Thesis * — one sentence</span>
            <textarea
              value={thesis}
              onChange={(e) => setThesis(e.target.value)}
              rows={2}
              className="rounded border border-border bg-background px-2 py-1.5 text-base"
            />
          </label>

          <div className="grid grid-cols-3 gap-3">
            <label className="grid gap-1 text-sm">
              <span className="text-muted-foreground">Entry date *</span>
              <input
                type="date"
                value={entryDate}
                onChange={(e) => setEntryDate(e.target.value)}
                className="rounded border border-border bg-background px-2 py-1.5 text-base"
              />
            </label>
            <label className="grid gap-1 text-sm">
              <span className="text-muted-foreground">Entry price *</span>
              <input
                type="number"
                step="0.01"
                value={entryPrice}
                onChange={(e) => setEntryPrice(e.target.value)}
                className="rounded border border-border bg-background px-2 py-1.5 text-base"
              />
            </label>
            <label className="grid gap-1 text-sm">
              <span className="text-muted-foreground">Shares *</span>
              <input
                type="number"
                step="0.01"
                value={shares}
                onChange={(e) => setShares(e.target.value)}
                className="rounded border border-border bg-background px-2 py-1.5 text-base"
              />
            </label>
          </div>

          <div className="rounded-md border border-border/60 bg-background/40 p-3">
            <div className="mb-2 text-sm font-medium text-muted-foreground">
              Plan geometry
            </div>
            <div className="grid grid-cols-2 gap-3">
              <label className="grid gap-1 text-sm">
                <span className="text-muted-foreground">Planned stop * — required</span>
                <input
                  type="number"
                  step="0.01"
                  value={plannedStop}
                  onChange={(e) => setPlannedStop(e.target.value)}
                  className="rounded border border-border bg-background px-2 py-1.5 text-base"
                />
              </label>
              <label className="grid gap-1 text-sm">
                <span className="text-muted-foreground">Planned target — recommended</span>
                <input
                  type="number"
                  step="0.01"
                  value={plannedTarget}
                  onChange={(e) => setPlannedTarget(e.target.value)}
                  className="rounded border border-border bg-background px-2 py-1.5 text-base"
                />
              </label>
            </div>

            <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div className="text-xs">
                <div className="text-muted-foreground">Risk $</div>
                <div className="font-mono text-sm">{fmtMoney(initialRiskDollars)}</div>
              </div>
              <div className="text-xs">
                <div className="text-muted-foreground">Stop distance</div>
                <div className="font-mono text-sm">{fmtPct(stopDistancePct, 1)}</div>
              </div>
              <div className="text-xs">
                <div className="text-muted-foreground">R:R</div>
                <div className="font-mono text-sm">{rr !== null ? `${rr.toFixed(2)}:1` : "—"}</div>
              </div>
              <div className="text-xs">
                <div className="text-muted-foreground">Risk % of portfolio</div>
                <div className={`font-mono text-sm ${overLimit ? "text-amber-400" : ""}`}>
                  {fmtPct(riskPctOfPortfolio, 2)}
                </div>
              </div>
            </div>

            <label className="mt-3 grid max-w-[220px] gap-1 text-xs">
              <span className="text-muted-foreground">Portfolio value (for risk %)</span>
              <input
                type="number"
                step="1"
                value={portfolioValue}
                onChange={(e) => setPortfolioValue(e.target.value)}
                className="rounded border border-border bg-background px-2 py-1 text-sm"
              />
            </label>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <label className="grid gap-1 text-sm">
              <span className="text-muted-foreground">Conviction (1-5)</span>
              <select
                value={conviction}
                onChange={(e) => setConviction(e.target.value === "" ? "" : Number(e.target.value))}
                className="rounded border border-border bg-background px-2 py-1.5 text-base"
              >
                <option value="">—</option>
                {[1, 2, 3, 4, 5].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1 text-sm">
              <span className="text-muted-foreground">Market regime</span>
              <input
                type="text"
                value={marketRegime}
                onChange={(e) => setMarketRegime(e.target.value)}
                placeholder='e.g. "SPY above 8/21 EMA"'
                className="rounded border border-border bg-background px-2 py-1.5 text-base"
              />
            </label>
          </div>

          {pendingConfirmation && (
            <div className="rounded border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-200">
              This risks {fmtPct(pendingConfirmation.risk_pct_of_portfolio, 2)} of your portfolio
              (${pendingConfirmation.initial_risk_dollars.toFixed(0)}), above your{" "}
              {fmtPct(pendingConfirmation.max_risk_pct, 2)} limit.
              <div className="mt-2 flex gap-2">
                <Button size="sm" variant="outline" onClick={() => setPendingConfirmation(null)}>
                  Adjust size
                </Button>
                <Button
                  size="sm"
                  className="bg-amber-600 text-white hover:bg-amber-500"
                  onClick={() => void submit(true)}
                  disabled={submitting}
                >
                  Proceed anyway
                </Button>
              </div>
            </div>
          )}

          {error && (
            <div className="rounded border border-rose-500/40 bg-rose-500/10 p-2 text-sm text-rose-300">
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
          <Button onClick={() => void submit(false)} disabled={disabled || !!pendingConfirmation}>
            {submitting ? "Saving…" : "Log trade"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

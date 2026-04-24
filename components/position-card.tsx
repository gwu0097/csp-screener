"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  fmtDollars,
  fmtDollarsSigned,
  fmtPct,
  fmtPctSigned,
  fmtSignedDelta,
} from "@/lib/format";
import type { Urgency, Momentum, Fill } from "@/lib/positions";

export type PostEarningsRecView = {
  recommendation: "CLOSE" | "HOLD" | "PARTIAL" | "MONITOR";
  confidence: "HIGH" | "MEDIUM" | "LOW";
  reasoning: string;
  ruleFired: string;
  analysisDate: string;
  moveRatio: number | null;
  ivCrushed: boolean | null;
  ivCrushMagnitude: number | null;
  breachedTwoXem: boolean | null;
  analystSentiment: string | null;
  recoveryLikelihood: string | null;
  stockPctFromStrike: number | null;
};

// Server shape from /api/positions/open. Matches the rebuilt route.
export type OpenPositionClientView = {
  id: string;
  symbol: string;
  broker: string;
  strike: number;
  expiry: string;
  optionType: "put" | "call";
  totalContracts: number;
  remainingContracts: number;
  avgPremiumSold: number | null;
  openedDate: string;
  currentStockPrice: number | null;
  currentMark: number | null;
  currentBid: number | null;
  currentAsk: number | null;
  currentDelta: number | null;
  currentTheta: number | null;
  currentIv: number | null;
  dte: number;
  pnlDollars: number | null;
  pnlPct: number | null;
  distanceToStrikePct: number | null;
  thetaDecayTotal: number | null;
  momentum: Momentum | null;
  urgency: Urgency;
  recommendationReason: string;
  postEarningsRec: PostEarningsRecView | null;
  fills: Fill[];
};

function urgencyStyle(u: Urgency) {
  switch (u) {
    case "EMERGENCY_CUT":
      return "border-rose-500/50 bg-rose-500/20 text-rose-200";
    case "CUT":
      return "border-amber-500/50 bg-amber-500/15 text-amber-200";
    case "MONITOR":
      return "border-sky-500/40 bg-sky-500/10 text-sky-200";
    case "HOLD":
      return "border-emerald-500/40 bg-emerald-500/10 text-emerald-200";
  }
}

function momentumStyle(m: Momentum | null) {
  if (m === "BULLISH") return "text-emerald-300";
  if (m === "BEARISH") return "text-rose-300";
  if (m === "NEUTRAL") return "text-muted-foreground";
  return "text-muted-foreground";
}

// Tailwind classes for the post-earnings banner, keyed on
// (recommendation, confidence). recommendation picks the color family,
// confidence picks the border treatment (solid/outlined/dashed).
function postEarningsBannerStyle(r: PostEarningsRecView): string {
  const bg =
    r.recommendation === "CLOSE"
      ? "bg-rose-500/15 text-rose-200"
      : r.recommendation === "PARTIAL"
        ? "bg-amber-500/15 text-amber-200"
        : r.recommendation === "HOLD"
          ? "bg-emerald-500/15 text-emerald-200"
          : "bg-muted/40 text-muted-foreground";
  const borderColor =
    r.recommendation === "CLOSE"
      ? "border-rose-500/60"
      : r.recommendation === "PARTIAL"
        ? "border-amber-500/60"
        : r.recommendation === "HOLD"
          ? "border-emerald-500/60"
          : "border-border";
  const borderStyle =
    r.confidence === "HIGH" ? "border-2" : r.confidence === "MEDIUM" ? "border" : "border border-dashed";
  return `${bg} ${borderColor} ${borderStyle}`;
}

type Props = {
  position: OpenPositionClientView;
  onCloseSubmitted: (msg: string) => void;
};

export function PositionCard({ position: p, onCloseSubmitted }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [recExpanded, setRecExpanded] = useState(false);
  const [closeAllPrice, setCloseAllPrice] = useState<string>(
    p.currentMark !== null ? p.currentMark.toFixed(2) : "",
  );
  const [partialQty, setPartialQty] = useState<number>(
    Math.max(1, Math.floor(p.remainingContracts / 2)),
  );
  const [partialPrice, setPartialPrice] = useState<string>(
    p.currentMark !== null ? p.currentMark.toFixed(2) : "",
  );
  const [submitting, setSubmitting] = useState<"all" | "partial" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submitClose(qty: number, price: string) {
    const premium = Number(price);
    if (!Number.isFinite(premium) || premium < 0) {
      setError("Enter a valid price");
      return;
    }
    if (qty <= 0 || qty > p.remainingContracts) {
      setError(`Qty must be 1..${p.remainingContracts}`);
      return;
    }
    setError(null);
    setSubmitting(qty === p.remainingContracts ? "all" : "partial");
    try {
      const res = await fetch("/api/trades/bulk-create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          trades: [
            {
              symbol: p.symbol,
              action: "close",
              contracts: qty,
              strike: p.strike,
              expiry: p.expiry,
              optionType: p.optionType,
              premium,
              broker: p.broker,
            },
          ],
        }),
      });
      const json = (await res.json()) as {
        fills_inserted?: number;
        errors?: string[];
        error?: string;
      };
      if (!res.ok || json.error) throw new Error(json.error ?? `HTTP ${res.status}`);
      onCloseSubmitted(`Closed ${qty} ${p.symbol} @ ${fmtDollars(premium)}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Close failed");
    } finally {
      setSubmitting(null);
    }
  }

  const pnlColor =
    p.pnlDollars !== null && p.pnlDollars >= 0 ? "text-emerald-300" : "text-rose-300";

  return (
    <div className="rounded-lg border border-border bg-background/40 p-4">
      {p.postEarningsRec && (
        <PostEarningsBanner
          rec={p.postEarningsRec}
          expanded={recExpanded}
          onToggle={() => setRecExpanded((v) => !v)}
        />
      )}
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          className="flex items-center gap-2 text-left"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          <span className="text-lg font-semibold">{p.symbol}</span>
          <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
            {p.remainingContracts}/{p.totalContracts}×
          </span>
          <span className="text-sm">${p.strike} {p.optionType.toUpperCase()}</span>
          <span className="text-xs text-muted-foreground">· {p.expiry}</span>
          <span className="text-xs text-muted-foreground">· {p.broker}</span>
        </button>
        <div
          className={cn(
            "rounded-md border px-2 py-1 text-xs font-medium",
            urgencyStyle(p.urgency),
          )}
        >
          {p.urgency.replace("_", " ")}
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 font-mono text-xs md:grid-cols-4">
        <Cell k="Avg sold" v={fmtDollars(p.avgPremiumSold)} />
        <Cell k="Current" v={fmtDollars(p.currentMark)} />
        <Cell
          k="P&L"
          v={
            <span className={pnlColor}>
              {fmtDollarsSigned(p.pnlDollars)} ({fmtPctSigned(p.pnlPct)})
            </span>
          }
        />
        <Cell k="DTE" v={String(p.dte)} />
        <Cell k="Stock" v={fmtDollars(p.currentStockPrice)} />
        <Cell
          k="Distance"
          v={
            p.distanceToStrikePct !== null
              ? `${fmtPct(p.distanceToStrikePct)} OTM`
              : "—"
          }
        />
        <Cell k="Δ now" v={fmtSignedDelta(p.currentDelta)} />
        <Cell
          k="Theta left"
          v={
            p.thetaDecayTotal !== null
              ? fmtDollars(p.thetaDecayTotal)
              : "—"
          }
        />
      </div>

      <div className="mt-3 text-xs text-muted-foreground">{p.recommendationReason}</div>

      <div className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 text-xs">
        <Cell k="Opened" v={p.openedDate} />
        <Cell
          k="Momentum"
          v={<span className={momentumStyle(p.momentum)}>{p.momentum ?? "—"}</span>}
        />
      </div>

      <div className="mt-3 flex flex-col gap-2 md:flex-row md:items-center">
        <div className="flex items-center gap-2">
          <label className="text-xs text-muted-foreground">
            Close all {p.remainingContracts} @
          </label>
          <input
            type="number"
            step="0.01"
            value={closeAllPrice}
            onChange={(e) => setCloseAllPrice(e.target.value)}
            className="w-20 rounded border border-border bg-background px-2 py-1 text-xs"
          />
          <Button
            size="sm"
            onClick={() => submitClose(p.remainingContracts, closeAllPrice)}
            disabled={submitting !== null}
          >
            {submitting === "all" ? <Loader2 className="h-3 w-3 animate-spin" /> : "Close all"}
          </Button>
        </div>
        {p.remainingContracts > 1 && (
          <div className="flex items-center gap-2">
            <label className="text-xs text-muted-foreground">Partial</label>
            <input
              type="number"
              min="1"
              max={p.remainingContracts}
              value={partialQty}
              onChange={(e) =>
                setPartialQty(
                  Math.min(
                    p.remainingContracts,
                    Math.max(1, Number(e.target.value) || 1),
                  ),
                )
              }
              className="w-14 rounded border border-border bg-background px-2 py-1 text-xs"
            />
            <span className="text-xs text-muted-foreground">@</span>
            <input
              type="number"
              step="0.01"
              value={partialPrice}
              onChange={(e) => setPartialPrice(e.target.value)}
              className="w-20 rounded border border-border bg-background px-2 py-1 text-xs"
            />
            <Button
              size="sm"
              variant="secondary"
              onClick={() => submitClose(partialQty, partialPrice)}
              disabled={submitting !== null}
            >
              {submitting === "partial" ? <Loader2 className="h-3 w-3 animate-spin" /> : "Close"}
            </Button>
          </div>
        )}
      </div>

      {error && (
        <div className="mt-2 rounded border border-rose-500/40 bg-rose-500/10 px-2 py-1 text-xs text-rose-200">
          {error}
        </div>
      )}

      {expanded && (
        <div className="mt-4 rounded border border-border bg-muted/20 p-3 text-xs">
          <div className="mb-2 font-medium">Fills history</div>
          <div className="space-y-1">
            {p.fills.length === 0 && (
              <div className="text-muted-foreground">No fills recorded</div>
            )}
            {p.fills.map((f, idx) => (
              <div key={idx} className="flex items-center justify-between gap-2">
                <span>
                  <span className="text-muted-foreground">{f.fill_date}:</span>{" "}
                  <span
                    className={
                      f.fill_type === "open" ? "text-rose-300" : "text-emerald-300"
                    }
                  >
                    {f.fill_type === "open" ? "SELL to open" : "BUY to close"}
                  </span>{" "}
                  {f.contracts}× @ {fmtDollars(f.premium)}
                </span>
                <span className="font-mono text-muted-foreground">
                  {fmtDollars(f.premium * f.contracts * 100)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Cell({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-muted-foreground">{k}</span>
      <span className="text-foreground">{v}</span>
    </div>
  );
}

function PostEarningsBanner({
  rec,
  expanded,
  onToggle,
}: {
  rec: PostEarningsRecView;
  expanded: boolean;
  onToggle: () => void;
}) {
  const confidenceBadge =
    rec.confidence === "HIGH"
      ? "bg-foreground/20 border-foreground/40"
      : rec.confidence === "MEDIUM"
        ? "border-foreground/40"
        : "border-dashed border-foreground/40";
  const ivCrushedLabel = rec.ivCrushed === null ? "—" : rec.ivCrushed ? "YES" : "NO";
  const moveRatioLabel = rec.moveRatio !== null ? rec.moveRatio.toFixed(2) : "—";
  return (
    <button
      type="button"
      onClick={onToggle}
      className={cn(
        "mb-3 w-full rounded-md px-3 py-2 text-left text-xs",
        postEarningsBannerStyle(rec),
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 font-medium">
          <span>📊 Post-earnings: {rec.recommendation}</span>
          <span className={cn("rounded border px-1.5 py-0.5 text-[10px] font-semibold", confidenceBadge)}>
            {rec.confidence}
          </span>
        </div>
        <span className="text-[10px] opacity-70">
          {expanded ? "click to collapse ▲" : "click to expand ▼"}
        </span>
      </div>
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 opacity-90">
        <span>Move ratio: {moveRatioLabel}</span>
        <span>·</span>
        <span>IV crushed: {ivCrushedLabel}</span>
        {rec.analystSentiment && (
          <>
            <span>·</span>
            <span>Sentiment: {rec.analystSentiment}</span>
          </>
        )}
      </div>
      {expanded && (
        <div className="mt-3 space-y-2 border-t border-foreground/10 pt-2">
          <div>{rec.reasoning}</div>
          <div className="flex flex-wrap gap-3 text-[11px] opacity-80">
            <span>
              Rule: <span className="font-mono">{rec.ruleFired}</span>
            </span>
            {rec.breachedTwoXem !== null && (
              <span>Breached 2×EM: {rec.breachedTwoXem ? "yes" : "no"}</span>
            )}
            {rec.ivCrushMagnitude !== null && (
              <span>IV crush: {(rec.ivCrushMagnitude * 100).toFixed(1)}%</span>
            )}
            {rec.recoveryLikelihood && <span>Recovery: {rec.recoveryLikelihood}</span>}
            {rec.stockPctFromStrike !== null && (
              <span>
                From strike: {(rec.stockPctFromStrike * 100).toFixed(2)}%{" "}
                {rec.stockPctFromStrike < 0 ? "(ITM)" : "(OTM)"}
              </span>
            )}
            <span>Analyzed: {new Date(rec.analysisDate).toLocaleString()}</span>
          </div>
        </div>
      )}
    </button>
  );
}

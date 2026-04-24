"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight, ExternalLink, Loader2 } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
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

// Union shape consumed by the row — either status="open" with live data
// from /api/positions/open or status="closed" from /api/positions/closed.
// The row renderer branches on status; the expanded detail skips the
// live-data column for closed rows.
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
  expiryStatus: "active" | "needs_verification" | "pending";
  expiryPctFromStrike: number | null;
  expiryLastStockPrice: number | null;
  entryFinalGrade: string | null;
  entryCrushGrade: string | null;
  entryOpportunityGrade: string | null;
  entryIndustryGrade: string | null;
  entryRegimeGrade: string | null;
  entryIvEdge: number | null;
  entryEmPct: number | null;
  entryVix: number | null;
  entryStockPrice: number | null;
};

export type ClosedPositionClientView = {
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
  closedDate: string | null;
  realizedPnl: number | null;
  // One of 'closed' | 'expired_worthless' | 'assigned'. Drives the
  // status-badge label on the row (WIN/LOSS for 'closed', EXPIRED for
  // 'expired_worthless', ASSIGNED for 'assigned').
  status: "closed" | "expired_worthless" | "assigned";
  entryFinalGrade: string | null;
  entryCrushGrade: string | null;
  entryOpportunityGrade: string | null;
  entryIndustryGrade: string | null;
  entryRegimeGrade: string | null;
  entryIvEdge: number | null;
  entryEmPct: number | null;
  entryVix: number | null;
  entryStockPrice: number | null;
  fills: Fill[];
  postEarningsRec: PostEarningsRecView | null;
};

type Props =
  | { kind: "open"; position: OpenPositionClientView; onCloseSubmitted: (msg: string) => void }
  | { kind: "closed"; position: ClosedPositionClientView };

// Grid template shared between the collapsed row and the column-header
// row in positions-view. Keeping both on the same template guarantees
// the header labels sit directly above their data. If you add/remove a
// column here, update PositionsTableHeader too.
//
// Desktop columns (sm+):
//   1. 16px                  post-earnings dot indicator
//   2. minmax(60px, 80px)    symbol — clamped so it doesn't hog extra
//                            row width; that space goes to status
//                            instead (prevents a gap between Symbol
//                            and Strike when viewport is wide)
//   3. 70px                  strike (e.g. "$312.5P")
//   4. 60px                  expiry ("Apr 24")
//   5. 40px                  qty ("×4")
//   6. 70px                  P&L ("-$42")
//   7. 50px                  POP% ("91%")
//   8. 36px                  grade badge ("A")
//   9. 1fr                   status — absorbs extra row width; the
//                            badge inside uses justify-self-end so
//                            it sits flush to the right edge
//  10. 16px                  expand chevron
export const COLLAPSED_ROW_GRID =
  "grid w-full grid-cols-[16px_1fr_auto_auto_auto_auto_auto_auto_auto] items-center gap-2 px-3 text-sm sm:grid-cols-[16px_minmax(60px,80px)_70px_60px_40px_70px_50px_36px_1fr_16px]";

// ---------- small helpers ----------

function shortExpiry(iso: string): string {
  const d = new Date(iso + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

function popColor(pop: number | null): string {
  if (pop === null) return "text-muted-foreground";
  if (pop >= 0.85) return "text-emerald-300";
  if (pop >= 0.75) return "text-amber-300";
  return "text-rose-300";
}

function gradeColor(g: string | null | undefined): string {
  if (g === "A") return "bg-emerald-500/20 text-emerald-300 border-emerald-500/40";
  if (g === "B") return "bg-sky-500/20 text-sky-300 border-sky-500/40";
  if (g === "C") return "bg-amber-500/20 text-amber-300 border-amber-500/40";
  if (g === "F") return "bg-rose-500/20 text-rose-300 border-rose-500/40";
  return "bg-muted/40 text-muted-foreground border-border";
}

// Row tint per the spec: subtle color wash by urgency / close outcome so
// a glance down the list groups by risk.
function rowTintOpen(u: Urgency): string {
  if (u === "EMERGENCY_CUT" || u === "CUT") return "bg-rose-500/[0.06]";
  if (u === "MONITOR") return "bg-amber-500/[0.06]";
  if (u === "HOLD") return "";
  return "";
}
function rowTintClosed(pnl: number | null): string {
  if (pnl === null) return "";
  return pnl >= 0 ? "bg-emerald-500/[0.05]" : "bg-rose-500/[0.05]";
}

function statusBadgeOpen(u: Urgency): { label: string; className: string } {
  switch (u) {
    case "EMERGENCY_CUT":
      return { label: "EMERGENCY CUT", className: "border-rose-500/50 bg-rose-500/20 text-rose-200" };
    case "CUT":
      return { label: "CUT", className: "border-amber-500/50 bg-amber-500/15 text-amber-200" };
    case "MONITOR":
      return { label: "MONITOR", className: "border-sky-500/40 bg-sky-500/10 text-sky-200" };
    case "HOLD":
      return { label: "HOLD", className: "border-emerald-500/40 bg-emerald-500/10 text-emerald-200" };
  }
}
function statusBadgeClosed(
  status: "closed" | "expired_worthless" | "assigned",
  pnl: number | null,
): { label: string; className: string } {
  if (status === "expired_worthless") {
    return {
      label: "EXPIRED",
      className: "border-emerald-500/40 bg-emerald-500/15 text-emerald-200",
    };
  }
  if (status === "assigned") {
    return {
      label: "ASSIGNED",
      className: "border-amber-500/50 bg-amber-500/15 text-amber-200",
    };
  }
  if (pnl === null || pnl === 0) return { label: "—", className: "border-border text-muted-foreground" };
  return pnl > 0
    ? { label: "WIN", className: "border-emerald-500/40 bg-emerald-500/15 text-emerald-200" }
    : { label: "LOSS", className: "border-rose-500/40 bg-rose-500/15 text-rose-200" };
}

// Warning badge shown on expired-but-open rows where the classifier
// couldn't auto-close (too close to strike, or no snapshot data).
// Replaces the normal urgency badge so the user sees the "decide" state
// at a glance.
function statusBadgeExpiryWarning(
  expiryStatus: "needs_verification" | "pending",
): { label: string; className: string } {
  return {
    label: expiryStatus === "needs_verification" ? "⚠ VERIFY ASSIGNMENT" : "⚠ PENDING",
    className: "border-amber-500/60 bg-amber-500/20 text-amber-100",
  };
}

// Post-earnings indicator — a tiny colored dot whose hover tooltip
// carries the full rec. Color follows the same recommendation→color
// mapping as the old full banner.
function recDotColor(r: PostEarningsRecView): string {
  switch (r.recommendation) {
    case "CLOSE":
      return "bg-rose-400";
    case "PARTIAL":
      return "bg-amber-400";
    case "HOLD":
      return "bg-emerald-400";
    default:
      return "bg-muted-foreground/50";
  }
}

// ---------- compact row + expansion ----------

export function PositionCard(props: Props) {
  const [expanded, setExpanded] = useState(false);
  // Narrow the union up front so the rest of the render doesn't need a
  // guard on every field access.
  const open = props.kind === "open" ? props.position : null;
  const closed = props.kind === "closed" ? props.position : null;
  const p = props.position;
  const pop = open && open.currentDelta !== null ? 1 - Math.abs(open.currentDelta) : null;
  // Expired-open positions surface an amber warning badge in the row,
  // overriding the urgency badge. Closed positions pick EXPIRED /
  // ASSIGNED / WIN / LOSS based on the stored status + realized P&L.
  const openExpiryWarning =
    open && open.expiryStatus !== "active"
      ? statusBadgeExpiryWarning(open.expiryStatus)
      : null;
  const rowTint = open
    ? openExpiryWarning
      ? "bg-amber-500/[0.08]"
      : rowTintOpen(open.urgency)
    : rowTintClosed(closed?.realizedPnl ?? null);
  const status = openExpiryWarning
    ? openExpiryWarning
    : open
      ? statusBadgeOpen(open.urgency)
      : statusBadgeClosed(closed?.status ?? "closed", closed?.realizedPnl ?? null);
  const pnlDollars = open ? open.pnlDollars : (closed?.realizedPnl ?? null);
  const pnlPct = open ? open.pnlPct : null;
  const pnlColor =
    pnlDollars === null
      ? "text-muted-foreground"
      : pnlDollars >= 0
        ? "text-emerald-300"
        : "text-rose-300";

  return (
    <div
      className={cn(
        "rounded-md border border-border transition-colors",
        rowTint,
        expanded && "border-foreground/20",
      )}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className={cn(COLLAPSED_ROW_GRID, "py-2")}
      >
        {/* Post-earnings dot */}
        <div className="flex h-4 w-4 items-center justify-center">
          {p.postEarningsRec ? <RecDot rec={p.postEarningsRec} /> : null}
        </div>
        {/* Symbol */}
        <div className="truncate text-left font-semibold">{p.symbol}</div>
        {/* Strike */}
        <div className="text-left font-mono text-xs text-muted-foreground">
          ${p.strike}
          {p.optionType === "put" ? "P" : "C"}
        </div>
        {/* Expiry */}
        <div className="text-left text-xs text-muted-foreground">{shortExpiry(p.expiry)}</div>
        {/* Contracts */}
        <div className="text-right text-xs text-muted-foreground">×{p.remainingContracts}</div>
        {/* P&L */}
        <div className={cn("text-right font-mono text-xs", pnlColor)}>
          {fmtDollarsSigned(pnlDollars)}
        </div>
        {/* POP% — hidden on mobile */}
        <div className={cn("hidden text-right text-xs sm:block", popColor(pop))}>
          {pop !== null ? `${Math.round(pop * 100)}%` : "—"}
        </div>
        {/* Grade — hidden on mobile */}
        <div className="hidden sm:block">
          {p.entryFinalGrade ? (
            <span
              className={cn(
                "inline-block rounded border px-1.5 py-0.5 text-[10px] font-semibold",
                gradeColor(p.entryFinalGrade),
              )}
            >
              {p.entryFinalGrade}
            </span>
          ) : (
            <span className="text-xs text-muted-foreground">—</span>
          )}
        </div>
        {/* Status */}
        <div
          className={cn(
            "justify-self-end rounded border px-2 py-0.5 text-[10px] font-semibold whitespace-nowrap",
            status.className,
          )}
        >
          {status.label}
        </div>
        {/* Chevron */}
        <div className="hidden justify-self-end sm:block">
          {expanded ? (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          )}
        </div>
      </button>

      {/* Expanded detail — slides open below */}
      <div
        className={cn(
          "overflow-hidden transition-[max-height] duration-200 ease-out",
          expanded ? "max-h-[2400px]" : "max-h-0",
        )}
      >
        <div className="border-t border-border p-3">
          <div className="grid gap-4 md:grid-cols-2">
            <PositionDetailsColumn p={p} kind={props.kind} pnlPct={pnlPct} />
            {open ? <LiveDataColumn p={open} /> : <div />}
          </div>

          {props.kind === "open" && props.position.expiryStatus !== "active" && (
            <div className="mt-4">
              <VerifyAssignmentPanel
                position={props.position}
                onResolved={props.onCloseSubmitted}
              />
            </div>
          )}

          {p.postEarningsRec && (
            <div className="mt-4">
              <PostEarningsPanel rec={p.postEarningsRec} />
            </div>
          )}

          <div className="mt-4 flex flex-wrap items-center gap-2">
            {props.kind === "open" && (
              <ClosePositionInline
                position={props.position}
                onCloseSubmitted={props.onCloseSubmitted}
              />
            )}
            <Link
              href={`/encyclopedia?symbol=${encodeURIComponent(p.symbol)}`}
              className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
            >
              <ExternalLink className="h-3 w-3" />
              View in Encyclopedia
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------- subcomponents ----------

function RecDot({ rec }: { rec: PostEarningsRecView }) {
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={cn("block h-2.5 w-2.5 rounded-full", recDotColor(rec))}
            aria-label={`Post-earnings: ${rec.recommendation}`}
          />
        </TooltipTrigger>
        <TooltipContent className="max-w-xs text-xs">
          <div className="font-semibold">
            {rec.recommendation} ({rec.confidence})
          </div>
          <div className="mt-1 text-muted-foreground">{rec.reasoning}</div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-2 text-xs">
      <span className="text-muted-foreground">{k}</span>
      <span className="text-foreground">{v}</span>
    </div>
  );
}

function PositionDetailsColumn({
  p,
  kind,
  pnlPct,
}: {
  p: OpenPositionClientView | ClosedPositionClientView;
  kind: "open" | "closed";
  pnlPct: number | null;
}) {
  const entryGrades = [
    p.entryCrushGrade && `Crush ${p.entryCrushGrade}`,
    p.entryOpportunityGrade && `Opp ${p.entryOpportunityGrade}`,
    p.entryIndustryGrade && `Industry ${p.entryIndustryGrade}`,
    p.entryRegimeGrade && `Regime ${p.entryRegimeGrade}`,
    p.entryFinalGrade && `Final ${p.entryFinalGrade}`,
  ].filter(Boolean) as string[];
  return (
    <div className="space-y-1 rounded border border-border bg-background/40 p-3">
      <div className="mb-1 text-xs font-semibold uppercase text-muted-foreground">
        Position
      </div>
      <Row k="Avg premium sold" v={fmtDollars(p.avgPremiumSold)} />
      <Row k="Opened" v={p.openedDate} />
      {kind === "closed" && (p as ClosedPositionClientView).closedDate && (
        <Row k="Closed" v={(p as ClosedPositionClientView).closedDate ?? "—"} />
      )}
      {kind === "closed" && (
        <Row
          k="Realized P&L"
          v={
            <span
              className={
                (p as ClosedPositionClientView).realizedPnl === null
                  ? "text-muted-foreground"
                  : ((p as ClosedPositionClientView).realizedPnl ?? 0) >= 0
                    ? "text-emerald-300"
                    : "text-rose-300"
              }
            >
              {fmtDollarsSigned((p as ClosedPositionClientView).realizedPnl)}
            </span>
          }
        />
      )}
      {kind === "open" && pnlPct !== null && (
        <Row k="Unrealized %" v={fmtPctSigned(pnlPct)} />
      )}
      <Row k="Entry stock price" v={fmtDollars(p.entryStockPrice)} />
      <Row
        k="Entry IV edge"
        v={p.entryIvEdge !== null ? `${p.entryIvEdge.toFixed(2)}x` : "—"}
      />
      <Row
        k="Entry EM%"
        v={p.entryEmPct !== null ? `${(p.entryEmPct * 100).toFixed(1)}%` : "—"}
      />
      <Row
        k="Entry VIX"
        v={p.entryVix !== null ? p.entryVix.toFixed(1) : "—"}
      />
      {entryGrades.length > 0 && (
        <div className="pt-1 text-xs text-muted-foreground">
          <span className="text-muted-foreground">Entry grades:</span>{" "}
          <span className="text-foreground">{entryGrades.join(" · ")}</span>
        </div>
      )}
    </div>
  );
}

function LiveDataColumn({ p }: { p: OpenPositionClientView }) {
  return (
    <div className="space-y-1 rounded border border-border bg-background/40 p-3">
      <div className="mb-1 text-xs font-semibold uppercase text-muted-foreground">
        Live
      </div>
      <Row k="Current stock" v={fmtDollars(p.currentStockPrice)} />
      <Row k="Current option" v={fmtDollars(p.currentMark)} />
      <Row
        k="Current IV"
        v={p.currentIv !== null ? `${(p.currentIv * 100).toFixed(1)}%` : "—"}
      />
      <Row k="Current delta" v={fmtSignedDelta(p.currentDelta)} />
      <Row
        k="Current theta"
        v={p.currentTheta !== null ? p.currentTheta.toFixed(4) : "—"}
      />
      <Row
        k="Distance to strike"
        v={
          p.distanceToStrikePct !== null
            ? `${fmtPct(p.distanceToStrikePct)} OTM`
            : "—"
        }
      />
      <Row k="DTE" v={String(p.dte)} />
    </div>
  );
}

function PostEarningsPanel({ rec }: { rec: PostEarningsRecView }) {
  const color =
    rec.recommendation === "CLOSE"
      ? "border-rose-500/40 bg-rose-500/10 text-rose-200"
      : rec.recommendation === "PARTIAL"
        ? "border-amber-500/40 bg-amber-500/10 text-amber-200"
        : rec.recommendation === "HOLD"
          ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200"
          : "border-border bg-muted/20 text-muted-foreground";
  return (
    <div className={cn("rounded border px-3 py-2 text-xs", color)}>
      <div className="flex items-center gap-2 font-semibold">
        📊 Post-earnings: {rec.recommendation}
        <span className="rounded border border-current/40 px-1.5 py-0.5 text-[10px]">
          {rec.confidence}
        </span>
      </div>
      <div className="mt-1 opacity-90">{rec.reasoning}</div>
      <div className="mt-2 flex flex-wrap gap-3 text-[11px] opacity-80">
        <span>
          Rule: <span className="font-mono">{rec.ruleFired}</span>
        </span>
        {rec.moveRatio !== null && <span>Move ratio: {rec.moveRatio.toFixed(2)}</span>}
        {rec.ivCrushed !== null && <span>IV crushed: {rec.ivCrushed ? "YES" : "NO"}</span>}
        {rec.analystSentiment && <span>Sentiment: {rec.analystSentiment}</span>}
        {rec.recoveryLikelihood && <span>Recovery: {rec.recoveryLikelihood}</span>}
      </div>
    </div>
  );
}

// Shown in the expanded row of an expired-but-open position. Lets the
// user confirm the outcome: expired worthless OR assigned at some
// price. Both branches POST to /api/positions/{expire-manual,assign}
// and reload the list.
function VerifyAssignmentPanel({
  position,
  onResolved,
}: {
  position: OpenPositionClientView;
  onResolved: (msg: string) => void;
}) {
  const [assignMode, setAssignMode] = useState(false);
  const [assignPrice, setAssignPrice] = useState<string>(
    position.expiryLastStockPrice !== null ? position.expiryLastStockPrice.toFixed(2) : "",
  );
  const [submitting, setSubmitting] = useState<"worthless" | "assigned" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const pctStr =
    position.expiryPctFromStrike !== null
      ? `${(position.expiryPctFromStrike * 100).toFixed(2)}%`
      : "unknown";
  const stockStr =
    position.expiryLastStockPrice !== null
      ? `$${position.expiryLastStockPrice.toFixed(2)}`
      : "unknown";

  async function confirmWorthless() {
    setSubmitting("worthless");
    setError(null);
    try {
      const res = await fetch("/api/positions/expire-manual", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ positionId: position.id }),
      });
      const json = (await res.json()) as { ok?: boolean; realized_pnl?: number; error?: string };
      if (!res.ok || json.error) throw new Error(json.error ?? `HTTP ${res.status}`);
      onResolved(`${position.symbol} expired worthless: +$${json.realized_pnl?.toFixed(2)}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setSubmitting(null);
    }
  }

  async function confirmAssigned() {
    const price = Number(assignPrice);
    if (!Number.isFinite(price) || price <= 0) {
      setError("Enter a valid stock price");
      return;
    }
    setSubmitting("assigned");
    setError(null);
    try {
      const res = await fetch("/api/positions/assign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ positionId: position.id, stockPriceAtExpiry: price }),
      });
      const json = (await res.json()) as { ok?: boolean; realized_pnl?: number; error?: string };
      if (!res.ok || json.error) throw new Error(json.error ?? `HTTP ${res.status}`);
      const pnl = json.realized_pnl ?? 0;
      const sign = pnl >= 0 ? "+" : "";
      onResolved(
        `${position.symbol} assigned at $${price.toFixed(2)}: ${sign}$${pnl.toFixed(2)}`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setSubmitting(null);
    }
  }

  return (
    <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs">
      <div className="mb-2 font-semibold text-amber-200">
        ⚠ Expired — verify outcome
      </div>
      <div className="mb-3 text-amber-100/80">
        {position.expiryStatus === "pending"
          ? "No snapshot data available to auto-classify. Confirm the actual outcome."
          : `Stock was ${pctStr} from strike at last snapshot (${stockStr}). Assignment possible — confirm the outcome below.`}
      </div>
      {!assignMode ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            onClick={confirmWorthless}
            disabled={submitting !== null}
            className="bg-emerald-500/80 hover:bg-emerald-500"
          >
            {submitting === "worthless" ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              "Expire Worthless"
            )}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setAssignMode(true)}
            disabled={submitting !== null}
          >
            Record Assignment
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-amber-100/80">Stock price at expiry:</label>
          <span className="text-foreground">$</span>
          <input
            type="number"
            step="0.01"
            value={assignPrice}
            onChange={(e) => setAssignPrice(e.target.value)}
            className="w-20 rounded border border-border bg-background px-2 py-1"
          />
          <Button size="sm" onClick={confirmAssigned} disabled={submitting !== null}>
            {submitting === "assigned" ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              "Confirm Assignment"
            )}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setAssignMode(false)}
            disabled={submitting !== null}
          >
            Cancel
          </Button>
        </div>
      )}
      {error && (
        <div className="mt-2 rounded border border-rose-500/40 bg-rose-500/10 px-2 py-1 text-rose-200">
          {error}
        </div>
      )}
    </div>
  );
}

function ClosePositionInline({
  position: p,
  onCloseSubmitted,
}: {
  position: OpenPositionClientView;
  onCloseSubmitted: (msg: string) => void;
}) {
  const [closeAllPrice, setCloseAllPrice] = useState<string>(
    p.currentMark !== null ? p.currentMark.toFixed(2) : "",
  );
  const [partialQty, setPartialQty] = useState<number>(1);
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
      const json = (await res.json()) as { error?: string };
      if (!res.ok || json.error) throw new Error(json.error ?? `HTTP ${res.status}`);
      onCloseSubmitted(`Closed ${qty} ${p.symbol} @ ${fmtDollars(premium)}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Close failed");
    } finally {
      setSubmitting(null);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex items-center gap-2">
        <label className="text-xs text-muted-foreground">
          Close {p.remainingContracts} @
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
                Math.min(p.remainingContracts, Math.max(1, Number(e.target.value) || 1)),
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
      {error && (
        <span className="rounded border border-rose-500/40 bg-rose-500/10 px-2 py-0.5 text-xs text-rose-200">
          {error}
        </span>
      )}
    </div>
  );
}

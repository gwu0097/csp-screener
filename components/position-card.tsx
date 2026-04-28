"use client";

import { useState } from "react";
import { ChevronRight, ExternalLink, ListChecks, Loader2, Plus, Trash2, X } from "lucide-react";
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
  // Priority-cascade status badge (replaces the urgency-derived badge
  // for the collapsed-row status column). See lib/positions.ts
  // computePositionBadge for the rule cascade.
  badge: string;
  badgeLabel: string;
  badgeColor: "green" | "amber" | "red";
  badgeTooltip: string;
  ruleFired: string;
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
  | {
      kind: "open";
      position: OpenPositionClientView;
      onCloseSubmitted: (msg: string) => void;
      // Optimistic-removal hook: parent splices the id out of its
      // local positions array on a successful DELETE so the row
      // disappears instantly without a full /api/positions/open
      // round-trip. Optional so closed-list usage can ignore it.
      onPositionRemoved?: (id: string) => void;
    }
  | { kind: "closed"; position: ClosedPositionClientView };

// Grid template shared between the collapsed row and the column-header
// row in positions-view. Keeping both on the same template guarantees
// header labels sit directly above their data. If you add/remove a
// column here, update PositionsTableHeader + the data-row cells too.
//
// Every column except the dot is fractional (fr) with a min floor via
// minmax() — resize the browser and columns scale proportionally
// instead of leaving a fixed-width row in the middle of a wider page.
//
// Desktop (sm+, 13 cols, left → right):
//   1.  24px               post-earnings dot indicator (only fixed col)
//   2.  minmax(40px, 1fr)     SYMBOL
//   3.  minmax(60px, 1.2fr)   STRIKE
//   4.  minmax(50px, 1fr)     EXPIRY         — hidden on mobile
//   5.  minmax(30px, 0.6fr)   QTY
//   6.  minmax(60px, 1.2fr)   STOCK
//   7.  minmax(60px, 1.2fr)   P&L
//   8.  minmax(40px, 0.8fr)   POP
//   9.  minmax(60px, 1fr)     % OTM          — hidden on mobile
//  10.  minmax(40px, 0.8fr)   IV             — hidden on mobile
//  11.  minmax(40px, 0.8fr)   θ (theta)      — hidden on mobile
//  12.  minmax(30px, 0.6fr)   GRADE
//  13.  minmax(80px, 1.5fr)   STATUS
//
// Mobile (< sm, 9 cols): drops EXPIRY / % OTM / IV / θ. Those four
// cells use `hidden sm:block` so they're pulled out of the grid flow
// on mobile, leaving only the 9 visible cells which fit the mobile
// template precisely.
export const COLLAPSED_ROW_GRID =
  "grid w-full grid-cols-[24px_1fr_1.2fr_0.6fr_1.2fr_1.2fr_0.8fr_0.6fr_1.5fr] items-center gap-2 px-3 text-sm sm:grid-cols-[24px_minmax(40px,1fr)_minmax(60px,1.2fr)_minmax(50px,1fr)_minmax(30px,0.6fr)_minmax(60px,1.2fr)_minmax(60px,1.2fr)_minmax(40px,0.8fr)_minmax(60px,1fr)_minmax(40px,0.8fr)_minmax(40px,0.8fr)_minmax(30px,0.6fr)_minmax(80px,1.5fr)]";

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

// Badge tint classes — wraps the new computePositionBadge output for
// both the status pill and the row background tint. Spec:
//   green  → bg-emerald-900/40 text-emerald-400 border-emerald-700
//   amber  → bg-amber-900/40   text-amber-400   border-amber-700
//   red    → bg-red-900/40     text-red-400     border-red-700
function badgePillClass(color: "green" | "amber" | "red"): string {
  if (color === "red") return "bg-red-900/40 text-red-400 border-red-700";
  if (color === "amber") return "bg-amber-900/40 text-amber-400 border-amber-700";
  return "bg-emerald-900/40 text-emerald-400 border-emerald-700";
}
// Row background tint driven by badge type:
//   EMERGENCY_CUT / CLOSE → red wash
//   PIN_RISK / MONITOR    → amber wash
//   EXPIRING / MAX_PROFIT / HOLD → default dark (no wash)
function rowTintFromBadge(badge: string): string {
  if (badge === "EMERGENCY_CUT" || badge === "CLOSE") return "bg-red-950/20";
  if (badge === "PIN_RISK" || badge === "MONITOR") return "bg-amber-950/20";
  return "";
}
function rowTintClosed(pnl: number | null): string {
  if (pnl === null) return "";
  return pnl >= 0 ? "bg-emerald-500/[0.05]" : "bg-rose-500/[0.05]";
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
  // Inline-remove state. Trash icon in the collapsed-row's status cell
  // toggles `removeOpen`; the confirmation strip renders directly
  // below the row, still inside the card border, so the user keeps
  // visual context of what they're about to delete.
  const [removeOpen, setRemoveOpen] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  // Edit-fills panel toggle. Open positions only — closed positions
  // intentionally don't expose this surface (no `onCloseSubmitted` to
  // refresh the parent list, and edits should ideally happen before
  // a position is closed out anyway).
  const [editsOpen, setEditsOpen] = useState(false);

  const onRemoveClick = (e: React.MouseEvent | React.KeyboardEvent) => {
    e.stopPropagation();
    setRemoveOpen(true);
    setRemoveError(null);
  };
  const cancelRemove = (e: React.MouseEvent) => {
    e.stopPropagation();
    setRemoveOpen(false);
    setRemoveError(null);
  };
  const confirmRemove = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (removing) return;
    setRemoving(true);
    setRemoveError(null);
    try {
      const res = await fetch(
        `/api/positions/${encodeURIComponent(props.position.id)}`,
        { method: "DELETE" },
      );
      const json = (await res.json()) as { success?: boolean; error?: string };
      if (!res.ok || !json.success) {
        throw new Error(json.error ?? `HTTP ${res.status}`);
      }
      // Optimistic-removal: parent splices its positions array. We
      // don't reset removeOpen / removing here — the row is about to
      // unmount once the parent re-renders.
      if (props.kind === "open" && props.onPositionRemoved) {
        props.onPositionRemoved(props.position.id);
      }
    } catch (err) {
      setRemoveError(err instanceof Error ? err.message : "Delete failed");
      setRemoving(false);
    }
  };
  // Narrow the union up front so the rest of the render doesn't need a
  // guard on every field access.
  const open = props.kind === "open" ? props.position : null;
  const closed = props.kind === "closed" ? props.position : null;
  const p = props.position;
  const pop = open && open.currentDelta !== null ? 1 - Math.abs(open.currentDelta) : null;
  // Open rows use the priority-cascade badge from computePositionBadge
  // (served by the API as badge* fields). Closed rows keep the
  // EXPIRED / ASSIGNED / WIN / LOSS derivation — the badge engine is
  // open-position-specific (expiry day, live snapshots, post-earnings
  // recs — all meaningless on a closed trade).
  // An expired position whose outcome the user hasn't resolved yet is
  // strictly more urgent than any live-data badge — those badges (HOLD,
  // EXPIRING, MAX_PROFIT, etc.) are computed against future-expiry
  // contracts and don't apply once the position is past its expiry.
  // Override the collapsed row to a single "needs action" amber badge
  // and tint the row background so it stands out in the list. Clicking
  // the row expands it and reveals the Expire Worthless / Record
  // Assignment buttons in VerifyAssignmentPanel.
  const todayIso = new Date().toISOString().slice(0, 10);
  const needsExpiryAction =
    open !== null &&
    open.expiry < todayIso &&
    (open.expiryStatus === "needs_verification" ||
      open.expiryStatus === "pending");

  const rowTint = needsExpiryAction
    ? "bg-amber-950/30"
    : open
      ? rowTintFromBadge(open.badge)
      : rowTintClosed(closed?.realizedPnl ?? null);
  const status = needsExpiryAction
    ? {
        label: "⚠ EXPIRED — click to resolve",
        className: badgePillClass("amber"),
        tooltip:
          open && open.expiryStatus === "pending"
            ? "Expired but no snapshot to auto-classify. Expand the row to confirm the outcome."
            : "Expired close to strike — assignment possible. Expand the row to confirm.",
      }
    : open
      ? {
          label: open.badgeLabel,
          className: badgePillClass(open.badgeColor),
          tooltip: open.badgeTooltip,
        }
      : {
          ...statusBadgeClosed(closed?.status ?? "closed", closed?.realizedPnl ?? null),
          tooltip: "",
        };
  const pnlDollars = open ? open.pnlDollars : (closed?.realizedPnl ?? null);
  const pnlPct = open ? open.pnlPct : null;
  const pnlColor =
    pnlDollars === null
      ? "text-muted-foreground"
      : pnlDollars >= 0
        ? "text-emerald-300"
        : "text-rose-300";
  // Live-only fields; closed rows render as "—" since these are
  // meaningful at a moment-in-time only.
  const stockPrice = open ? open.currentStockPrice : null;
  const distancePct = open ? open.distanceToStrikePct : null;
  const iv = open ? open.currentIv : null;
  const theta = open ? open.currentTheta : null;

  return (
    <div
      className={cn(
        "group rounded-md border border-border transition-colors",
        rowTint,
        expanded && "border-foreground/20",
      )}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className={cn(COLLAPSED_ROW_GRID, "py-2")}
      >
        {/* 1. Post-earnings dot */}
        <div className="flex h-4 w-4 items-center justify-center">
          {p.postEarningsRec ? <RecDot rec={p.postEarningsRec} /> : null}
        </div>
        {/* 2. Symbol */}
        <div className="truncate text-left font-semibold">{p.symbol}</div>
        {/* 3. Strike */}
        <div className="truncate text-left font-mono text-xs text-muted-foreground">
          ${p.strike}
          {p.optionType === "put" ? "P" : "C"}
        </div>
        {/* 4. Expiry — hidden on mobile */}
        <div className="hidden truncate text-left text-xs text-muted-foreground sm:block">
          {shortExpiry(p.expiry)}
        </div>
        {/* 5. Qty */}
        <div className="text-right text-xs text-muted-foreground">×{p.remainingContracts}</div>
        {/* 6. Stock */}
        <div className="text-right font-mono text-xs text-muted-foreground">
          {stockPrice !== null ? `$${stockPrice.toFixed(2)}` : "—"}
        </div>
        {/* 7. P&L */}
        <div className={cn("text-right font-mono text-xs", pnlColor)}>
          {fmtDollarsSigned(pnlDollars)}
        </div>
        {/* 8. POP% */}
        <div className={cn("text-right text-xs", popColor(pop))}>
          {pop !== null ? `${Math.round(pop * 100)}%` : "—"}
        </div>
        {/* 9. % OTM — hidden on mobile */}
        <div
          className={cn(
            "hidden text-right text-xs sm:block",
            distancePct === null
              ? "text-muted-foreground"
              : distancePct >= 0
                ? "text-emerald-300"
                : "text-rose-300",
          )}
        >
          {distancePct !== null ? `${distancePct.toFixed(1)}%` : "—"}
        </div>
        {/* 10. IV — hidden on mobile */}
        <div className="hidden text-right text-xs text-muted-foreground sm:block">
          {iv !== null ? `${(iv * 100).toFixed(0)}%` : "—"}
        </div>
        {/* 11. θ (theta) — hidden on mobile */}
        <div className="hidden text-right font-mono text-xs text-muted-foreground sm:block">
          {theta !== null ? theta.toFixed(2) : "—"}
        </div>
        {/* 12. Grade */}
        <div className="text-left">
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
        {/* 13. Status — badge + hover chevron share the cell via flex.
              Chevron: always visible on mobile (no hover on touch),
              opacity-0 on desktop until the row is hovered. */}
        <div className="flex items-center justify-end gap-1.5">
          {status.tooltip ? (
            <TooltipProvider delayDuration={150}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    className={cn(
                      "rounded border px-2 py-0.5 text-[10px] font-semibold whitespace-nowrap",
                      status.className,
                    )}
                  >
                    {status.label}
                  </span>
                </TooltipTrigger>
                <TooltipContent className="max-w-xs text-xs">
                  {status.tooltip}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          ) : (
            <span
              className={cn(
                "rounded border px-2 py-0.5 text-[10px] font-semibold whitespace-nowrap",
                status.className,
              )}
            >
              {status.label}
            </span>
          )}
          {props.kind === "open" && (
            <span
              role="button"
              tabIndex={0}
              aria-label="Remove position"
              title="Remove position"
              onClick={onRemoveClick}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onRemoveClick(e);
                }
              }}
              className={cn(
                "inline-flex items-center justify-center rounded p-0.5 text-muted-foreground transition-[opacity,colors] duration-150",
                "hover:bg-rose-500/15 hover:text-rose-300",
                "opacity-100 sm:opacity-0 sm:group-hover:opacity-100",
              )}
            >
              <Trash2 className="h-3 w-3" />
            </span>
          )}
          <ChevronRight
            className={cn(
              "h-3 w-3 text-muted-foreground transition-[opacity,transform] duration-150",
              "opacity-100 sm:opacity-0 sm:group-hover:opacity-100",
              expanded && "rotate-90",
            )}
          />
        </div>
      </button>

      {/* Inline remove-confirmation strip — sits between the collapsed
          row and the expanded detail so the user keeps visual context
          of which row they're about to delete. */}
      {removeOpen && props.kind === "open" && (
        <div className="flex flex-wrap items-center gap-2 border-t border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs">
          <span className="font-medium text-rose-200">
            ⚠ Remove this position permanently?
          </span>
          <Button
            size="sm"
            onClick={confirmRemove}
            disabled={removing}
            className="bg-rose-500/80 hover:bg-rose-500"
          >
            {removing ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              "Remove"
            )}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={cancelRemove}
            disabled={removing}
          >
            Cancel
          </Button>
          {removeError && (
            <span className="basis-full rounded border border-rose-500/40 bg-rose-500/15 px-2 py-1 text-rose-200">
              {removeError}
            </span>
          )}
        </div>
      )}

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
            {props.kind === "open" && (
              <button
                type="button"
                onClick={() => setEditsOpen((v) => !v)}
                className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
              >
                <ListChecks className="h-3 w-3" />
                {editsOpen ? "Hide Fills" : "Edit Fills"}
              </button>
            )}
            <Link
              href={`/research/${encodeURIComponent(p.symbol)}`}
              className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
            >
              <ExternalLink className="h-3 w-3" />
              Research
            </Link>
            <Link
              href={`/encyclopedia/${encodeURIComponent(p.symbol)}`}
              className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
            >
              <ExternalLink className="h-3 w-3" />
              View in Encyclopedia
            </Link>
          </div>

          {props.kind === "open" && editsOpen && (
            <EditFillsPanel
              positionId={props.position.id}
              fills={props.position.fills}
              onChanged={props.onCloseSubmitted}
            />
          )}
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

// Edit Fills — inline panel that shows every row in the fills table for
// one position, with delete + inline qty edit + manual-add. After any
// mutation we call onChanged() (the same callback PositionsView wires to
// onCloseSubmitted), which refetches /api/positions/open and re-renders
// this card with fresh fills.
//
// fill_date is the only timestamp the schema currently stores — there's
// no separate fill_time column — so the table shows date only. The
// user's "4/28 9:07" mockup would need a schema migration first.
function EditFillsPanel({
  positionId,
  fills,
  onChanged,
}: {
  positionId: string;
  fills: Fill[];
  onChanged: (msg: string) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editVal, setEditVal] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [addSide, setAddSide] = useState<"open" | "close">("open");
  const [addQty, setAddQty] = useState("");
  const [addPrice, setAddPrice] = useState("");
  const [addDate, setAddDate] = useState(() =>
    new Date().toISOString().slice(0, 10),
  );

  const sorted = [...fills].sort((a, b) =>
    a.fill_date.localeCompare(b.fill_date),
  );
  const totalOpened = fills
    .filter((f) => f.fill_type === "open")
    .reduce((s, f) => s + f.contracts, 0);
  const totalClosed = fills
    .filter((f) => f.fill_type === "close")
    .reduce((s, f) => s + f.contracts, 0);
  const remaining = totalOpened - totalClosed;
  const avgOpen = (() => {
    const opens = fills.filter((f) => f.fill_type === "open");
    const totalQ = opens.reduce((s, f) => s + f.contracts, 0);
    if (totalQ === 0) return null;
    return (
      opens.reduce((s, f) => s + f.contracts * f.premium, 0) / totalQ
    );
  })();

  async function handleDelete(fillId: string) {
    setBusy(fillId);
    setError(null);
    try {
      const res = await fetch(
        `/api/positions/${positionId}/fills/${fillId}`,
        { method: "DELETE" },
      );
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setError(j.error ?? `HTTP ${res.status}`);
        return;
      }
      onChanged("Fill deleted");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setBusy(null);
    }
  }

  async function handleQtyEdit(fillId: string, contracts: number) {
    setBusy(fillId);
    setError(null);
    try {
      const res = await fetch(
        `/api/positions/${positionId}/fills/${fillId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contracts }),
        },
      );
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setError(j.error ?? `HTTP ${res.status}`);
        return;
      }
      onChanged("Fill updated");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setEditingId(null);
      setBusy(null);
    }
  }

  async function handleAdd() {
    const qty = Number(addQty);
    const price = Number(addPrice);
    if (!Number.isFinite(qty) || qty <= 0) {
      setError("Qty must be > 0");
      return;
    }
    if (!Number.isFinite(price) || price < 0) {
      setError("Price must be ≥ 0");
      return;
    }
    setBusy("add");
    setError(null);
    try {
      const res = await fetch(`/api/positions/${positionId}/fills`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          side: addSide,
          contracts: qty,
          premium: price,
          fill_date: addDate,
        }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setError(j.error ?? `HTTP ${res.status}`);
        return;
      }
      setAddSide("open");
      setAddQty("");
      setAddPrice("");
      setAddDate(new Date().toISOString().slice(0, 10));
      setAddOpen(false);
      onChanged("Fill added");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mt-4 rounded-md border border-border bg-background/40 p-3 text-xs">
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        Fills
      </div>
      {error && (
        <div className="mb-2 rounded border border-rose-500/40 bg-rose-500/10 p-1.5 text-rose-200">
          {error}
        </div>
      )}
      <div className="overflow-hidden rounded border border-border">
        <table className="min-w-full text-[11px]">
          <thead className="bg-background/60 text-muted-foreground">
            <tr>
              <th className="px-2 py-1 text-left font-medium">Date</th>
              <th className="px-2 py-1 text-left font-medium">Side</th>
              <th className="px-2 py-1 text-right font-medium">Qty</th>
              <th className="px-2 py-1 text-right font-medium">Price</th>
              <th className="w-8" />
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 && (
              <tr>
                <td
                  colSpan={5}
                  className="px-2 py-3 text-center text-muted-foreground"
                >
                  No fills recorded.
                </td>
              </tr>
            )}
            {sorted.map((f) => {
              const id = f.id ?? "";
              const editing = editingId === id;
              return (
                <tr
                  key={id || `${f.fill_date}-${f.fill_type}-${f.premium}`}
                  className="border-t border-border"
                >
                  <td className="px-2 py-1 font-mono">{f.fill_date}</td>
                  <td className="px-2 py-1">
                    <span
                      className={cn(
                        "font-mono font-semibold",
                        f.fill_type === "open"
                          ? "text-rose-300"
                          : "text-emerald-300",
                      )}
                    >
                      {f.fill_type === "open" ? "SELL" : "BUY"}
                    </span>
                  </td>
                  <td className="px-2 py-1 text-right font-mono">
                    {editing ? (
                      <input
                        autoFocus
                        type="number"
                        step="1"
                        value={editVal}
                        onChange={(e) => setEditVal(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            const n = Number(editVal);
                            if (Number.isFinite(n) && n > 0 && id) {
                              void handleQtyEdit(id, n);
                            } else {
                              setEditingId(null);
                            }
                          } else if (e.key === "Escape") {
                            setEditingId(null);
                          }
                        }}
                        onBlur={() => setEditingId(null)}
                        className="w-14 rounded border border-border bg-background px-1 py-0.5 text-right font-mono"
                      />
                    ) : (
                      <span
                        className="cursor-text rounded px-1 hover:bg-white/5"
                        onClick={() => {
                          if (!id || busy) return;
                          setEditingId(id);
                          setEditVal(String(f.contracts));
                        }}
                        title="Click to edit qty"
                      >
                        {f.contracts}
                      </span>
                    )}
                  </td>
                  <td className="px-2 py-1 text-right font-mono">
                    ${f.premium.toFixed(2)}
                  </td>
                  <td className="px-2 py-1 text-center">
                    {id && (
                      <button
                        type="button"
                        onClick={() => void handleDelete(id)}
                        disabled={busy === id}
                        className="text-muted-foreground hover:text-rose-300 disabled:opacity-50"
                        title="Delete fill"
                      >
                        {busy === id ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <X className="h-3 w-3" />
                        )}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="mt-2 flex justify-between text-[11px] text-muted-foreground">
        <span>
          Total: {remaining} contracts ({totalOpened} opened
          {totalClosed > 0 ? `, ${totalClosed} closed` : ""})
        </span>
        {avgOpen !== null && <span>Avg: ${avgOpen.toFixed(2)}</span>}
      </div>

      {addOpen ? (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded border border-border bg-background/60 p-2">
          <input
            type="date"
            value={addDate}
            onChange={(e) => setAddDate(e.target.value)}
            className="rounded border border-border bg-background px-2 py-1 text-xs"
          />
          <select
            value={addSide}
            onChange={(e) => setAddSide(e.target.value as "open" | "close")}
            className="rounded border border-border bg-background px-2 py-1 text-xs"
          >
            <option value="open">SELL (open)</option>
            <option value="close">BUY (close)</option>
          </select>
          <input
            type="number"
            step="1"
            placeholder="Qty"
            value={addQty}
            onChange={(e) => setAddQty(e.target.value)}
            className="w-20 rounded border border-border bg-background px-2 py-1 text-xs"
          />
          <input
            type="number"
            step="0.01"
            placeholder="Price"
            value={addPrice}
            onChange={(e) => setAddPrice(e.target.value)}
            className="w-24 rounded border border-border bg-background px-2 py-1 text-xs"
          />
          <button
            type="button"
            onClick={() => void handleAdd()}
            disabled={busy === "add"}
            className="inline-flex items-center gap-1 rounded border border-border bg-background px-2 py-1 text-xs hover:bg-background/80 disabled:opacity-50"
          >
            {busy === "add" ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Plus className="h-3 w-3" />
            )}
            Add
          </button>
          <button
            type="button"
            onClick={() => {
              setAddOpen(false);
              setError(null);
            }}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setAddOpen(true)}
          className="mt-2 inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
        >
          <Plus className="h-3 w-3" />
          Add fill manually
        </button>
      )}
    </div>
  );
}

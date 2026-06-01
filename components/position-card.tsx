"use client";

import { useEffect, useState } from "react";
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
  // 'short' = sold-to-open (CSP). 'long' = bought-to-open. Flips the
  // realized-P&L sign + drives the "Long" badge in the row.
  direction: "long" | "short";
  totalContracts: number;
  remainingContracts: number;
  avgPremiumSold: number | null;
  openedDate: string;
  currentStockPrice: number | null;
  priceSource?: "pre" | "post" | "regular" | null;
  currentMark: number | null;
  currentBid: number | null;
  currentAsk: number | null;
  currentDelta: number | null;
  currentTheta: number | null;
  currentIv: number | null;
  dte: number;
  pnlDollars: number | null;
  pnlPct: number | null;
  // 'mark' = computed off live option mark. 'intrinsic' = ITM put
  // estimate when option mark is unavailable. 'maxProfitOtm' = OTM
  // put assumed worthless. null = no P&L computed.
  pnlSource?: "mark" | "intrinsic" | "maxProfitOtm" | null;
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
  // True when the stored expiry doesn't exist in Schwab's chain
  // within tolerance — drives the inline ⚠️ icon on the Expiry cell.
  expiryNotInChain?: boolean;
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
  direction: "long" | "short";
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
      // Current SPY marketState, threaded down from positions-view so
      // the row can suppress option-mark-derived fields outside the
      // regular session. null means "unknown" — fields render normally.
      marketState?: string | null;
      // Fires when the Grade-column "Close" button is clicked — the
      // parent owns the modal state so the row stays cheap to render
      // and the modal survives row re-renders from /api/positions/open
      // refreshes. Optional so the closed-list path can omit it.
      onCloseOption?: (target: import("./close-option-modal").CloseOptionTarget) => void;
    }
  | {
      kind: "closed";
      position: ClosedPositionClientView;
    };

// Grid template shared between the collapsed row and the column-header
// row in positions-view. Keeping both on the same template guarantees
// header labels sit directly above their data. If you add/remove a
// column here, update PositionsTableHeader to match.
//
// Each data column is `minmax(<min-px>, <weight>fr)` so columns hold a
// readable minimum width even on narrow viewports, and the leftover
// space distributes proportionally to the weights. Weights match the
// percentage allocations in the design spec (sum to ~67%, rest is
// spacing/dot).
//
// Desktop (sm+, 10 cols, left → right):
//   1. 24px               post-earnings dot
//   2. minmax(80px,  8fr) STRIKE   right
//   3. minmax(70px,  7fr) EXPIRY   right
//   4. minmax(50px,  5fr) QTY      right
//   5. minmax(80px,  9fr) P&L      right
//   6. minmax(60px,  6fr) POP      right
//   7. minmax(70px,  7fr) % OTM    right
//   8. minmax(60px,  6fr) IV       right
//   9. minmax(70px,  7fr) GRADE    center  (also carries inline theta)
//  10. minmax(130px,12fr) STATUS   center
//
// Mobile (< sm, 7 cols): drops EXPIRY / % OTM / IV. Those cells use
// `hidden sm:block` so they're pulled out of the grid flow on mobile,
// leaving only the 7 visible cells which match the mobile template.
// Three breakpoints to keep STATUS / badge labels readable on
// every viewport size:
//   <sm  (mobile, 7 cols):  dot · Strike · Qty · P&L · POP ·
//                            Grade · Status
//   sm–lg (tablet, 10 cols): adds Expiry · Mark · % OTM
//   lg+   (desktop, 12 cols): adds Premium · IV
//
// Column widths use minmax(min-px, Nfr) with tight per-column
// minimums sized to fit the largest realistic content at the
// shrunken text-xs (12px) baseline. STATUS minimum is 100px so
// "MAX PROFIT" / "EMERGENCY_CUT" badges (whitespace-nowrap, no
// truncation) always render in full; the surrounding cell never
// clips overflow. fr weights distribute leftover space.
//
// Sum at tablet (10 cols): 544px columns + 72 gap + 24 pad = 640
// → fits 768 iPad portrait with ~128px headroom.
// Sum at desktop (12 cols): 634px + 88 gap + 24 pad = 746
// → fits any laptop / desktop with room.
// Sum at mobile (7 cols):  384 + 48 + 24 = 456
// → slightly over a 375px iPhone; row scrolls horizontally if
//   needed, but the visible cells aren't truncated.
export const COLLAPSED_ROW_GRID =
  // gap-1.5 below sm (6 px) so the mobile row fits an iPhone 15
  // viewport; gap-2 (8 px) restored at sm+ for the iPad / desktop
  // layouts that have already been tuned to that spacing.
  "grid w-full items-center gap-1.5 px-3 text-xs sm:gap-2 lg:text-sm " +
  // Mobile (7 cols) minimums trimmed from earlier 60/40/70/45/45/100
  // to 55/40/65/45/45/90 — saves 15 px of unavoidable width so the
  // sum (24+55+40+65+45+45+90 + 6×6 gap + 24 padding = 414 px) fits
  // an iPhone 15 (390 − 32 container = 358 px) much more closely.
  "grid-cols-[24px_minmax(55px,8fr)_minmax(40px,5fr)_minmax(65px,9fr)_minmax(45px,6fr)_minmax(45px,7fr)_minmax(90px,12fr)] " +
  "sm:grid-cols-[24px_minmax(60px,8fr)_minmax(55px,7fr)_minmax(40px,5fr)_minmax(50px,6fr)_minmax(70px,9fr)_minmax(45px,6fr)_minmax(55px,7fr)_minmax(45px,7fr)_minmax(100px,12fr)] " +
  "lg:grid-cols-[24px_minmax(60px,8fr)_minmax(55px,7fr)_minmax(40px,5fr)_minmax(50px,6fr)_minmax(50px,6fr)_minmax(70px,9fr)_minmax(45px,6fr)_minmax(55px,7fr)_minmax(40px,5fr)_minmax(45px,7fr)_minmax(100px,12fr)]";

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
  if (g === "B") return "bg-teal-500/20 text-teal-300 border-teal-500/40";
  if (g === "C") return "bg-yellow-500/20 text-yellow-200 border-yellow-500/40";
  if (g === "D") return "bg-orange-500/20 text-orange-300 border-orange-500/40";
  if (g === "F") return "bg-rose-500/20 text-rose-300 border-rose-500/40";
  return "bg-muted/40 text-muted-foreground border-border";
}

// Status pill classes. Brighter than the old palette so a glance at
// the row tells you exactly what the position needs. EMERGENCY_CUT is
// the only one that pulses — it's the user's signal to drop everything
// and go close the trade right now.
function badgePillClass(color: "green" | "amber" | "red", badge?: string): string {
  const pulse = badge === "EMERGENCY_CUT" ? " animate-pulse" : "";
  if (badge === "MAX_PROFIT") {
    return "bg-emerald-500/25 text-emerald-200 border-emerald-400 font-bold";
  }
  if (color === "red") {
    return `bg-red-500/30 text-red-200 border-red-500 font-semibold${pulse}`;
  }
  if (color === "amber") {
    return "bg-amber-500/25 text-amber-200 border-amber-500 font-semibold";
  }
  // green default — softer for HOLD-style positions so MAX_PROFIT pops
  return "bg-emerald-500/15 text-emerald-300 border-emerald-500/40";
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
  // Outside the regular session, every option-derived field is stale —
  // the chain quotes last-traded marks, deltas / IVs are frozen, and
  // intrinsic-fallback estimates suggest a final P&L that hasn't
  // actually crystallized (the user said: "implies profit already
  // captured" is misleading). Drop ALL P&L variants + POP + IV to "—"
  // while leaving stock-price-derived fields (% OTM, status badge)
  // intact — those still come from a live Yahoo extended quote.
  const marketState =
    props.kind === "open" ? (props.marketState ?? null) : null;
  const optionsStale = marketState !== null && marketState !== "REGULAR";
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
          className: badgePillClass(open.badgeColor, open.badge),
          tooltip: open.badgeTooltip,
        }
      : {
          ...statusBadgeClosed(closed?.status ?? "closed", closed?.realizedPnl ?? null),
          tooltip: "",
        };
  const pnlDollars = open ? open.pnlDollars : (closed?.realizedPnl ?? null);
  const pnlPct = open ? open.pnlPct : null;
  // pnlSource is set by /api/positions/open when the live mark is
  // unavailable and we fall back to an intrinsic-value (ITM) or
  // max-profit (OTM) estimate. Closed rows always treat as 'mark'-
  // exact since the realized P&L is final.
  const pnlSource = open?.pnlSource ?? "mark";
  const pnlIsEstimate =
    pnlSource === "intrinsic" || pnlSource === "maxProfitOtm";

  // ---- Manual after-hours mark ----
  // When the row is open + optionsStale, the user can type the mark
  // they're seeing on their broker into the Mark cell. We persist it
  // to localStorage keyed by position id so it survives reloads, and
  // recompute pnl from (avg − manual) × qty × 100 (sign flipped on
  // long rows). Once a live Schwab mark lands, the cached value is
  // wiped and the live number takes over.
  const positionId = open?.id ?? null;
  const [manualMark, setManualMark] = useState<string>("");
  const [manualMarkDraft, setManualMarkDraft] = useState<string>("");
  useEffect(() => {
    if (!positionId || typeof window === "undefined") return;
    try {
      const v = window.localStorage.getItem(`manual_mark_${positionId}`);
      if (v) {
        setManualMark(v);
        setManualMarkDraft(v);
      } else {
        setManualMark("");
        setManualMarkDraft("");
      }
    } catch {
      /* SSR / quota — ignore */
    }
  }, [positionId]);
  // Wipe the override the moment a real live mark is available — the
  // route only populates currentMark when marketState === REGULAR and
  // the chain returned a quote, so this is the authoritative signal.
  useEffect(() => {
    if (!positionId || typeof window === "undefined") return;
    if (!optionsStale && open?.currentMark !== null && open?.currentMark !== undefined) {
      try {
        window.localStorage.removeItem(`manual_mark_${positionId}`);
      } catch {
        /* ignore */
      }
      setManualMark("");
      setManualMarkDraft("");
    }
  }, [positionId, optionsStale, open?.currentMark]);

  const manualMarkNum = manualMark ? Number(manualMark) : NaN;
  const manualOverrideActive =
    open !== null &&
    optionsStale &&
    Number.isFinite(manualMarkNum) &&
    manualMarkNum >= 0 &&
    open.avgPremiumSold !== null;
  const manualOverridePnl =
    manualOverrideActive && open && open.avgPremiumSold !== null
      ? (open.direction === "long"
          ? manualMarkNum - open.avgPremiumSold
          : open.avgPremiumSold - manualMarkNum) *
        open.remainingContracts *
        100
      : null;

  function commitManualMark(raw: string) {
    const trimmed = raw.trim();
    if (!positionId || typeof window === "undefined") return;
    if (!trimmed) {
      try {
        window.localStorage.removeItem(`manual_mark_${positionId}`);
      } catch {
        /* ignore */
      }
      setManualMark("");
      setManualMarkDraft("");
      return;
    }
    const num = Number(trimmed);
    if (!Number.isFinite(num) || num < 0) return;
    try {
      window.localStorage.setItem(`manual_mark_${positionId}`, trimmed);
    } catch {
      /* quota — silently skip persistence */
    }
    setManualMark(trimmed);
  }

  // Suppress every per-row P&L variant outside the regular session.
  // Intrinsic / maxProfitOtm fallbacks looked plausible AH but masked
  // the fact that the position could still flip overnight — surfacing
  // "—" makes the open-market dependency explicit. The manual-mark
  // override re-enables the cell with a "~" estimate prefix.
  const suppressMarkPnl = optionsStale && !manualOverrideActive;
  const effectivePnlDollars = manualOverrideActive
    ? manualOverridePnl
    : pnlDollars;
  const pnlColor =
    effectivePnlDollars === null
      ? "text-muted-foreground"
      : manualOverrideActive
        ? // Manual after-hours estimate — amber to flag that it's a
          // user-typed mark, not a live quote.
          "text-amber-300"
        : pnlSource === "intrinsic"
          ? // ITM estimate is amber regardless of sign — it's an
            // approximation of a likely-loss scenario.
            "text-amber-300"
          : pnlSource === "maxProfitOtm"
            ? // OTM estimate uses a softer green — it's the best-case
              // assumption (full premium kept) and we're not 100% sure.
              "text-emerald-200/80"
            : effectivePnlDollars >= 0
              ? "text-emerald-300"
              : "text-rose-300";
  const pnlPrefix = manualOverrideActive || pnlIsEstimate ? "~" : "";
  const pnlTooltip = manualOverrideActive
    ? `After-hours estimate based on your manually-entered mark ($${manualMarkNum.toFixed(2)}). Clears automatically when a live Schwab mark is available.`
    : pnlSource === "intrinsic"
      ? `Estimated P&L based on intrinsic value (strike − stock price). Actual closing price may differ.`
      : pnlSource === "maxProfitOtm"
        ? `Estimated P&L assuming OTM at expiry (full premium kept). Actual closing price may differ.`
        : "";
  // Live-only fields; closed rows render as "—" since these are
  // meaningful at a moment-in-time only. Stock price moved into the
  // ticker sub-header in positions-view, so the row no longer renders
  // it directly.
  const distancePct = open ? open.distanceToStrikePct : null;
  const iv = open ? open.currentIv : null;

  return (
    <div
      className={cn(
        "group rounded-md border border-border/60 transition-colors hover:border-foreground/20 hover:bg-foreground/[0.02]",
        rowTint,
        expanded && "border-foreground/30 bg-foreground/[0.03]",
      )}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className={cn(COLLAPSED_ROW_GRID, "py-1.5")}
      >
        {/* 1. Post-earnings dot */}
        <div className="flex h-4 w-4 items-center justify-center">
          {p.postEarningsRec ? <RecDot rec={p.postEarningsRec} /> : null}
        </div>
        {/* 2. Strike — appends a small "LONG" pill for bought-to-open
              positions. Short rows render unchanged (the historical
              default). The pill sits inline with the strike so it
              survives every breakpoint without grid surgery. */}
        <div className="truncate text-right font-mono text-foreground/90">
          ${p.strike}
          <span className="text-muted-foreground">{p.optionType === "put" ? "P" : "C"}</span>
          {p.direction === "long" && (
            <span
              className="ml-1 rounded border border-emerald-500/40 bg-emerald-500/10 px-1 text-[9px] font-semibold uppercase tracking-wider text-emerald-300 align-middle"
              title="Long position — bought to open"
            >
              L
            </span>
          )}
        </div>
        {/* 3. Expiry — hidden on mobile. ⚠️ when Schwab's chain
              doesn't list this expiry within picker tolerance, so
              the user knows P&L isn't computable until the date is
              corrected. Center-aligned (label/text column, not
              numeric). */}
        <div className="hidden truncate text-center font-mono text-muted-foreground sm:block">
          {props.kind === "open" && props.position.expiryNotInChain && (
            <span
              className="mr-1 cursor-help text-amber-300"
              title="Expiry not found in chain — verify strike/expiry date"
            >
              ⚠
            </span>
          )}
          {shortExpiry(p.expiry)}
        </div>
        {/* 4. Qty */}
        <div className="text-right font-mono text-foreground/80">
          ×{p.remainingContracts}
        </div>
        {/* 5. Premium (entry credit) — lg-only. Hidden on tablet
              (sm–lg) so the STATUS column keeps its full min width
              on iPad portrait. Premium is visible in the expanded
              card on smaller viewports. Static value from
              avg_premium_sold; never suppressed AH. */}
        <div className="hidden text-right font-mono text-muted-foreground lg:block">
          {open && open.avgPremiumSold !== null
            ? `$${open.avgPremiumSold.toFixed(2)}`
            : "—"}
        </div>
        {/* 6. Mark (current option price) — sm-only. After hours the
              chain returns stale last-traded marks, so for open rows
              we swap "—" for a small editable input. The user types
              the mark they're seeing on their broker; we persist it
              per-position in localStorage and recompute the P&L cell.
              Once a live regular-session mark is available, the
              effects above clear the cache and we render the live
              value instead. */}
        <div
          className={cn(
            "hidden text-right font-mono sm:block",
            optionsStale && !manualOverrideActive
              ? "text-muted-foreground"
              : manualOverrideActive
                ? "text-amber-300"
                : "text-foreground/80",
          )}
          title={
            manualOverrideActive
              ? "Manual after-hours mark — clears automatically when a live Schwab mark is available"
              : optionsStale
                ? "Type the mark you're seeing on your broker to estimate P&L after hours"
                : undefined
          }
        >
          {open && optionsStale ? (
            <input
              type="number"
              step="0.01"
              min="0"
              inputMode="decimal"
              value={manualMarkDraft}
              onChange={(e) => setManualMarkDraft(e.target.value)}
              onBlur={(e) => commitManualMark(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === "Tab") {
                  commitManualMark((e.currentTarget as HTMLInputElement).value);
                  if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
                }
                e.stopPropagation();
              }}
              onClick={(e) => e.stopPropagation()}
              placeholder="—"
              className={cn(
                "w-14 rounded border bg-background/60 px-1 py-0.5 text-right font-mono text-xs lg:w-16",
                manualOverrideActive
                  ? "border-amber-500/40 text-amber-300"
                  : "border-border/60 text-foreground/80",
              )}
            />
          ) : open && open.currentMark !== null ? (
            `$${open.currentMark.toFixed(2)}`
          ) : (
            "—"
          )}
        </div>
        {/* 7. P&L — bold so it reads first when scanning the row.
              Suppressed AH/closed when the figure would come from a
              stale option mark. */}
        <div
          className={cn(
            "text-right font-mono font-semibold",
            suppressMarkPnl ? "text-muted-foreground" : pnlColor,
          )}
          title={
            suppressMarkPnl
              ? "P&L hidden outside regular session — option marks are stale last-traded prices after hours"
              : pnlTooltip || undefined
          }
        >
          {suppressMarkPnl ? (
            "—"
          ) : (
            <>
              {pnlPrefix}
              {fmtDollarsSigned(effectivePnlDollars)}
            </>
          )}
        </div>
        {/* 6. POP% — also suppressed AH/closed since it's derived from
              the option delta, which goes stale alongside the mark. */}
        <div
          className={cn(
            "text-right font-mono text-base",
            optionsStale ? "text-muted-foreground" : popColor(pop),
          )}
          title={
            optionsStale
              ? "POP hidden outside regular session — option deltas are stale after hours"
              : undefined
          }
        >
          {optionsStale ? "—" : pop !== null ? `${Math.round(pop * 100)}%` : "—"}
        </div>
        {/* 7. % OTM — hidden on mobile. Danger zone (<5% breathing room or
              already ITM) flips amber/red regardless of sign. */}
        <div
          className={cn(
            "hidden text-right font-mono sm:block",
            distancePct === null
              ? "text-muted-foreground"
              : distancePct < 0
                ? "font-semibold text-rose-300"
                : distancePct < 5
                  ? "font-semibold text-amber-300"
                  : "text-emerald-300",
          )}
        >
          {distancePct !== null ? `${distancePct.toFixed(1)}%` : "—"}
        </div>
        {/* 8. IV — lg-only. Hidden on tablet (sm–lg) for the same
              reason as Premium — keeps STATUS readable on iPad
              portrait. Suppressed AH/closed (stale). */}
        <div
          className="hidden text-right font-mono text-muted-foreground lg:block"
          title={
            optionsStale
              ? "IV hidden outside regular session — last-traded value is stale after hours"
              : undefined
          }
        >
          {optionsStale ? "—" : iv !== null ? `${(iv * 100).toFixed(0)}%` : "—"}
        </div>
        {/* 9. Grade — center-aligned. On open option rows we use this
              slot for the quick-close "Close" button (parallel to the
              stock_long "Sell" button in positions-view). Entry grade
              stays visible in the expanded detail view. Closed rows
              still render the grade letter here. */}
        <div className="flex items-center justify-center">
          {props.kind === "open" && props.onCloseOption ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                props.onCloseOption!({
                  positionId: props.position.id,
                  symbol: props.position.symbol,
                  strike: props.position.strike,
                  expiry: props.position.expiry,
                  optionType: props.position.optionType,
                  direction: props.position.direction,
                  remainingContracts: props.position.remainingContracts,
                  avgPremiumSold: props.position.avgPremiumSold,
                  broker: props.position.broker,
                });
              }}
              title={
                p.entryFinalGrade
                  ? `Entry grade ${p.entryFinalGrade} — click to close`
                  : "Close position"
              }
              className="rounded border border-border/60 bg-background/60 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground hover:border-foreground/40 hover:text-foreground"
            >
              Close
            </button>
          ) : p.entryFinalGrade ? (
            <span
              className={cn(
                "inline-block rounded border px-1.5 py-0.5 text-sm font-semibold",
                gradeColor(p.entryFinalGrade),
              )}
            >
              {p.entryFinalGrade}
            </span>
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </div>
        {/* 10. Status — badge centered. Trash + chevron affordances absolute-
              positioned on the right edge so they don't push the badge
              off-center. Mobile shows the chevron inline since there's no
              hover state on touch. */}
        <div className="relative flex items-center justify-center">
          {status.tooltip ? (
            <TooltipProvider delayDuration={150}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    className={cn(
                      "rounded border px-1.5 py-0.5 text-[10px] font-semibold whitespace-nowrap lg:px-2 lg:text-xs",
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
                "rounded border px-1.5 py-0.5 text-[10px] font-semibold whitespace-nowrap lg:px-2 lg:text-xs",
                status.className,
              )}
            >
              {status.label}
            </span>
          )}
          <div className="absolute right-0 flex items-center gap-0.5">
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
                  "opacity-0 sm:group-hover:opacity-100",
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
      <Row
        k={p.direction === "long" ? "Avg paid" : "Avg premium sold"}
        v={fmtDollars(p.avgPremiumSold)}
      />
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
  // Extended-hours quote indicator. Yahoo's marketState=PRE/POST is
  // surfaced as 'pre' | 'post' from the open route — show a small
  // colored tag so the user knows this isn't the regular-session
  // close. 'regular' / null → no tag, render the stock figure
  // unadorned.
  const stockSuffix =
    p.priceSource === "post" ? (
      <span className="ml-1 rounded bg-amber-500/15 px-1 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wide text-amber-300">
        AH
      </span>
    ) : p.priceSource === "pre" ? (
      <span className="ml-1 rounded bg-sky-500/15 px-1 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wide text-sky-300">
        PM
      </span>
    ) : null;
  return (
    <div className="space-y-1 rounded border border-border bg-background/40 p-3">
      <div className="mb-1 text-xs font-semibold uppercase text-muted-foreground">
        Live
      </div>
      <Row
        k="Current stock"
        v={
          <span>
            {fmtDollars(p.currentStockPrice)}
            {stockSuffix}
          </span>
        }
      />
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
  // Fill dates are PT-anchored on the server (toPstDate / todayPst);
  // mirror that here so the picker's max and the server's check agree
  // regardless of the user's browser timezone.
  const todayPstIso = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const [addDate, setAddDate] = useState(todayPstIso);

  // Optimistic local copy of the fills array. We mutate this immediately
  // on a successful API call so the panel updates without waiting for
  // the parent's refetch round-trip. Synced from props only when the
  // total fill count changes (an add or external refetch landed) —
  // an in-place qty edit leaves length unchanged, so the optimistic
  // state isn't clobbered between the local mutation and the parent
  // refetch returning identical data.
  const [localFills, setLocalFills] = useState<Fill[]>(fills);
  const propsFillsLen = fills.length;
  useEffect(() => {
    setLocalFills(fills);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [propsFillsLen]);

  const sorted = [...localFills].sort((a, b) =>
    a.fill_date.localeCompare(b.fill_date),
  );
  const totalOpened = localFills
    .filter((f) => f.fill_type === "open")
    .reduce((s, f) => s + f.contracts, 0);
  const totalClosed = localFills
    .filter((f) => f.fill_type === "close")
    .reduce((s, f) => s + f.contracts, 0);
  const remaining = totalOpened - totalClosed;
  const avgOpen = (() => {
    const opens = localFills.filter((f) => f.fill_type === "open");
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
      // Optimistic — drop the row before the parent refetch lands so
      // the table updates instantly.
      setLocalFills((prev) => prev.filter((f) => f.id !== fillId));
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
      // Optimistic — patch the row locally so the qty + Total + Avg
      // numbers update without waiting on /api/positions/open.
      setLocalFills((prev) =>
        prev.map((f) => (f.id === fillId ? { ...f, contracts } : f)),
      );
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
    if (addDate > todayPstIso) {
      setError("Fill date cannot be in the future");
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
      setAddDate(todayPstIso);
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
            max={todayPstIso}
            onChange={(e) => setAddDate(e.target.value)}
            className="rounded border border-border bg-background px-2 py-1 text-xs"
          />
          {addDate > todayPstIso && (
            <span className="text-[11px] text-rose-300">
              Fill date cannot be in the future
            </span>
          )}
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
            disabled={busy === "add" || addDate > todayPstIso}
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

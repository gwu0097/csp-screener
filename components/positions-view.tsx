"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, ArrowDown, ArrowUp, Briefcase, Camera, Loader2, Plus, RefreshCcw, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ImportScreenshotModal } from "@/components/import-screenshot-modal";
import { ImportManualModal } from "@/components/import-manual-modal";
import {
  COLLAPSED_ROW_GRID,
  PositionCard,
  type ClosedPositionClientView,
  type OpenPositionClientView,
} from "@/components/position-card";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  ExpireConfirmationModal,
  type PendingConfirmationRow,
} from "@/components/expire-confirmation-modal";
import { UndoImportPopover } from "@/components/undo-import-popover";
import type { ConfirmItem } from "@/components/expire-confirmation-modal";
import { SchwabTokenBanner } from "@/components/schwab-token-banner";
import {
  SellSharesModal,
  type SellSharesTarget,
} from "@/components/sell-shares-modal";

type SortKey =
  | "strike"
  | "expiry"
  | "qty"
  | "pnl"
  | "pop"
  | "otm"
  | "iv"
  | "grade"
  | "status";
type SortDir = "asc" | "desc";

// First-click direction per column. Strike/expiry default to asc
// (smallest first reads naturally); everything else defaults to desc
// so the "best" rows surface up top.
const DEFAULT_SORT_DIR: Record<SortKey, SortDir> = {
  strike: "asc",
  expiry: "asc",
  qty: "desc",
  pnl: "desc",
  pop: "desc",
  otm: "desc",
  iv: "desc",
  grade: "asc",
  status: "asc",
};

function gradeRank(g: string | null | undefined): number {
  if (g === "A") return 0;
  if (g === "B") return 1;
  if (g === "C") return 2;
  if (g === "D") return 3;
  if (g === "F") return 4;
  return 99;
}

function popOf(p: OpenPositionClientView | ClosedPositionClientView): number | null {
  if ("currentDelta" in p && p.currentDelta !== null) return 1 - Math.abs(p.currentDelta);
  return null;
}

function pnlOf(p: OpenPositionClientView | ClosedPositionClientView): number | null {
  if ("pnlDollars" in p && p.pnlDollars !== undefined) return p.pnlDollars;
  if ("realizedPnl" in p) return p.realizedPnl;
  return null;
}

// Generic comparator. Numeric nulls sort to the end regardless of dir.
function cmp(a: number | string | null, b: number | string | null, dir: SortDir): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  if (typeof a === "number" && typeof b === "number") {
    return dir === "asc" ? a - b : b - a;
  }
  const sa = String(a);
  const sb = String(b);
  return dir === "asc" ? sa.localeCompare(sb) : sb.localeCompare(sa);
}

function sortPositions<T extends OpenPositionClientView | ClosedPositionClientView>(
  items: T[],
  key: SortKey,
  dir: SortDir,
): T[] {
  const arr = [...items];
  arr.sort((a, b) => {
    switch (key) {
      case "strike":
        return cmp(a.strike, b.strike, dir);
      case "expiry":
        return cmp(a.expiry, b.expiry, dir);
      case "qty":
        return cmp(a.remainingContracts, b.remainingContracts, dir);
      case "pnl":
        return cmp(pnlOf(a), pnlOf(b), dir);
      case "pop":
        return cmp(popOf(a), popOf(b), dir);
      case "otm":
        return cmp(
          "distanceToStrikePct" in a ? a.distanceToStrikePct ?? null : null,
          "distanceToStrikePct" in b ? b.distanceToStrikePct ?? null : null,
          dir,
        );
      case "iv":
        return cmp(
          "currentIv" in a ? a.currentIv ?? null : null,
          "currentIv" in b ? b.currentIv ?? null : null,
          dir,
        );
      case "grade":
        return cmp(gradeRank(a.entryFinalGrade), gradeRank(b.entryFinalGrade), dir);
      case "status": {
        const sa = "badge" in a ? a.badge : "status" in a ? a.status : "";
        const sb = "badge" in b ? b.badge : "status" in b ? b.status : "";
        return cmp(sa, sb, dir);
      }
      default:
        return 0;
    }
  });
  return arr;
}

type TickerGroup<T> = {
  symbol: string;
  items: T[];
  contractCount: number;
  stockPrice: number | null;
  combinedPnl: number | null;
};

// Sub-grouping inside a broker section. Sorts ticker groups by total
// contract count desc so the largest exposures bubble to the top.
function groupByTicker<
  T extends OpenPositionClientView | ClosedPositionClientView,
>(items: T[]): TickerGroup<T>[] {
  const m = new Map<string, T[]>();
  for (const it of items) {
    const key = it.symbol.toUpperCase();
    const arr = m.get(key) ?? [];
    arr.push(it);
    m.set(key, arr);
  }
  const out: TickerGroup<T>[] = [];
  for (const [symbol, arr] of Array.from(m.entries())) {
    const contractCount = arr.reduce((s, p) => s + (p.remainingContracts ?? 0), 0);
    const stockPriceRow = arr.find(
      (p): p is T & { currentStockPrice: number } =>
        "currentStockPrice" in p && p.currentStockPrice !== null,
    );
    const stockPrice = stockPriceRow?.currentStockPrice ?? null;
    const pnls = arr.map(pnlOf).filter((v): v is number => v !== null);
    const combinedPnl = pnls.length === 0 ? null : pnls.reduce((s, v) => s + v, 0);
    out.push({ symbol, items: arr, contractCount, stockPrice, combinedPnl });
  }
  out.sort((a, b) => b.contractCount - a.contractCount);
  return out;
}

// Column header row for a group of position cards. Uses the exact same
// grid template as the collapsed row so labels sit above their data.
// Hidden on mobile (< sm) — the mobile card layout uses auto columns
// and the labels wouldn't align anyway. Each label is a button that
// toggles the sort key/dir; sort applies within each ticker group.
function PositionsTableHeader({
  sortKey,
  sortDir,
  onSort,
}: {
  sortKey: SortKey;
  sortDir: SortDir;
  onSort: (k: SortKey) => void;
}) {
  return (
    <div
      className={cn(
        COLLAPSED_ROW_GRID,
        "hidden py-1.5 text-sm font-semibold uppercase text-muted-foreground sm:grid",
      )}
    >
      {/* 1 dot */}
      <div />
      {/* 2 Strike */}
      <SortHeader k="strike" label="Strike" align="right" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
      {/* 3 Expiry — hidden mobile */}
      <SortHeader k="expiry" label="Expiry" align="right" sortKey={sortKey} sortDir={sortDir} onSort={onSort} className="hidden sm:flex" />
      {/* 4 Qty */}
      <SortHeader k="qty" label="Qty" align="right" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
      {/* 5 Premium (entry credit) — sm-only, non-sortable */}
      <div className="hidden text-right text-sm font-semibold uppercase tracking-wide text-muted-foreground sm:block">
        Prem
      </div>
      {/* 6 Mark (current option price) — sm-only, non-sortable */}
      <div className="hidden text-right text-sm font-semibold uppercase tracking-wide text-muted-foreground sm:block">
        Mark
      </div>
      {/* 7 P&L */}
      <SortHeader k="pnl" label="P&L" align="right" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
      {/* 6 POP */}
      <SortHeader k="pop" label="POP" align="right" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
      {/* 7 % OTM — hidden mobile */}
      <SortHeader k="otm" label="% OTM" align="right" sortKey={sortKey} sortDir={sortDir} onSort={onSort} className="hidden sm:flex" />
      {/* 8 IV — hidden mobile */}
      <SortHeader k="iv" label="IV" align="right" sortKey={sortKey} sortDir={sortDir} onSort={onSort} className="hidden sm:flex" />
      {/* 9 Grade — center-aligned (badge cell, not numeric). Carries inline
              theta in the row body so a separate column isn't needed. */}
      <SortHeader k="grade" label="Grade" align="center" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
      {/* 10 Status — center-aligned */}
      <SortHeader k="status" label="Status" align="center" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
    </div>
  );
}

// Ticker sub-header rendered above the rows for one symbol within a
// broker section. Shows symbol + contract count + current price once,
// plus the combined P&L for that ticker so the user can see the
// per-name exposure at a glance instead of mentally summing rows.
function TickerSubHeader({
  symbol,
  contractCount,
  stockPrice,
  combinedPnl,
}: {
  symbol: string;
  contractCount: number;
  stockPrice: number | null;
  combinedPnl: number | null;
}) {
  const pnlCls =
    combinedPnl === null
      ? "text-muted-foreground"
      : combinedPnl >= 0
        ? "text-emerald-300"
        : "text-rose-300";
  return (
    <div className="flex items-baseline justify-between gap-2 border-t border-border/40 px-3 pt-2 pb-0.5 text-sm first:border-t-0 first:pt-1">
      <div className="flex items-baseline gap-2">
        <span className="text-lg font-bold tracking-wide text-foreground">{symbol}</span>
        <span className="font-mono text-sm text-muted-foreground">
          {contractCount} {contractCount === 1 ? "contract" : "contracts"}
        </span>
        {stockPrice !== null && (
          <span className="font-mono text-sm text-muted-foreground/80">
            · {fmtDollars(stockPrice)}
          </span>
        )}
      </div>
      <span className={cn("font-mono text-base font-semibold", pnlCls)}>
        {fmtDollarsSigned(combinedPnl)}
      </span>
    </div>
  );
}

function SortHeader({
  k,
  label,
  align,
  sortKey,
  sortDir,
  onSort,
  className,
}: {
  k: SortKey;
  label: string;
  align: "left" | "right" | "center";
  sortKey: SortKey;
  sortDir: SortDir;
  onSort: (k: SortKey) => void;
  className?: string;
}) {
  const active = sortKey === k;
  return (
    <button
      type="button"
      onClick={() => onSort(k)}
      className={cn(
        "flex items-center gap-0.5 text-sm font-semibold uppercase tracking-wide transition-colors",
        align === "right"
          ? "justify-end"
          : align === "center"
            ? "justify-center"
            : "justify-start",
        active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
        className,
      )}
    >
      <span>{label}</span>
      {active &&
        (sortDir === "asc" ? (
          <ArrowUp className="h-2.5 w-2.5" />
        ) : (
          <ArrowDown className="h-2.5 w-2.5" />
        ))}
    </button>
  );
}
import { fmtDollars, fmtDollarsSigned } from "@/lib/format";
import type { MarketContext } from "@/lib/market";

// localStorage cache of the last successful /api/positions/open?live=true
// response — lets us populate live fields immediately on page load
// instead of flashing "—" until the user hits Refresh live data.
const LS_LIVE_CACHE = "positions_live_cache";
// sessionStorage flag — once the same-day after-close confirmation
// modal has been dismissed (cancel or confirm), don't re-show it
// for the rest of this browser session even if pending_confirmation
// keeps coming back from the server. Resets on tab close.
const LS_EXPIRE_MODAL_SHOWN = "expire_modal_shown_this_session";

// Fields that only exist on a live fetch. Everything else on the open
// position row (grades, opened date, etc.) comes from the DB and is
// present on both live=false and live=true responses.
const LIVE_FIELDS = [
  "currentStockPrice",
  "currentMark",
  "currentBid",
  "currentAsk",
  "currentDelta",
  "currentTheta",
  "currentIv",
  "pnlDollars",
  "pnlPct",
  "distanceToStrikePct",
  "thetaDecayTotal",
  "momentum",
  "urgency",
  "recommendationReason",
] as const;

type LiveCacheEntry = Partial<Pick<OpenPositionClientView, (typeof LIVE_FIELDS)[number]>>;
type LiveCache = { fetchedAt: string; byId: Record<string, LiveCacheEntry> };

function readLiveCache(): LiveCache | null {
  try {
    const raw = localStorage.getItem(LS_LIVE_CACHE);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as LiveCache;
    if (!parsed || !parsed.fetchedAt || !parsed.byId) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeLiveCache(positions: OpenPositionClientView[]): LiveCache {
  const byId: Record<string, LiveCacheEntry> = {};
  for (const p of positions) {
    const entry: LiveCacheEntry = {};
    for (const f of LIVE_FIELDS) {
      // @ts-expect-error runtime shape matches the typed fields list
      entry[f] = p[f];
    }
    byId[p.id] = entry;
  }
  const cache: LiveCache = { fetchedAt: new Date().toISOString(), byId };
  try {
    localStorage.setItem(LS_LIVE_CACHE, JSON.stringify(cache));
  } catch {
    /* quota exceeded — ignore, cache is best-effort */
  }
  return cache;
}

function mergeCacheIntoPositions(
  positions: OpenPositionClientView[],
  cache: LiveCache,
): OpenPositionClientView[] {
  return positions.map((p) => {
    const cached = cache.byId[p.id];
    if (!cached) return p;
    // Only fill cached values where the fresh row has them null/undefined —
    // a true live refresh always wins.
    const merged = { ...p };
    for (const f of LIVE_FIELDS) {
      const liveVal = (p as Record<string, unknown>)[f];
      if (liveVal === null || liveVal === undefined) {
        // @ts-expect-error runtime shape matches the typed fields list
        merged[f] = cached[f] ?? liveVal;
      }
    }
    return merged;
  });
}

function fmtTimeShort(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

// Section label + ordering for the broker groups. Anything not in
// this list (or missing a broker) falls into the "Other" bucket and
// renders last.
const BROKER_ORDER = ["schwab", "schwab2", "robinhood"] as const;
const BROKER_LABEL: Record<string, string> = {
  schwab: "Schwab",
  schwab2: "Schwab 2",
  robinhood: "Robinhood",
  other: "Other",
};

// Per-account accent palette — drives both the panel border and the
// active-tab tint. Keep these subtle; the data is the loud part.
type AccountAccent = {
  panelBorder: string;
  panelBg: string;
  topBar: string;
  text: string;
  tabActive: string;
  dot: string;
};
const ACCOUNT_ACCENT: Record<string, AccountAccent> = {
  schwab: {
    panelBorder: "border-sky-500/30",
    panelBg: "bg-sky-500/[0.025]",
    topBar: "bg-sky-500/60",
    text: "text-sky-300",
    tabActive: "bg-sky-500/15 text-sky-200 border-sky-500/40",
    dot: "bg-sky-400",
  },
  schwab2: {
    panelBorder: "border-purple-500/30",
    panelBg: "bg-purple-500/[0.025]",
    topBar: "bg-purple-500/60",
    text: "text-purple-300",
    tabActive: "bg-purple-500/15 text-purple-200 border-purple-500/40",
    dot: "bg-purple-400",
  },
  robinhood: {
    panelBorder: "border-emerald-500/30",
    panelBg: "bg-emerald-500/[0.025]",
    topBar: "bg-emerald-500/60",
    text: "text-emerald-300",
    tabActive: "bg-emerald-500/15 text-emerald-200 border-emerald-500/40",
    dot: "bg-emerald-400",
  },
  other: {
    panelBorder: "border-border",
    panelBg: "",
    topBar: "bg-muted-foreground/40",
    text: "text-foreground",
    tabActive: "bg-foreground/10 text-foreground border-foreground/20",
    dot: "bg-muted-foreground",
  },
};

function accentFor(key: string): AccountAccent {
  return ACCOUNT_ACCENT[key] ?? ACCOUNT_ACCENT.other;
}

// Per-broker stats derived from the open positions in that group.
function computeBrokerStats(items: OpenPositionClientView[]): {
  maxProfit: number;
  maxProfitMissing: number;
  unrealized: number;
  unrealizedAvailable: boolean;
} {
  const contributors = items.filter(
    (p) => p.avgPremiumSold !== null && Number.isFinite(p.avgPremiumSold),
  );
  const maxProfit = contributors.reduce(
    (s, p) => s + (p.avgPremiumSold as number) * p.remainingContracts * 100,
    0,
  );
  const liveItems = items.filter((p) => p.pnlDollars !== null);
  const unrealized = liveItems.reduce((s, p) => s + (p.pnlDollars ?? 0), 0);
  return {
    maxProfit,
    maxProfitMissing: items.length - contributors.length,
    unrealized,
    unrealizedAvailable: liveItems.length > 0,
  };
}

// Bucket stock rows by broker key using the same broker-key
// normalization as groupByBroker. Returned as a Map so callers can
// look up by key while iterating the option-broker groups.
function groupStocksByBroker(
  stocks: StockPositionRow[],
): Map<string, StockPositionRow[]> {
  const groups = new Map<string, StockPositionRow[]>();
  for (const s of stocks) {
    const b = (s.broker ?? "").toLowerCase();
    const key =
      b === "schwab" || b === "schwab2" || b === "robinhood"
        ? b
        : b.length > 0
          ? b
          : "other";
    const arr = groups.get(key) ?? [];
    arr.push(s);
    groups.set(key, arr);
  }
  return groups;
}

// Status badge for a stock row. Maps pnlPct (percent, e.g. -4.04) to
// one of three states:
//   GAIN  — pnlPct > 0 (above cost basis)
//   HOLD  — within 10% below cost basis
//   LOSS  — more than 10% below cost basis
// pnlPct null falls back to HOLD so the cell never blanks.
function stockStatusBadge(
  pnlPct: number | null,
): { label: "GAIN" | "HOLD" | "LOSS"; className: string } {
  if (pnlPct === null || !Number.isFinite(pnlPct)) {
    return {
      label: "HOLD",
      className: "border-emerald-500/40 bg-emerald-500/15 text-emerald-300",
    };
  }
  if (pnlPct > 0) {
    return {
      label: "GAIN",
      className: "border-emerald-500/40 bg-emerald-500/20 text-emerald-200",
    };
  }
  if (pnlPct < -10) {
    return {
      label: "LOSS",
      className: "border-rose-500/40 bg-rose-500/15 text-rose-200",
    };
  }
  return {
    label: "HOLD",
    className: "border-emerald-500/40 bg-emerald-500/15 text-emerald-300",
  };
}

function groupByBroker<T extends { broker?: string | null; remainingContracts?: number }>(
  items: T[],
): Array<{ key: string; label: string; items: T[]; contractCount: number }> {
  const groups = new Map<string, T[]>();
  for (const it of items) {
    const b = (it.broker ?? "").toLowerCase();
    const key =
      b === "schwab" || b === "schwab2" || b === "robinhood"
        ? b
        : b.length > 0
          ? b
          : "other";
    const arr = groups.get(key) ?? [];
    arr.push(it);
    groups.set(key, arr);
  }
  const ordered: Array<{ key: string; label: string; items: T[]; contractCount: number }> = [];
  for (const k of BROKER_ORDER) {
    const items = groups.get(k);
    if (items && items.length > 0) {
      ordered.push({
        key: k,
        label: BROKER_LABEL[k] ?? k,
        items,
        contractCount: items.reduce((s, p) => s + (p.remainingContracts ?? 0), 0),
      });
      groups.delete(k);
    }
  }
  // Any remaining groups (unknown brokers) collapse into "Other" at the end.
  const remaining: T[] = [];
  for (const arr of Array.from(groups.values())) remaining.push(...arr);
  if (remaining.length > 0) {
    ordered.push({
      key: "other",
      label: BROKER_LABEL.other,
      items: remaining,
      contractCount: remaining.reduce((s, p) => s + (p.remainingContracts ?? 0), 0),
    });
  }
  return ordered;
}

type ExpireReport = {
  auto_expired: Array<{
    symbol: string;
    strike: number;
    realized_pnl: number;
  }>;
  needs_verification: unknown[];
  pending: unknown[];
  pending_confirmation: PendingConfirmationRow[];
  skipped: boolean;
  skipReason?: string;
};

export type StockPositionRow = {
  id: string;
  symbol: string;
  broker: string;
  positionType: "stock_long" | "stock_short";
  shares: number;
  costBasis: number | null;
  currentStockPrice: number | null;
  priceSource: "pre" | "post" | "regular" | null;
  pnlDollars: number | null;
  pnlPct: number | null;
  openedDate: string | null;
  notes: string | null;
  assignmentSourceId: string | null;
};

type PositionsResponse = {
  market: MarketContext;
  positions: OpenPositionClientView[];
  stockPositions?: StockPositionRow[];
  opportunityAvailable: boolean;
  live: boolean;
  expireReport?: ExpireReport;
  snapshotsWritten?: number;
  snapshotsSkipped?: number;
};

type BestOpportunity = { symbol: string; recommendation: string } | null;

function readBestOpportunity(): BestOpportunity {
  try {
    const raw = localStorage.getItem("screener_results");
    const ts = localStorage.getItem("screener_timestamp");
    if (!raw || !ts) return null;
    const screenDate = new Date(ts);
    if (Number.isNaN(screenDate.getTime())) return null;
    if (screenDate.toDateString() !== new Date().toDateString()) return null;
    const parsed = JSON.parse(raw) as Array<{ symbol: string; recommendation?: string }>;
    const strong = parsed.find((r) => r.recommendation?.startsWith("Strong"));
    if (strong) return { symbol: strong.symbol, recommendation: strong.recommendation! };
    const marginal = parsed.find((r) => r.recommendation?.startsWith("Marginal"));
    if (marginal) return { symbol: marginal.symbol, recommendation: marginal.recommendation! };
    return null;
  } catch {
    return null;
  }
}

function regimeColor(regime: MarketContext["regime"]) {
  if (regime === "panic") return "text-rose-300";
  if (regime === "elevated") return "text-amber-300";
  return "text-emerald-300";
}

// Today's realized P&L — not computed from the open-positions feed anymore
// (positions with status=closed are out of scope here). The Journal page
// shows realized P&L; we just show count + market context on this page.
export function PositionsView() {
  const [data, setData] = useState<PositionsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [liveLoading, setLiveLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [showScreenshot, setShowScreenshot] = useState(false);
  const [showManual, setShowManual] = useState(false);
  const [sellTarget, setSellTarget] = useState<SellSharesTarget | null>(null);
  const [best, setBest] = useState<BestOpportunity>(null);
  const [closedPositions, setClosedPositions] = useState<ClosedPositionClientView[] | null>(null);
  const [closedOpen, setClosedOpen] = useState(false);
  const [closedLoading, setClosedLoading] = useState(false);
  // When the last live refresh was cached to localStorage, for the
  // "Live data as of [time]" label. Null = never refreshed (or cache
  // was cleared manually).
  const [liveCacheFetchedAt, setLiveCacheFetchedAt] = useState<string | null>(null);
  // Result of the most recent live refresh — drives the "N snapshots
  // saved" / "snapshots up to date" suffix after the timestamp. Null
  // when we haven't done a live fetch yet this session.
  const [liveSnapshotSummary, setLiveSnapshotSummary] = useState<
    { written: number; skipped: number } | null
  >(null);
  // Single sort state shared across every broker → ticker subgroup.
  // Default: P&L desc — biggest winners up top, biggest losers at the
  // bottom (or up top if user re-clicks to flip dir).
  const [sortKey, setSortKey] = useState<SortKey>("pnl");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const onSort = useCallback((k: SortKey) => {
    setSortKey((prevKey) => {
      setSortDir((prevDir) =>
        prevKey === k ? (prevDir === "asc" ? "desc" : "asc") : DEFAULT_SORT_DIR[k],
      );
      return k;
    });
  }, []);
  // Account filter — "all" or a single broker key. Tabs only appear
  // when more than one broker has positions, so a single-account user
  // never sees noise.
  const [brokerFilter, setBrokerFilter] = useState<string>("all");
  // Expiry confirmation modal. Populated from the /api/positions/open
  // response's expireReport.pending_confirmation list.
  //
  // Two dismiss states:
  //   modalOpen — current visibility, toggled freely.
  //   permanentlyDismissed — set ONLY after a confirm round-trip.
  //     Persisted to sessionStorage so a Refresh/Live (which re-fires
  //     the auto-open) doesn't keep popping the modal after the user
  //     has already acted. The banner remains as the manual re-entry
  //     point while rows persist.
  // X / Cancel is a soft dismiss — closes the modal without setting
  // the persistent flag, so the next Refresh/Live (or page reload)
  // re-opens it. The user has to explicitly Confirm to silence it.
  const [showUndo, setShowUndo] = useState(false);
  const [pendingConfirmation, setPendingConfirmation] = useState<
    PendingConfirmationRow[]
  >([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [permanentlyDismissed, setPermanentlyDismissed] = useState<boolean>(
    () => {
      if (typeof window === "undefined") return false;
      return sessionStorage.getItem(LS_EXPIRE_MODAL_SHOWN) === "1";
    },
  );

  // Auto-open whenever a fresh load returns a non-empty pending list,
  // unless the user has already confirmed once this session. Each
  // load() produces a new array reference, so this fires on every
  // Refresh/Live as long as rows are present.
  useEffect(() => {
    if (pendingConfirmation.length > 0 && !permanentlyDismissed) {
      setModalOpen(true);
    }
  }, [pendingConfirmation, permanentlyDismissed]);

  const load = useCallback(async (live: boolean) => {
    if (live) setLiveLoading(true);
    else setLoading(true);
    setError(null);
    const opp = readBestOpportunity();
    setBest(opp);
    try {
      const res = await fetch(
        `/api/positions/open?opportunityAvailable=${opp !== null}&live=${live}`,
        { cache: "no-store" },
      );
      const json = (await res.json()) as PositionsResponse & { error?: string };
      if (!res.ok || json.error) throw new Error(json.error ?? `HTTP ${res.status}`);
      if (live) {
        // Fresh live fetch — cache the per-position live fields so the
        // next page load can hydrate immediately instead of showing "—".
        const cache = writeLiveCache(json.positions);
        setLiveCacheFetchedAt(cache.fetchedAt);
        setLiveSnapshotSummary({
          written: json.snapshotsWritten ?? 0,
          skipped: json.snapshotsSkipped ?? 0,
        });
        setData(json);
      } else {
        // Non-live fetch: merge cached live fields so P&L/Greeks
        // survive the page load. A true live refresh later overwrites.
        const cache = readLiveCache();
        if (cache) {
          setLiveCacheFetchedAt(cache.fetchedAt);
          setData({ ...json, positions: mergeCacheIntoPositions(json.positions, cache) });
        } else {
          setData(json);
        }
      }
      // Surface the auto-expire toast once per load if anything got
      // auto-closed. One green message, every auto-expired position
      // listed inline with its realized P&L.
      const expired = json.expireReport?.auto_expired ?? [];
      if (expired.length > 0) {
        const bits = expired.map((e) => {
          const sign = e.realized_pnl >= 0 ? "+" : "";
          return `${e.symbol} ${sign}$${e.realized_pnl.toFixed(0)}`;
        });
        setMessage(`✓ Expired worthless: ${bits.join(" | ")}`);
      }
      // Same-day after-close pending_confirmation list. Modal opens
      // automatically when non-empty AND the session flag isn't set
      // yet — see the render block at the bottom.
      const pending = json.expireReport?.pending_confirmation ?? [];
      setPendingConfirmation(pending);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load positions");
    } finally {
      if (live) setLiveLoading(false);
      else setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  // Soft dismiss — X button or Cancel. Closes the modal but keeps
  // rows so the banner stays visible and Refresh/Live can re-open.
  function softDismissModal() {
    setModalOpen(false);
  }

  // Persistent dismiss — only after a confirm round-trip. Sets the
  // session flag so Refresh/Live no longer auto-pops; the banner is
  // still the manual re-entry path while rows remain (e.g. partial
  // confirm with some rows unchecked).
  function permanentDismissModal() {
    setModalOpen(false);
    setPermanentlyDismissed(true);
    try {
      sessionStorage.setItem(LS_EXPIRE_MODAL_SHOWN, "1");
    } catch {
      /* ignore */
    }
  }

  async function confirmExpireWorthless(items: ConfirmItem[]) {
    // Single-action flow: the modal collects worthless / assigned /
    // create-stock intent per row, then this handler dispatches both
    // confirm-expire and (if any rows opted in) create-from-assignment
    // back-to-back. The user sees one Confirm click → one toast.
    try {
      const stockTargetIds = new Set(
        items.filter((i) => i.createStock && i.action === "assigned").map(
          (i) => i.positionId,
        ),
      );
      // Strip createStock from the payload — the server doesn't need
      // it; it's a client-side intent for the follow-up call.
      const apiItems = items.map((i) => ({
        positionId: i.positionId,
        action: i.action,
        stockPrice: i.stockPrice,
      }));

      const res = await fetch("/api/positions/confirm-expire", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: apiItems }),
        cache: "no-store",
      });
      const json = (await res.json()) as
        | {
            expiredCount: number;
            assignedCount: number;
            failedCount: number;
            totalRealizedPnl: number;
            assignments?: Array<{ positionId: string }>;
          }
        | { error: string };
      if (!res.ok || "error" in json) {
        const msg = "error" in json ? json.error : `HTTP ${res.status}`;
        setError(`Confirm expire failed: ${msg}`);
        return;
      }

      // Step 2 (chained): create stock positions for the rows the
      // user opted into. Filter to ids that actually became
      // assigned this round-trip — protects against race conditions
      // where assignment fails server-side.
      let stockSummary = "";
      const successfullyAssigned = new Set(
        (json.assignments ?? []).map((a) => a.positionId),
      );
      const toCreate = Array.from(stockTargetIds).filter((id) =>
        successfullyAssigned.has(id),
      );
      if (toCreate.length > 0) {
        try {
          const sres = await fetch("/api/positions/create-from-assignment", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              items: toCreate.map((id) => ({ assignedPositionId: id })),
            }),
            cache: "no-store",
          });
          const sjson = (await sres.json()) as {
            created_count?: number;
            skipped_count?: number;
            error?: string;
          };
          if (sres.ok && !sjson.error) {
            const c = sjson.created_count ?? 0;
            const sk = sjson.skipped_count ?? 0;
            stockSummary = ` · ${c} stock position${c === 1 ? "" : "s"} created${
              sk > 0 ? ` (${sk} skipped)` : ""
            }`;
          } else {
            stockSummary = ` · stock create failed: ${sjson.error ?? `HTTP ${sres.status}`}`;
          }
        } catch (e) {
          stockSummary = ` · stock create failed: ${e instanceof Error ? e.message : "network error"}`;
        }
      }

      const sign = json.totalRealizedPnl >= 0 ? "+" : "";
      const failedSuffix =
        json.failedCount > 0 ? ` · ${json.failedCount} failed` : "";
      const parts: string[] = [];
      if (json.expiredCount > 0)
        parts.push(`${json.expiredCount} expired worthless`);
      if (json.assignedCount > 0)
        parts.push(`${json.assignedCount} assigned`);
      const summary = parts.join(" · ") || "0 closed";
      setMessage(
        `✓ ${summary} · ${sign}$${json.totalRealizedPnl.toFixed(2)} P&L${failedSuffix}${stockSummary}`,
      );
    } catch (e) {
      setError(
        `Confirm expire failed: ${e instanceof Error ? e.message : "network error"}`,
      );
    } finally {
      // Persistent dismiss + refresh. Refresh recomputes the pending
      // list from the server; if the user partial-confirmed, leftover
      // rows feed the banner.
      permanentDismissModal();
      await load(false);
    }
  }

  const onImportSuccess = (msg: string) => {
    setMessage(msg);
    void load(false);
    // If the closed section is currently expanded, refresh it too —
    // closing a position moves it from open to closed.
    if (closedOpen) void loadClosed();
  };

  async function loadClosed() {
    setClosedLoading(true);
    try {
      const res = await fetch("/api/positions/closed", { cache: "no-store" });
      const json = (await res.json()) as {
        positions?: ClosedPositionClientView[];
        error?: string;
      };
      if (!res.ok || json.error) throw new Error(json.error ?? `HTTP ${res.status}`);
      setClosedPositions(json.positions ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load closed positions");
    } finally {
      setClosedLoading(false);
    }
  }

  async function toggleClosed() {
    const next = !closedOpen;
    setClosedOpen(next);
    if (next && closedPositions === null) await loadClosed();
  }

  const positions = data?.positions ?? [];
  const market = data?.market;
  const totalOpenContracts = positions.reduce(
    (sum, p) => sum + p.remainingContracts,
    0,
  );
  // Sum of unrealized P&L across BOTH option positions (live mark −
  // entry premium) and stock positions ((spot − cost basis) ×
  // shares). Stocks are required here so the top-line "Unrealized"
  // doesn't omit assigned-to-stock exposure.
  const optionsUnrealized = positions.reduce(
    (sum, p) => sum + (p.pnlDollars ?? 0),
    0,
  );
  const stockUnrealized = (data?.stockPositions ?? []).reduce(
    (sum, s) => sum + (s.pnlDollars ?? 0),
    0,
  );
  const unrealized = optionsUnrealized + stockUnrealized;
  // "Estimate" indicator on the Unrealized total. The sum still uses
  // the underlying pnlDollars values even when the per-row cell shows
  // "—" outside the regular session — but the total prefixes with ~
  // so the user knows it's an after-hours / intrinsic-fallback figure
  // rather than a live mark.
  const marketStateStr = data?.market?.marketState ?? null;
  const marketIsRegular = marketStateStr === "REGULAR";
  // Any non-REGULAR state is treated as stale for option-derived
  // fields. null means "unknown" — leave fields visible (transient
  // Yahoo failures shouldn't blank the page).
  const optionsStale = marketStateStr !== null && !marketIsRegular;
  const anyOptionEstimate = positions.some(
    (p) => p.pnlSource === "intrinsic" || p.pnlSource === "maxProfitOtm",
  );
  const unrealizedIsEstimate = optionsStale || anyOptionEstimate;
  const unrealizedPrefix = unrealizedIsEstimate ? "~" : "";
  // Max profit = total premium collected if every open position
  // expires worthless. Per position: avgPremiumSold × remainingContracts
  // × 100. Manually-added positions without fills carry avgPremiumSold=
  // null — exclude those from the sum and surface the count so the user
  // knows the headline number is missing some positions.
  const maxProfitContributors = positions.filter(
    (p) => p.avgPremiumSold !== null && Number.isFinite(p.avgPremiumSold),
  );
  const maxProfit = maxProfitContributors.reduce(
    (sum, p) => sum + (p.avgPremiumSold as number) * p.remainingContracts * 100,
    0,
  );
  const maxProfitMissing = positions.length - maxProfitContributors.length;

  const brokerGroups = groupByBroker(positions);
  const visibleBrokerGroups =
    brokerFilter === "all"
      ? brokerGroups
      : brokerGroups.filter((g) => g.key === brokerFilter);
  // Stocks bucketed by broker key — used to inject a "STOCK POSITIONS"
  // subsection inside each broker panel, and to render fallback panels
  // for any broker that has stocks but no options (orphan brokers).
  const stocksByBrokerKey = groupStocksByBroker(data?.stockPositions ?? []);
  const optionBrokerKeys = new Set(brokerGroups.map((g) => g.key));
  const orphanStockBrokers: Array<{ key: string; label: string; stocks: StockPositionRow[] }> = [];
  for (const [key, stocks] of Array.from(stocksByBrokerKey.entries())) {
    if (optionBrokerKeys.has(key)) continue;
    if (brokerFilter !== "all" && brokerFilter !== key) continue;
    orphanStockBrokers.push({
      key,
      label: BROKER_LABEL[key] ?? key,
      stocks,
    });
  }

  return (
    <div className="space-y-3">
      {/* ---------- Top stats panel ---------- */}
      <div className="rounded-lg border border-border bg-background/60 p-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1.5">
            <div className="font-mono text-xl font-semibold tracking-tight text-foreground tabular-nums sm:text-2xl">
              <span>{positions.length}</span>
              <span className="ml-2 text-base font-medium uppercase tracking-wider text-muted-foreground">
                {positions.length === 1 ? "position" : "positions"}
              </span>
              {totalOpenContracts > 0 && (
                <>
                  <span className="mx-3 text-muted-foreground/60">·</span>
                  <span>{totalOpenContracts}</span>
                  <span className="ml-2 text-base font-medium uppercase tracking-wider text-muted-foreground">
                    {totalOpenContracts === 1 ? "contract" : "contracts"}
                  </span>
                </>
              )}
            </div>
            <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1 text-sm">
              {positions.length > 0 && (
                <div>
                  <span className="text-muted-foreground">Max Profit </span>
                  <span className="font-mono text-base font-semibold text-emerald-300">
                    {maxProfitContributors.length > 0
                      ? fmtDollarsSigned(maxProfit)
                      : "—"}
                  </span>
                  {maxProfitMissing > 0 && (
                    <span className="ml-1 text-[10px] text-muted-foreground/70">
                      ({maxProfitMissing} excluded)
                    </span>
                  )}
                </div>
              )}
              {positions.length > 0 && (
                <div>
                  <span className="text-muted-foreground">Unrealized </span>
                  {(() => {
                    // Show the sum whenever any contributing row has a
                    // pnlDollars figure (live fetch OR cached from a
                    // prior Live refresh). The ~ prefix flags AH /
                    // intrinsic-estimate runs so the user knows the
                    // total isn't from a live mark.
                    const hasAnyPnl =
                      positions.some((p) => p.pnlDollars !== null) ||
                      (data?.stockPositions ?? []).some(
                        (s) => s.pnlDollars !== null,
                      );
                    if (!hasAnyPnl) {
                      return (
                        <span className="font-mono text-base font-semibold text-muted-foreground/70">
                          —
                        </span>
                      );
                    }
                    return (
                      <span
                        className={cn(
                          "font-mono text-base font-semibold",
                          unrealized >= 0 ? "text-emerald-300" : "text-rose-300",
                        )}
                        title={
                          unrealizedIsEstimate
                            ? "Unrealized total includes after-hours / intrinsic-value estimates — option marks aren't live outside the regular session"
                            : undefined
                        }
                      >
                        {unrealizedPrefix}
                        {fmtDollarsSigned(unrealized)}
                      </span>
                    );
                  })()}
                </div>
              )}
              {market && (
                <div>
                  <span className="text-muted-foreground">VIX </span>
                  <span className={cn("font-mono text-base font-semibold", regimeColor(market.regime))}>
                    {market.vix !== null ? market.vix.toFixed(2) : "—"}
                  </span>
                  {market.regime && (
                    <span className={cn("ml-1 text-xs", regimeColor(market.regime))}>
                      ({market.regime})
                    </span>
                  )}
                </div>
              )}
              {best && (
                <div className="text-muted-foreground">
                  Best: <span className="text-foreground">{best.symbol}</span>{" "}
                  <span className="text-xs">({best.recommendation})</span>
                </div>
              )}
            </div>
          </div>
          <div className="flex flex-col items-end gap-2">
            <div className="flex items-center gap-2">
              <div className="relative">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowUndo((v) => !v)}
                  className="text-xs text-muted-foreground hover:text-foreground"
                >
                  <Undo2 className="mr-1.5 h-3.5 w-3.5" />
                  Undo
                </Button>
                <UndoImportPopover
                  open={showUndo}
                  onClose={() => setShowUndo(false)}
                  onUndone={() => void load(false)}
                />
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowScreenshot(true)}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                <Camera className="mr-1.5 h-3.5 w-3.5" />
                Import
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowManual(true)}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                <Plus className="mr-1.5 h-3.5 w-3.5" />
                Add
              </Button>
              {/* Smart Refresh — fetches live Schwab marks during the
                  regular session, otherwise reloads from DB only (no
                  Schwab calls). marketState comes off the last
                  response; until we have one the button defaults to
                  the DB-only path so a first-open during AH doesn't
                  spam the Schwab API. */}
              <Button
                size="sm"
                onClick={() => load(marketStateStr === "REGULAR")}
                disabled={loading || liveLoading}
                title={
                  marketStateStr === "REGULAR"
                    ? "Fetch live Schwab marks + Yahoo spots"
                    : "Reload positions from DB (option chains are stale outside regular hours)"
                }
              >
                {loading || liveLoading ? (
                  <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
                ) : (
                  <RefreshCcw className="mr-1.5 h-3 w-3" />
                )}
                Refresh
              </Button>
            </div>
            {data && positions.length > 0 && (
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                <span>
                  {liveCacheFetchedAt
                    ? `Live data as of ${fmtTimeShort(liveCacheFetchedAt)}`
                    : "Live data not loaded"}
                  {liveSnapshotSummary && (
                    <>
                      {" · "}
                      {liveSnapshotSummary.written > 0
                        ? `${liveSnapshotSummary.written} snapshot${liveSnapshotSummary.written === 1 ? "" : "s"} saved`
                        : "snapshots up to date"}
                    </>
                  )}
                </span>
                {optionsStale && (
                  <span className="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 font-medium text-amber-200">
                    Market closed — P&amp;L available at open
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {pendingConfirmation.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span>
              {pendingConfirmation.length} position
              {pendingConfirmation.length === 1 ? "" : "s"} expired — review
              and confirm to mark as worthless.
            </span>
          </div>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setModalOpen(true)}
          >
            Review &amp; Confirm
          </Button>
        </div>
      )}

      <SchwabTokenBanner />

      {market?.warning && (
        <div
          className={`rounded-lg border px-3 py-2 text-xs ${
            market.regime === "panic"
              ? "border-rose-500/30 bg-rose-500/10 text-rose-200"
              : "border-amber-500/30 bg-amber-500/10 text-amber-200"
          }`}
        >
          <AlertTriangle className="mr-1.5 inline h-3 w-3" />
          {market.warning}
        </div>
      )}

      {message && (
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200">
          {message}
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
          <AlertTriangle className="mr-1.5 inline h-3 w-3" /> {error}
        </div>
      )}

      {/* ---------- Account filter tabs ---------- */}
      {brokerGroups.length > 1 && (
        <div className="flex flex-wrap items-center gap-1 rounded-md border border-border bg-background/40 p-1 text-xs font-semibold uppercase tracking-wide">
          <button
            type="button"
            onClick={() => setBrokerFilter("all")}
            className={cn(
              "rounded px-3 py-1 transition",
              brokerFilter === "all"
                ? "border border-foreground/30 bg-foreground/10 text-foreground"
                : "border border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            All
            <span className="ml-1.5 font-mono normal-case text-muted-foreground">
              {totalOpenContracts}
            </span>
          </button>
          {brokerGroups.map((g) => {
            const a = accentFor(g.key);
            const active = brokerFilter === g.key;
            return (
              <button
                key={g.key}
                type="button"
                onClick={() => setBrokerFilter(g.key)}
                className={cn(
                  "flex items-center gap-1.5 rounded px-3 py-1 transition",
                  active
                    ? cn("border", a.tabActive)
                    : "border border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                <span className={cn("h-1.5 w-1.5 rounded-full", a.dot)} />
                {g.label}
                <span className={cn("ml-0.5 font-mono normal-case", active ? "text-current" : "text-muted-foreground")}>
                  {g.contractCount}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {loading && !data && (
        <div className="flex items-center justify-center rounded-lg border border-border bg-background/40 px-6 py-12 text-sm text-muted-foreground">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading positions…
        </div>
      )}

      {!loading && positions.length === 0 && (
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border bg-background/40 px-6 py-12 text-center">
          <Briefcase className="mb-3 h-8 w-8 text-muted-foreground" />
          <div className="text-sm text-muted-foreground">
            No open positions. Import from a screenshot or log one manually.
          </div>
        </div>
      )}

      {/* ---------- Account panels ---------- */}
      {visibleBrokerGroups.map((group) => {
        const accent = accentFor(group.key);
        const stats = computeBrokerStats(group.items);
        return (
          <div
            key={group.key}
            className={cn(
              "overflow-hidden rounded-lg border",
              accent.panelBorder,
              accent.panelBg,
            )}
          >
            {/* Top accent stripe */}
            <div className={cn("h-0.5 w-full", accent.topBar)} />

            {/* Panel header */}
            <div className="flex flex-wrap items-center justify-between gap-3 px-3 py-2">
              <div className="flex items-baseline gap-3">
                <span className={cn("text-2xl font-bold uppercase tracking-wider", accent.text)}>
                  {group.label}
                </span>
                <span className="font-mono text-sm text-muted-foreground">
                  {group.contractCount} {group.contractCount === 1 ? "contract" : "contracts"}
                </span>
              </div>
              <div className="flex items-baseline gap-4 text-sm">
                <div>
                  <span className="text-muted-foreground">Max Profit </span>
                  <span className="font-mono font-semibold text-emerald-300">
                    {fmtDollarsSigned(stats.maxProfit)}
                  </span>
                  {stats.maxProfitMissing > 0 && (
                    <span className="ml-1 text-xs text-muted-foreground/70">
                      ({stats.maxProfitMissing} excluded)
                    </span>
                  )}
                </div>
                <div>
                  <span className="text-muted-foreground">Unrealized </span>
                  {stats.unrealizedAvailable ? (
                    <span
                      className={cn(
                        "font-mono font-semibold",
                        stats.unrealized >= 0 ? "text-emerald-300" : "text-rose-300",
                      )}
                      title={
                        unrealizedIsEstimate
                          ? "Unrealized total includes after-hours / intrinsic-value estimates — option marks aren't live outside the regular session"
                          : undefined
                      }
                    >
                      {unrealizedPrefix}
                      {fmtDollarsSigned(stats.unrealized)}
                    </span>
                  ) : (
                    <span className="font-mono text-muted-foreground/70">—</span>
                  )}
                </div>
              </div>
            </div>

            {/* Sticky column header — sticks to viewport top while
                scrolling past this panel; unsticks when the panel
                scrolls out. */}
            <div className="sticky top-0 z-10 border-y border-border/40 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
              <PositionsTableHeader sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
            </div>

            {/* Positions */}
            <div className="space-y-0.5 px-2 pb-2">
              {groupByTicker(group.items).map((tg) => (
                <div key={tg.symbol} className="space-y-1">
                  <TickerSubHeader
                    symbol={tg.symbol}
                    contractCount={tg.contractCount}
                    stockPrice={tg.stockPrice}
                    combinedPnl={tg.combinedPnl}
                  />
                  {sortPositions(tg.items, sortKey, sortDir).map((p) => (
                    <PositionCard
                      key={p.id}
                      kind="open"
                      position={p}
                      marketState={data?.market?.marketState ?? null}
                      onCloseSubmitted={onImportSuccess}
                      onPositionRemoved={(id) => {
                        // Optimistic remove — drop the row from local state so
                        // the UI updates instantly. We don't refetch; the next
                        // Refresh / page reload will reconcile against the DB.
                        setData((prev) =>
                          prev
                            ? {
                                ...prev,
                                positions: prev.positions.filter((q) => q.id !== id),
                              }
                            : prev,
                        );
                      }}
                    />
                  ))}
                </div>
              ))}
              <BrokerStockSubsection
                stocks={stocksByBrokerKey.get(group.key) ?? []}
                onSellShares={setSellTarget}
              />
            </div>
          </div>
        );
      })}

      {/* Orphan-broker stock panels — same panel chrome as the option
          panels but containing only the stock subsection. Renders for
          brokers that have assigned shares but no remaining options. */}
      {orphanStockBrokers.map((o) => {
        const accent = accentFor(o.key);
        const stockUnrealizedForBroker = o.stocks.reduce(
          (s, r) => s + (r.pnlDollars ?? 0),
          0,
        );
        const stockUnrealizedAvailable = o.stocks.some(
          (r) => r.pnlDollars !== null,
        );
        const totalShares = o.stocks.reduce((s, r) => s + r.shares, 0);
        return (
          <div
            key={`stocks-${o.key}`}
            className={cn(
              "overflow-hidden rounded-lg border",
              accent.panelBorder,
              accent.panelBg,
            )}
          >
            <div className={cn("h-0.5 w-full", accent.topBar)} />
            <div className="flex flex-wrap items-center justify-between gap-3 px-3 py-2">
              <div className="flex items-baseline gap-3">
                <span className={cn("text-2xl font-bold uppercase tracking-wider", accent.text)}>
                  {o.label}
                </span>
                <span className="font-mono text-sm text-muted-foreground">
                  {totalShares} {totalShares === 1 ? "share" : "shares"}
                </span>
              </div>
              <div className="flex items-baseline gap-4 text-sm">
                <div>
                  <span className="text-muted-foreground">Unrealized </span>
                  {stockUnrealizedAvailable ? (
                    <span
                      className={cn(
                        "font-mono font-semibold",
                        stockUnrealizedForBroker >= 0
                          ? "text-emerald-300"
                          : "text-rose-300",
                      )}
                    >
                      {fmtDollarsSigned(stockUnrealizedForBroker)}
                    </span>
                  ) : (
                    <span className="font-mono text-muted-foreground/70">—</span>
                  )}
                </div>
              </div>
            </div>
            <div className="space-y-0.5 px-2 pb-2">
              <BrokerStockSubsection
                stocks={o.stocks}
                onSellShares={setSellTarget}
              />
            </div>
          </div>
        );
      })}

      {/* Closed positions — collapsed by default, fetched lazily */}
      <div className="pt-4">
        <button
          type="button"
          onClick={toggleClosed}
          className="flex items-center gap-1 text-sm font-semibold text-muted-foreground hover:text-foreground"
        >
          {closedOpen ? (
            <ChevronDown className="h-4 w-4" />
          ) : (
            <ChevronRight className="h-4 w-4" />
          )}
          Closed positions
          {closedPositions !== null && (
            <span className="text-xs font-normal text-muted-foreground">
              ({closedPositions.length})
            </span>
          )}
        </button>
        {closedOpen && (
          <div className="mt-3 space-y-2">
            {closedLoading && !closedPositions && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" /> Loading closed positions…
              </div>
            )}
            {closedPositions?.length === 0 && (
              <div className="rounded-lg border border-border bg-background/40 px-3 py-4 text-sm text-muted-foreground">
                No closed positions yet.
              </div>
            )}
            {closedPositions !== null &&
              closedPositions.length > 0 &&
              groupByBroker(closedPositions)
                .filter((g) => brokerFilter === "all" || g.key === brokerFilter)
                .map((group) => {
                  const accent = accentFor(group.key);
                  return (
                    <div
                      key={group.key}
                      className={cn(
                        "overflow-hidden rounded-lg border",
                        accent.panelBorder,
                        accent.panelBg,
                      )}
                    >
                      <div className={cn("h-0.5 w-full", accent.topBar)} />
                      <div className="flex items-baseline justify-between gap-2 px-3 py-2">
                        <div className="flex items-baseline gap-3">
                          <span className={cn("text-2xl font-bold uppercase tracking-wider", accent.text)}>
                            {group.label}
                          </span>
                          <span className="font-mono text-sm text-muted-foreground">
                            {group.items.length} {group.items.length === 1 ? "position" : "positions"}
                          </span>
                        </div>
                      </div>
                      <div className="sticky top-0 z-10 border-y border-border/40 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
                        <PositionsTableHeader sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
                      </div>
                      <div className="space-y-0.5 px-2 pb-2">
                        {groupByTicker(group.items).map((tg) => (
                          <div key={tg.symbol} className="space-y-1">
                            <TickerSubHeader
                              symbol={tg.symbol}
                              contractCount={tg.contractCount}
                              stockPrice={tg.stockPrice}
                              combinedPnl={tg.combinedPnl}
                            />
                            {sortPositions(tg.items, sortKey, sortDir).map((p) => (
                              <PositionCard key={p.id} kind="closed" position={p} />
                            ))}
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
          </div>
        )}
      </div>

      <ImportScreenshotModal
        open={showScreenshot}
        onOpenChange={setShowScreenshot}
        onSuccess={onImportSuccess}
      />
      <ImportManualModal open={showManual} onOpenChange={setShowManual} onSuccess={onImportSuccess} />
      <SellSharesModal
        open={sellTarget !== null}
        target={sellTarget}
        onCancel={() => setSellTarget(null)}
        onConfirm={async (res) => {
          setSellTarget(null);
          if (res.ok) onImportSuccess(res.message);
        }}
      />
      <ExpireConfirmationModal
        open={modalOpen && pendingConfirmation.length > 0}
        rows={pendingConfirmation}
        onCancel={softDismissModal}
        onConfirm={confirmExpireWorthless}
      />
    </div>
  );
}

// "STOCK POSITIONS" subsection rendered inside a broker panel. Stocks
// live in the same `positions` table (position_type='stock_long' /
// 'stock_short'); the API splits them out so the options grid stays
// option-only. The grid here uses COLLAPSED_ROW_GRID so columns line
// up with the option rows above — column slots map as:
//   Strike  → Cost basis        (always visible, right-aligned)
//   Expiry  → Spot + AH/PM      (sm-only, right-aligned)
//   Qty     → ×shares           (always visible, right-aligned)
//   P&L     → P&L $             (always visible, right-aligned)
//   POP     → % change          (always visible, right-aligned)
//   % OTM   → empty             (sm-only)
//   IV      → empty             (sm-only)
//   Grade   → empty             (always visible)
//   Status  → GAIN / HOLD / LOSS (always visible, center)
function BrokerStockSubsection({
  stocks,
  onSellShares,
}: {
  stocks: StockPositionRow[];
  onSellShares: (target: SellSharesTarget) => void;
}) {
  if (stocks.length === 0) return null;
  // Group multiple lots of the same symbol into one ticker subheader,
  // mirroring the option ticker grouping. Combined P&L sums the lots
  // so the user sees the per-name exposure even when shares were
  // assigned across two transactions.
  const byTicker = new Map<string, StockPositionRow[]>();
  for (const s of stocks) {
    const arr = byTicker.get(s.symbol) ?? [];
    arr.push(s);
    byTicker.set(s.symbol, arr);
  }
  const tickerGroups = Array.from(byTicker.entries()).sort(([a], [b]) =>
    a.localeCompare(b),
  );

  return (
    <div className="space-y-1">
      {/* Inline divider with the section label, sitting between the
          option rows above and the stock rows below. */}
      <div className="flex items-center gap-2 px-2 pt-3 pb-1">
        <div className="h-px flex-1 bg-border/50" />
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Stock Positions
        </span>
        <div className="h-px flex-1 bg-border/50" />
      </div>
      {tickerGroups.map(([symbol, lots]) => (
        <StockTickerGroup
          key={symbol}
          symbol={symbol}
          lots={lots}
          onSellShares={onSellShares}
        />
      ))}
    </div>
  );
}

// Per-ticker group inside the stock subsection. Renders a TickerSubHeader-
// style summary, then one row per lot. Most assignments produce a single
// lot per ticker, so usually this collapses to "header + one row".
function StockTickerGroup({
  symbol,
  lots,
  onSellShares,
}: {
  symbol: string;
  lots: StockPositionRow[];
  onSellShares: (target: SellSharesTarget) => void;
}) {
  const totalShares = lots.reduce((s, r) => s + r.shares, 0);
  const liveLots = lots.filter((r) => r.pnlDollars !== null);
  const combinedPnl =
    liveLots.length > 0
      ? liveLots.reduce((s, r) => s + (r.pnlDollars ?? 0), 0)
      : null;
  // All lots should share a spot price (same symbol, same fetch); use
  // the first non-null. priceSource likewise.
  const spot =
    lots.find((r) => r.currentStockPrice !== null)?.currentStockPrice ?? null;
  const priceSource =
    lots.find((r) => r.priceSource !== null)?.priceSource ?? null;
  const pnlCls =
    combinedPnl === null
      ? "text-muted-foreground"
      : combinedPnl >= 0
        ? "text-emerald-300"
        : "text-rose-300";
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2 border-t border-border/40 px-3 pt-2 pb-0.5 text-sm first:border-t-0 first:pt-1">
        <div className="flex items-baseline gap-2">
          <span className="text-lg font-bold tracking-wide text-foreground">
            {symbol}
          </span>
          <span className="font-mono text-sm text-muted-foreground">
            {totalShares} {totalShares === 1 ? "share" : "shares"}
          </span>
          {spot !== null && (
            <span className="font-mono text-sm text-muted-foreground/80">
              · {fmtDollars(spot)}
              {priceSource === "post" ? " AH" : priceSource === "pre" ? " PM" : ""}
            </span>
          )}
        </div>
        <span className={cn("font-mono text-base font-semibold", pnlCls)}>
          {fmtDollarsSigned(combinedPnl)}
        </span>
      </div>
      {lots.map((r) => (
        <StockRow key={r.id} row={r} onSellShares={onSellShares} />
      ))}
    </div>
  );
}

function StockRow({
  row,
  onSellShares,
}: {
  row: StockPositionRow;
  onSellShares: (target: SellSharesTarget) => void;
}) {
  const pnl = row.pnlDollars;
  const pnlColor =
    pnl === null
      ? "text-muted-foreground"
      : pnl >= 0
        ? "text-emerald-300"
        : "text-rose-300";
  const pctColor =
    row.pnlPct === null
      ? "text-muted-foreground"
      : row.pnlPct >= 0
        ? "text-emerald-300"
        : "text-rose-300";
  const dotColor =
    pnl === null
      ? "bg-muted-foreground/40"
      : pnl >= 0
        ? "bg-emerald-400"
        : "bg-rose-400";
  const sourceTag =
    row.priceSource === "post" ? (
      <span className="ml-1 rounded bg-amber-500/15 px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-amber-300">
        AH
      </span>
    ) : row.priceSource === "pre" ? (
      <span className="ml-1 rounded bg-sky-500/15 px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-sky-300">
        PM
      </span>
    ) : null;
  const status = stockStatusBadge(row.pnlPct);
  const shareLabel = row.positionType === "stock_short" ? "shrt" : null;
  return (
    <div
      className={cn(
        COLLAPSED_ROW_GRID,
        "rounded border border-border/40 bg-background/30 py-1.5",
      )}
    >
      {/* col 1 — dot */}
      <div className="flex items-center justify-center">
        <span className={cn("h-2 w-2 rounded-full", dotColor)} />
      </div>
      {/* col 2 — Cost basis (Strike slot) */}
      <div className="text-right font-mono text-foreground">
        {row.costBasis !== null ? `$${row.costBasis.toFixed(2)}` : "—"}
      </div>
      {/* col 3 — Spot (Expiry slot, sm only) */}
      <div className="hidden text-right font-mono text-foreground sm:block">
        {row.currentStockPrice !== null
          ? `$${row.currentStockPrice.toFixed(2)}`
          : "—"}
        {sourceTag}
      </div>
      {/* col 4 — Shares (Qty slot) */}
      <div className="text-right font-mono text-foreground">
        ×{row.shares}
        {shareLabel ? (
          <span className="ml-1 text-[10px] uppercase text-muted-foreground">
            {shareLabel}
          </span>
        ) : null}
      </div>
      {/* col 5 — Premium slot (stocks have no option premium) */}
      <div className="hidden sm:block" />
      {/* col 6 — Mark slot (stocks have no option mark) */}
      <div className="hidden sm:block" />
      {/* col 7 — P&L */}
      <div className={cn("text-right font-mono font-semibold", pnlColor)}>
        {pnl !== null ? fmtDollarsSigned(pnl) : "—"}
      </div>
      {/* col 6 — % change (POP slot) */}
      <div className={cn("text-right font-mono", pctColor)}>
        {row.pnlPct !== null
          ? `${row.pnlPct >= 0 ? "+" : ""}${row.pnlPct.toFixed(2)}%`
          : "—"}
      </div>
      {/* col 7 — empty (% OTM slot, sm only) */}
      <div className="hidden sm:block" />
      {/* col 8 — empty (IV slot, sm only) */}
      <div className="hidden sm:block" />
      {/* col 9 — Sell button (Grade slot). Stock_short rows can't be
          closed via the sell-shares path yet (this builds the long
          side only), so the button is gated. */}
      <div className="flex items-center justify-center">
        {row.positionType === "stock_long" && (
          <button
            type="button"
            onClick={() =>
              onSellShares({
                positionId: row.id,
                symbol: row.symbol,
                broker: row.broker,
                totalShares: row.shares,
                costBasis: row.costBasis,
              })
            }
            className="rounded border border-border/60 bg-background/60 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground hover:border-foreground/40 hover:text-foreground"
          >
            Sell
          </button>
        )}
      </div>
      {/* col 10 — Status badge */}
      <div className="flex items-center justify-center">
        <span
          className={cn(
            "rounded border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider",
            status.className,
          )}
        >
          {status.label}
        </span>
      </div>
    </div>
  );
}

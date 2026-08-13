"use client";

// Shared UI + data-fetching for the Intelligence pages. Each sub-page
// (performance, efficiency, patterns) owns its own date-range + broker
// state and renders the section it needs. This file exports:
//   - Types: DateRange, BrokerFilter, IntelligenceResponse, TickerRanking,
//     PatternBucket, EquityPoint, PresetKey
//   - Helpers: fmtMoney, fmtPct, gradeColor, winRateColor, PRESET_OPTIONS,
//     BROKER_OPTIONS, presetToRange
//   - Hook: useIntelligenceData
//   - Controls: DateRangeControls, BrokerControl
//   - Sections: PerformanceSection, TickerRankingsSection,
//     PatternIntelligenceSection, ExportSection
//   - Shell: IntelligencePageShell

import { useEffect, useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  BarElement,
  CategoryScale,
  Chart as ChartJS,
  LinearScale,
  Tooltip as ChartJsTooltip,
  type ChartData,
  type ChartOptions,
  type TooltipItem,
} from "chart.js";
import { Bar as ChartJsBar } from "react-chartjs-2";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { BROKER_ORDER, BROKER_LABEL, type BrokerKey } from "@/lib/brokers";

ChartJS.register(CategoryScale, LinearScale, BarElement, ChartJsTooltip);

export type DateRange = { from: string; to: string };

// Preset keys for the date-range row. "custom" triggers the inline
// date picker. Everything else resolves to a concrete range via
// presetToRange() evaluated against "today".
export type PresetKey =
  | "today"
  | "week"
  | "month"
  | "last_month"
  | "last_quarter"
  | "ytd"
  | "all";

// Derived from lib/brokers.ts's BROKER_ORDER so new accounts (e.g.
// covered_calls) appear here automatically instead of needing a
// second, easy-to-forget edit.
export type BrokerFilter = "all" | BrokerKey;

export type Granularity = "day" | "week" | "month";

export type EquityPoint = {
  bucketKey: string;
  label: string;
  tradePnl: number;
  cumulativePnl: number;
  tradeCount: number;
  trades: Array<{ symbol: string; pnl: number }>;
};

export type TickerRanking = {
  symbol: string;
  trades: number;
  wins: number;
  win_rate: number;
  avg_roc: number | null;
  best_roc: number | null;
  top_grade: string | null;
  rec_aligned: number | null;
  rec_total: number | null;
  // ALL recs for the ticker incl. unscored (DATA_GATE / MONITOR) —
  // lets the UI distinguish "engine has fired, outcomes pending" from
  // "no recommendations at all".
  rec_count: number | null;
  closed_trades: Array<{
    opened_date: string;
    closed_date: string | null;
    avg_premium_sold: number | null;
    realized_pnl: number | null;
    roc: number | null;
    grade: string | null;
  }>;
};

export type PatternBucket = {
  key: string;
  trades: number;
  wins: number;
  win_rate: number;
  avg_roc: number | null;
};

export type PartialClose = {
  positionId: string;
  symbol: string;
  strike: number;
  broker: string | null;
  positionType: "option" | "stock_long" | "stock_short";
  realizedPnl: number;
  remainingContracts: number;
  updatedAt: string;
};

export type EmCalibrationRow = {
  symbol: string;
  events: number;
  avg_ratio: number;
  within_implied_pct: number;
  avg_implied_pct: number;
  avg_actual_pct: number;
  last_event: string;
  traded: boolean;
};

export type TickerPnl = {
  symbol: string;
  optionsNet: number;
  stockNet: number;
  totalNet: number;
  // Campaigns fully contained in this window — winRate is scored only
  // across these (see spanningCampaigns for why).
  campaignCount: number;
  winRate: number | null;
  // Campaigns touching this ticker in-window whose full history
  // extends outside it — their windowed contribution to this bar and
  // their true all-time outcome can disagree (even in sign), so they're
  // flagged instead of folded into winRate.
  spanningCampaigns: Array<{ allTimeNet: number }>;
};

export type PairedAssignment = {
  symbol: string;
  broker: string | null;
  parent: {
    positionId: string;
    strike: number;
    expiry: string;
    contracts: number;
    avgPremiumSold: number | null;
    premiumCollected: number;
    realizedPnl: number;
    closedDate: string | null;
  } | null;
  stock: {
    positionId: string;
    shares: number;
    costBasis: number | null;
    realizedPnl: number;
    closedDate: string | null;
  };
  totalPnl: number;
};

export type IntelligenceResponse = {
  date_range: DateRange;
  broker: string;
  granularity: Granularity;
  stats: {
    total_pnl: number;
    stock_total_pnl: number;
    combined_realized_pnl: number;
    win_rate: number;
    wins: number;
    total_trades: number;
    avg_roc: number;
    expectancy: number;
    best_trade: { symbol: string; pnl: number; roc: number | null } | null;
    worst_trade: { symbol: string; pnl: number; roc: number | null } | null;
    unresolved_campaigns: {
      count: number;
      pnl: number;
      all_time_count: number;
      all_time_pnl: number;
    };
  };
  equity_curve: EquityPoint[];
  // Total-mode series — same bucketing as equity_curve, but includes
  // still-open positions' already-banked partial-close fills on their
  // own fill_date. equity_curve itself stays resolved-trades-only.
  equity_curve_total?: EquityPoint[];
  // Slice of total_partial_pnl (below) whose contributing fills fall
  // inside the current date_range — already reflected in
  // equity_curve_total's dated buckets. Used to avoid double-counting
  // that slice again in the "Now" point's snapshot.
  partial_close_pnl_in_window?: number;
  em_calibration: EmCalibrationRow[];
  paired_assignments: PairedAssignment[];
  partial_closes?: PartialClose[];
  total_partial_pnl?: number;
  ticker_pnl?: TickerPnl[];
  ticker_rankings: TickerRanking[];
  patterns: {
    enabled: boolean;
    total_closed: number;
    by_grade: PatternBucket[];
    by_day_of_week: PatternBucket[];
    by_vix_regime: PatternBucket[];
    by_dte: PatternBucket[];
    by_industry: PatternBucket[];
    calibration: { drift: boolean; summary: string };
    rec_accuracy: {
      close_correct: number;
      close_total: number;
      hold_correct: number;
      hold_total: number;
      overall_pct: number;
    } | null;
  };
  export_payload: unknown;
};

export const PRESET_OPTIONS: Array<{ value: PresetKey; label: string }> = [
  { value: "today", label: "Today" },
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
  { value: "last_month", label: "Last Month" },
  { value: "last_quarter", label: "Quarter" },
  { value: "ytd", label: "YTD" },
  { value: "all", label: "All Time" },
];

export const BROKER_OPTIONS: Array<{ value: BrokerFilter; label: string }> = [
  { value: "all", label: "All" },
  ...BROKER_ORDER.map((key) => ({ value: key, label: BROKER_LABEL[key] })),
];

// -------- Date helpers --------
// All date math uses UTC to match how the API parses ISO strings.

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function startOfWeekMonday(d: Date): Date {
  const out = new Date(d);
  const day = out.getUTCDay();
  const mondayOffset = (day + 6) % 7; // Sun=0 -> 6, Mon=1 -> 0, ...
  out.setUTCDate(out.getUTCDate() - mondayOffset);
  return out;
}

function startOfMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

function endOfMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
}

function startOfQuarter(d: Date): Date {
  const q = Math.floor(d.getUTCMonth() / 3);
  return new Date(Date.UTC(d.getUTCFullYear(), q * 3, 1));
}

function endOfQuarter(d: Date): Date {
  const q = Math.floor(d.getUTCMonth() / 3);
  return new Date(Date.UTC(d.getUTCFullYear(), q * 3 + 3, 0));
}

export function presetToRange(key: PresetKey, today: Date = new Date()): DateRange {
  const t = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const todayStr = iso(t);
  if (key === "today") return { from: todayStr, to: todayStr };
  if (key === "week") return { from: iso(startOfWeekMonday(t)), to: todayStr };
  if (key === "month") return { from: iso(startOfMonth(t)), to: todayStr };
  if (key === "last_month") {
    const lastMonth = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() - 1, 15));
    return { from: iso(startOfMonth(lastMonth)), to: iso(endOfMonth(lastMonth)) };
  }
  if (key === "last_quarter") {
    // Despite the legacy key name "last_quarter", this preset now
    // resolves to the CURRENT calendar quarter (label has always
    // read "Quarter"). The old "previous quarter" behavior was
    // misleading: clicking "Quarter" in May surfaced Jan–Mar.
    return { from: iso(startOfQuarter(t)), to: iso(endOfQuarter(t)) };
  }
  if (key === "ytd") {
    return { from: `${t.getUTCFullYear()}-01-01`, to: todayStr };
  }
  // key === "all"
  return { from: "2020-01-01", to: todayStr };
}

// Which named preset (if any) produced this exact range — matches by
// recomputing each preset's range against "now" and comparing. Returns
// null for a manually-typed/custom range that doesn't match any
// preset. Shared by DateRangeControls (button highlighting) and the
// equity-curve tooltip (per-fill vs. consolidated-by-symbol decision)
// so the two can't disagree about which preset is active.
export function presetForRange(range: DateRange): PresetKey | null {
  for (const p of PRESET_OPTIONS) {
    const r = presetToRange(p.value);
    if (r.from === range.from && r.to === range.to) return p.value;
  }
  return null;
}

// -------- Formatters + color helpers --------

// signed: prefix a "+" on positive values (negatives always get "-").
// autoDecimals: show cents only when the value actually has them
// ($175 instead of $175.00, but $175.50 keeps the .50) — for precise
// readouts like tooltips, as opposed to fmtMoneyAxis's always-whole-
// dollar scale markers.
export function fmtMoney(
  n: number | null | undefined,
  signed = false,
  autoDecimals = false,
): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const isNeg = n < 0;
  const abs = Math.abs(n);
  const sign = isNeg ? "-" : signed && n > 0 ? "+" : "";
  const hasCents = autoDecimals && Math.round(abs * 100) % 100 !== 0;
  const formatted = abs.toLocaleString("en-US", {
    minimumFractionDigits: autoDecimals ? (hasCents ? 2 : 0) : 2,
    maximumFractionDigits: 2,
  });
  return `${sign}$${formatted}`;
}

// Axis scale markers: whole dollars only, sign before the symbol,
// thousands separator, never decimals — "-$4,000 / $0 / $3,000".
export function fmtMoneyAxis(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const isNeg = n < 0;
  const rounded = Math.round(Math.abs(n));
  return `${isNeg ? "-" : ""}$${rounded.toLocaleString("en-US")}`;
}

export function fmtPct(n: number | null | undefined, digits = 0): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return `${(n * 100).toFixed(digits)}%`;
}

export function gradeColor(g: string | null): string {
  if (g === "A") return "bg-emerald-500/20 text-emerald-300 border-emerald-500/40";
  if (g === "B") return "bg-sky-500/20 text-sky-300 border-sky-500/40";
  if (g === "C") return "bg-amber-500/20 text-amber-300 border-amber-500/40";
  if (g === "F") return "bg-rose-500/20 text-rose-300 border-rose-500/40";
  return "bg-muted/40 text-muted-foreground border-border";
}

export function winRateColor(r: number): string {
  if (r >= 0.7) return "text-emerald-300";
  if (r >= 0.5) return "text-amber-300";
  return "text-rose-300";
}

// -------- Data loader --------

export function useIntelligenceData(
  range: DateRange,
  broker: BrokerFilter,
): {
  data: IntelligenceResponse | null;
  loading: boolean;
  error: string | null;
} {
  const [data, setData] = useState<IntelligenceResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({
          from: range.from,
          to: range.to,
          broker,
        });
        const res = await fetch(`/api/intelligence?${params.toString()}`, {
          cache: "no-store",
        });
        const json = (await res.json()) as IntelligenceResponse | { error: string };
        if (!res.ok) throw new Error((json as { error?: string }).error ?? `HTTP ${res.status}`);
        if (!cancelled) setData(json as IntelligenceResponse);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "load failed");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [range.from, range.to, broker]);

  return { data, loading, error };
}

// -------- Shared controls --------

export function DateRangeControls({
  range,
  onRangeChange,
  broker,
  onBrokerChange,
}: {
  range: DateRange;
  onRangeChange: (r: DateRange) => void;
  broker: BrokerFilter;
  onBrokerChange: (b: BrokerFilter) => void;
}) {
  // Local state for the date inputs so a partial/invalid date (mid-typing)
  // doesn't spam fetches. Apply commits; preset clicks bypass this entirely.
  const [draftFrom, setDraftFrom] = useState(range.from);
  const [draftTo, setDraftTo] = useState(range.to);

  useEffect(() => {
    setDraftFrom(range.from);
    setDraftTo(range.to);
  }, [range.from, range.to]);

  // Derive the active preset by matching the current range against each
  // preset's computed range. If nothing matches (manual edit), no preset
  // is highlighted.
  const activePreset = useMemo<PresetKey | null>(() => presetForRange(range), [range]);

  function pickPreset(key: PresetKey) {
    onRangeChange(presetToRange(key));
  }

  const applyDisabled =
    !draftFrom ||
    !draftTo ||
    draftFrom > draftTo ||
    (draftFrom === range.from && draftTo === range.to);

  function applyDraft() {
    if (applyDisabled) return;
    onRangeChange({ from: draftFrom, to: draftTo });
  }

  const pillBase = "rounded px-2 py-1 text-sm";
  const pillActive = "bg-foreground text-background";
  const pillInactive =
    "border border-border text-muted-foreground hover:text-foreground";
  const divider = "mx-3 self-stretch border-r border-white/10";

  return (
    <div className="flex flex-wrap items-center gap-x-1 gap-y-2 text-sm">
      {/* Group 1: manual dates */}
      <label className="flex items-center gap-1">
        <span className="text-muted-foreground">From</span>
        <input
          type="date"
          value={draftFrom}
          onChange={(e) => setDraftFrom(e.target.value)}
          className="rounded border border-border bg-background px-2 py-1 text-sm"
        />
      </label>
      <label className="flex items-center gap-1">
        <span className="text-muted-foreground">To</span>
        <input
          type="date"
          value={draftTo}
          onChange={(e) => setDraftTo(e.target.value)}
          className="rounded border border-border bg-background px-2 py-1 text-sm"
        />
      </label>
      <button
        type="button"
        onClick={applyDraft}
        disabled={applyDisabled}
        className="rounded bg-foreground px-2 py-1 text-sm text-background disabled:cursor-not-allowed disabled:opacity-50"
      >
        Apply
      </button>

      <div className={divider} aria-hidden />

      {/* Group 2: presets */}
      {PRESET_OPTIONS.map((p) => (
        <button
          key={p.value}
          type="button"
          onClick={() => pickPreset(p.value)}
          className={`${pillBase} ${activePreset === p.value ? pillActive : pillInactive}`}
        >
          {p.label}
        </button>
      ))}

      <div className={divider} aria-hidden />

      {/* Group 3: broker */}
      {BROKER_OPTIONS.map((b) => (
        <button
          key={b.value}
          type="button"
          onClick={() => onBrokerChange(b.value)}
          className={`${pillBase} ${broker === b.value ? pillActive : pillInactive}`}
        >
          {b.label}
        </button>
      ))}
    </div>
  );
}

// ================== Section 1: Performance ==================

export function PerformanceSection({
  data,
  broker = "all",
}: {
  data: IntelligenceResponse;
  // Mirrors the realized-side broker filter so the Total mode's
  // unrealized sub-line and headline only count open positions that
  // match the active tab. Defaults to 'all' for back-compat with any
  // caller that hasn't been updated yet.
  broker?: BrokerFilter;
}) {
  const { stats, equity_curve } = data;
  // Drives the equity-curve tooltip's per-fill-vs-consolidated-by-
  // symbol decision. Named presets decide it directly — Today/Week
  // always stay per-fill, Month/Quarter/YTD/All Time always
  // consolidate — rather than going through a day-count threshold,
  // because "Month" resolves to month-TO-DATE (start of month through
  // today): early in a month that can be under a week wide, which
  // would otherwise wrongly fall through to per-fill on, say, the 3rd
  // of the month. A genuinely custom range (no matching preset) falls
  // back to the day-count rule, exactly as specified for "any custom
  // range beyond 7 days".
  const activePreset = presetForRange(data.date_range);
  const windowDays = Math.floor(
    (Date.parse(data.date_range.to + "T00:00:00Z") -
      Date.parse(data.date_range.from + "T00:00:00Z")) /
      86400000,
  );
  const shouldConsolidateTooltip =
    activePreset === "today" || activePreset === "week"
      ? false
      : activePreset !== null
        ? true
        : windowDays > TOOLTIP_CONSOLIDATE_THRESHOLD_DAYS;
  // Combined headline = options + closed stocks; per-component
  // colors track their own sign. The fallback handles older API
  // responses that didn't carry the combined fields.
  const combinedRealized =
    stats.combined_realized_pnl ?? stats.total_pnl ?? 0;
  const stockRealized = stats.stock_total_pnl ?? 0;
  const optionRealized = stats.total_pnl ?? 0;
  const pnlColor = combinedRealized >= 0 ? "text-emerald-300" : "text-rose-300";
  const optionColor = optionRealized >= 0 ? "text-emerald-300" : "text-rose-300";
  const stockColor = stockRealized >= 0 ? "text-emerald-300" : "text-rose-300";

  // Equity curve mode. 'realized' (default) plots cumulative
  // realized P&L exactly as before. 'total' fetches today's open
  // positions (options + stocks), sums unrealized, and appends a
  // "Now" point to the curve so the user sees realized + mark-to-
  // market exposure on one chart. Fetched once per toggle to total.
  const [mode, setMode] = useState<"realized" | "total">("realized");
  const [unrealized, setUnrealized] = useState<{
    optionsUnrealized: number;
    stockUnrealized: number;
    optionsCount: number;
    stockCount: number;
    positionLines: Array<{ label: string; pnl: number }>;
    // Full premium banked if every open option expires worthless —
    // options only (avgPremiumSold has no equivalent for stock legs),
    // same definition Positions' own Max Profit stat uses
    // (components/positions-view.tsx computeBrokerStats). Remaining =
    // this minus optionsUnrealized: what's still at stake, not yet
    // captured. A hypothetical ceiling, never added into any total.
    maxProfit: number;
    maxProfitMissing: number;
    noMarkCount: number;
  } | null>(null);
  const [unrealizedLoading, setUnrealizedLoading] = useState(false);
  const [unrealizedError, setUnrealizedError] = useState<string | null>(null);

  useEffect(() => {
    if (mode !== "total" || unrealized !== null) return;
    let cancelled = false;
    setUnrealizedLoading(true);
    setUnrealizedError(null);
    void (async () => {
      try {
        // Smart fetch — only force live=true during the regular
        // session. Outside regular hours the Schwab chain returns
        // last-traded marks that are hours stale; pulling those
        // would make Performance disagree with the Positions page
        // (which already gates Schwab fetches on marketState).
        // Step 1 fetches live=false to learn the current marketState
        // cheaply (no Schwab calls); step 2 only refetches with
        // live=true if we're inside regular hours.
        const baseRes = await fetch("/api/positions/open?live=false", {
          cache: "no-store",
        });
        const baseJson = (await baseRes.json()) as {
          positions?: Array<{
            id: string;
            symbol: string;
            strike: number;
            optionType: "put" | "call";
            broker: string;
            direction?: "long" | "short";
            remainingContracts: number;
            avgPremiumSold: number | null;
            currentMark: number | null;
            pnlDollars: number | null;
          }>;
          stockPositions?: Array<{
            symbol: string;
            broker: string;
            shares: number;
            pnlDollars: number | null;
          }>;
          market?: { marketState?: string | null };
          error?: string;
        };
        if (cancelled) return;
        if (!baseRes.ok || baseJson.error) {
          throw new Error(baseJson.error ?? `HTTP ${baseRes.status}`);
        }
        const marketState = baseJson.market?.marketState ?? null;
        const isRegular = marketState === "REGULAR";

        type Opt = {
          id: string;
          symbol: string;
          strike: number;
          optionType: "put" | "call";
          broker: string;
          direction?: "long" | "short";
          remainingContracts: number;
          avgPremiumSold: number | null;
          currentMark: number | null;
          pnlDollars: number | null;
        };
        type Stock = {
          symbol: string;
          broker: string;
          shares: number;
          pnlDollars: number | null;
        };
        let opts: Opt[] = baseJson.positions ?? [];
        let stocks: Stock[] = baseJson.stockPositions ?? [];

        if (isRegular) {
          const liveRes = await fetch("/api/positions/open?live=true", {
            cache: "no-store",
          });
          const liveJson = (await liveRes.json()) as {
            positions?: Opt[];
            stockPositions?: Stock[];
            error?: string;
          };
          if (!cancelled && liveRes.ok && !liveJson.error) {
            opts = liveJson.positions ?? opts;
            stocks = liveJson.stockPositions ?? stocks;
          }
        }

        // Apply the broker filter client-side. The route doesn't take
        // a ?broker= param (it always returns every account so the
        // Positions page can render the broker subsections), so we
        // narrow here to match the realized-side broker tab.
        if (broker !== "all") {
          opts = opts.filter((o) => (o.broker ?? "").toLowerCase() === broker);
          stocks = stocks.filter(
            (s) => (s.broker ?? "").toLowerCase() === broker,
          );
        }

        // Outside regular hours, fall back to the Positions page's
        // localStorage live cache for any option pnlDollars the
        // live=false response left null. This is the canonical
        // "what is the Positions page showing right now" value —
        // the cache is rewritten on every REGULAR-session live
        // refresh and stays put outside regular hours. Matches the
        // Positions page exactly when both are open.
        if (!isRegular) {
          try {
            const raw = localStorage.getItem("positions_live_cache");
            if (raw) {
              const parsed = JSON.parse(raw) as {
                byId?: Record<string, { pnlDollars?: number | null }>;
              };
              const byId = parsed?.byId ?? {};
              opts = opts.map((o) => {
                if (o.pnlDollars !== null) return o;
                const cached = byId[o.id]?.pnlDollars;
                return cached !== undefined && cached !== null
                  ? { ...o, pnlDollars: cached }
                  : o;
              });
            }
          } catch {
            /* cache unavailable — leave pnlDollars as the route returned */
          }
        }

        // After-hours manual-mark overrides — written by the position
        // card's inline Mark input. When the route returned a null
        // currentMark (chain stale), pull the user's typed mark from
        // localStorage and recompute unrealized exactly the same way
        // the row does: short ⇒ (avg − manual) × N × 100, long ⇒ the
        // sign-flipped equivalent. Wins over any intrinsic/maxProfit
        // fallback pnlDollars the route may have returned, because the
        // typed mark is the freshest signal the user has.
        if (!isRegular) {
          try {
            opts = opts.map((o) => {
              if (o.currentMark !== null) return o;
              if (o.avgPremiumSold === null) return o;
              const raw = localStorage.getItem(`manual_mark_${o.id}`);
              if (!raw) return o;
              const manual = Number(raw);
              if (!Number.isFinite(manual) || manual < 0) return o;
              const dir = o.direction === "long" ? "long" : "short";
              const pnl =
                (dir === "long"
                  ? manual - o.avgPremiumSold
                  : o.avgPremiumSold - manual) *
                o.remainingContracts *
                100;
              return { ...o, pnlDollars: pnl };
            });
          } catch {
            /* localStorage unavailable — fall through to existing pnl */
          }
        }

        const positionLines: Array<{ label: string; pnl: number }> = [
          ...opts.map((o) => ({
            label: `${o.symbol} $${o.strike}${o.optionType === "put" ? "P" : "C"} ×${o.remainingContracts}`,
            pnl: o.pnlDollars ?? 0,
          })),
          ...stocks.map((s) => ({
            label: `${s.symbol} stock ×${s.shares}`,
            pnl: s.pnlDollars ?? 0,
          })),
        ];
        setUnrealized({
          optionsUnrealized: opts.reduce(
            (s, p) => s + (p.pnlDollars ?? 0),
            0,
          ),
          stockUnrealized: stocks.reduce(
            (s, p) => s + (p.pnlDollars ?? 0),
            0,
          ),
          optionsCount: opts.length,
          stockCount: stocks.length,
          positionLines,
          maxProfit: opts.reduce(
            (s, p) =>
              s + (p.avgPremiumSold !== null ? p.avgPremiumSold * p.remainingContracts * 100 : 0),
            0,
          ),
          maxProfitMissing: opts.filter((p) => p.avgPremiumSold === null).length,
          noMarkCount: opts.filter((p) => p.pnlDollars === null).length,
        });
      } catch (e) {
        if (!cancelled) {
          setUnrealizedError(
            e instanceof Error ? e.message : "Failed to fetch open positions",
          );
        }
      } finally {
        if (!cancelled) setUnrealizedLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mode, unrealized, broker]);

  // Reset the cached unrealized sum whenever the broker tab flips so
  // the effect above re-runs against the new filter rather than
  // re-using the previous broker's totals.
  useEffect(() => {
    setUnrealized(null);
  }, [broker]);

  const totalUnrealized = unrealized
    ? unrealized.optionsUnrealized + unrealized.stockUnrealized
    : 0;
  // What's still at stake on open options if every one of them expires
  // worthless: the full premium (maxProfit) minus what's already been
  // captured (optionsUnrealized). A hypothetical ceiling, not a
  // position value — deliberately never folded into grandTotal below.
  // null (not 0) while marks haven't loaded yet, so the headline
  // doesn't flash a false "$0 remaining" before the fetch resolves.
  const remaining = unrealized ? unrealized.maxProfit - unrealized.optionsUnrealized : null;
  // Money already banked by closing SOME contracts of a position that's
  // still open overall (e.g. 2 of 4 puts bought back at a gain, 2 still
  // live). realized_pnl accrues on the position row as soon as those
  // fills land, but the position's status stays "open" until every
  // contract is closed — so this cash sat in neither Realized (filtered
  // to closed/expired/assigned) nor Unrealized (marks only the
  // `remaining` open contracts) until now. Server-computed in
  // /api/intelligence from the same partial_closes rows the panel below
  // renders, so the two can never disagree. Deliberately NOT date-
  // windowed (mirrors totalUnrealized) — this is current standing, not
  // a historical bucket.
  const totalPartialClosePnl = data.total_partial_pnl ?? 0;
  const partialClosePositionLines = (data.partial_closes ?? [])
    .filter((p) => p.realizedPnl !== 0)
    .map((p) => {
      const isStock =
        p.positionType === "stock_long" || p.positionType === "stock_short";
      const unit = isStock ? "shares" : "contracts";
      // PartialClose has no put/call field (matches PartialClosesPanel's
      // own label below, which has the same gap) — "P" is a known
      // simplification, not new to this change.
      const label = isStock
        ? `${p.symbol} stock ×${p.remainingContracts} ${unit} left (banked)`
        : `${p.symbol} $${p.strike}P ×${p.remainingContracts} ${unit} left (banked)`;
      return { label, pnl: p.realizedPnl };
    });
  // Total mode's own equity series — same historical bucketing as
  // equity_curve, but still-open positions' banked partial-close fills
  // land on their own fill_date instead of being invisible until the
  // position fully resolves. equity_curve (Realized) is untouched by
  // design — it must keep matching combined_realized_pnl exactly, the
  // same "resolved trades only" scope as win_rate/ROC/expectancy.
  // Falls back to equity_curve for any API response predating this
  // field (mid-deploy race), which just means Total briefly looks like
  // Realized rather than erroring.
  const equityCurveTotal = data.equity_curve_total ?? equity_curve;
  const baseCurve = mode === "total" ? equityCurveTotal : equity_curve;
  // The slice of totalPartialClosePnl whose fills already landed in
  // equityCurveTotal's dated buckets (fill_date inside the current
  // window). Only the LEFTOVER — banked money whose fill happened
  // outside the window, or when the server response predates this
  // field — still needs adding at the "Now" point. Without this
  // subtraction, in-window banked money would count twice: once on its
  // real date, once again in the snapshot.
  const partialClosePnlInWindow = data.partial_close_pnl_in_window ?? 0;
  const partialCloseLeftoverForNow = totalPartialClosePnl - partialClosePnlInWindow;
  const lastCumulative =
    baseCurve.length > 0 ? baseCurve[baseCurve.length - 1].cumulativePnl : 0;
  // Two different deltas on purpose. The StatCard headline (grandTotal
  // below) is a single "current standing" snapshot — it always wants
  // the FULL banked amount, regardless of how the curve happens to
  // slice it across dates. The curve's synthetic "Now" point instead
  // wants only the LEFTOVER (nowPointDelta) — the in-window portion is
  // already sitting in one of baseCurve's earlier buckets via
  // lastCumulative, so adding the full amount again here would double
  // it. Conflating these into one variable was the bug this comment is
  // here to prevent reintroducing.
  const grandTotalDelta = totalUnrealized + totalPartialClosePnl;
  const nowPointDelta = totalUnrealized + partialCloseLeftoverForNow;
  // Only surface still-open positions' banked-money lines in the "Now"
  // breakdown when there's genuinely a leftover to attribute there —
  // if every fill landed inside the window, that money is already
  // fully visible on its own historical bucket (equityCurveTotal), and
  // repeating it here (even at the correct, already-fixed $0 total)
  // would read as a second, redundant mention of the same position.
  const nowPartialCloseLines =
    partialCloseLeftoverForNow !== 0 ? partialClosePositionLines : [];
  const displayCurve: ChartPoint[] =
    mode === "total" && unrealized && baseCurve.length > 0
      ? [
          ...baseCurve,
          {
            bucketKey: "now",
            label: "Now",
            tradePnl: nowPointDelta,
            cumulativePnl: lastCumulative + nowPointDelta,
            tradeCount:
              unrealized.optionsCount +
              unrealized.stockCount +
              nowPartialCloseLines.length,
            trades: [] as Array<{ symbol: string; pnl: number }>,
            nowDetails: {
              lines: [...unrealized.positionLines, ...nowPartialCloseLines],
              unrealized: totalUnrealized,
              partialClose: partialCloseLeftoverForNow,
              realized: combinedRealized,
            },
          },
        ]
      : baseCurve;
  const grandTotal = combinedRealized + (mode === "total" ? grandTotalDelta : 0);
  const grandTotalColor =
    grandTotal >= 0 ? "text-emerald-300" : "text-rose-300";
  const partialCloseColor =
    totalPartialClosePnl >= 0 ? "text-emerald-300" : "text-rose-300";
  // Cap the chart's right edge at today (PST). The date-range
  // picker can extend into the future (Quarter, YTD, All Time all
  // do), but the chart shouldn't show empty/projected days — that
  // reads as "no activity" instead of "future".
  const todayPstIso = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const chartCurve = displayCurve.filter(
    (p) => p.bucketKey === "now" || p.bucketKey <= todayPstIso,
  );
  const unrealizedColor =
    totalUnrealized >= 0 ? "text-emerald-300" : "text-rose-300";

  return (
    <section className="space-y-4">
      <h2 className="text-lg font-semibold">Performance</h2>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <StatCard label={mode === "total" ? "Total P&L" : "Realized P&L"}>
          <div className="space-y-0.5">
            <span
              className={
                mode === "total"
                  ? grandTotal >= 0
                    ? "text-emerald-300"
                    : "text-rose-300"
                  : pnlColor
              }
            >
              {fmtMoney(mode === "total" ? grandTotal : combinedRealized, true)}
            </span>
            {mode === "total" && remaining !== null && (
              <span
                className="ml-1.5 text-sm text-muted-foreground"
                title="Max profit on open options (full premium if every one expires worthless) minus what's already captured. A hypothetical ceiling, not part of the total above."
              >
                ({fmtMoney(remaining, true)} remaining)
              </span>
            )}
            {(stockRealized !== 0 || mode === "total") && (
              <div className="space-y-0 text-[10px] leading-snug text-muted-foreground">
                {/* Realized breakdown — always shown when stocks
                    have moved or when in Total mode (so the user
                    can see how Total decomposes). */}
                <div className="flex items-baseline justify-between gap-2">
                  <span>Options</span>
                  <span className={`font-mono ${optionColor}`}>
                    {fmtMoney(optionRealized, true)}
                  </span>
                </div>
                {stockRealized !== 0 && (
                  <div className="flex items-baseline justify-between gap-2">
                    <span>Stock sales</span>
                    <span className={`font-mono ${stockColor}`}>
                      {fmtMoney(stockRealized, true)}
                    </span>
                  </div>
                )}
                {mode === "total" && (
                  <div className="flex items-baseline justify-between gap-2">
                    <span>Unrealized</span>
                    <span
                      className={`font-mono ${unrealizedColor}`}
                      title={
                        unrealizedLoading
                          ? "Fetching open-position marks…"
                          : unrealized
                            ? `${unrealized.optionsCount} options + ${unrealized.stockCount} stocks`
                            : undefined
                      }
                    >
                      {unrealizedLoading && !unrealized
                        ? "…"
                        : fmtMoney(totalUnrealized, true)}
                    </span>
                  </div>
                )}
                {mode === "total" && remaining !== null && (
                  <div className="flex items-baseline justify-between gap-2 text-muted-foreground/70">
                    <span
                      title={
                        unrealized && unrealized.maxProfitMissing > 0
                          ? `Max profit if every open option expires worthless, minus what's already captured. ${unrealized.maxProfitMissing} open position(s) missing premium data are excluded.`
                          : "Max profit if every open option expires worthless, minus what's already captured."
                      }
                    >
                      Remaining (if all expire worthless)
                    </span>
                    <span className="font-mono">{fmtMoney(remaining, true)}</span>
                  </div>
                )}
                {mode === "total" && totalPartialClosePnl !== 0 && (
                  <div className="flex items-baseline justify-between gap-2">
                    <span
                      title="Realized gain/loss on contracts already closed within positions that are still open overall — banked, not yet in Realized P&L because the position hasn't fully resolved."
                    >
                      Partial closes
                    </span>
                    <span className={`font-mono ${partialCloseColor}`}>
                      {fmtMoney(totalPartialClosePnl, true)}
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>
        </StatCard>
        <StatCard label="Win Rate">
          <div className="space-y-0.5">
            <span>
              {stats.wins} / {stats.total_trades}{" "}
              <span className="text-sm text-muted-foreground">
                ({fmtPct(stats.win_rate, 0)})
              </span>
            </span>
            <div className="text-[10px] text-muted-foreground/70">
              resolved campaigns
              {stats.unresolved_campaigns.count > 0 && (
                <>
                  {" — "}
                  <span
                    title="These chains have no resolvable earnings event, so they're scored individually here instead of merged into a multi-leg campaign."
                  >
                    {stats.unresolved_campaigns.count} unresolved (
                    {fmtMoney(stats.unresolved_campaigns.pnl, true)})
                  </span>
                </>
              )}
            </div>
          </div>
        </StatCard>
        <StatCard label="Avg ROC / campaign">
          <div className="space-y-0.5">
            <span>{fmtPct(stats.avg_roc, 2)}</span>
            <div className="text-[10px] text-muted-foreground/70">
              resolved campaigns
            </div>
          </div>
        </StatCard>
        <StatCard label="Expectancy / campaign">
          <div className="space-y-0.5">
            <span className={stats.expectancy >= 0 ? "text-emerald-300" : "text-rose-300"}>
              {fmtMoney(stats.expectancy, true)}
            </span>
            <div className="text-[10px] text-muted-foreground/70">
              resolved campaigns
            </div>
          </div>
        </StatCard>
        <StatCard label="Best / Worst">
          <div className="space-y-1 text-sm">
            {stats.best_trade ? (
              <div>
                <span className="text-muted-foreground">Best:</span>{" "}
                {stats.best_trade.symbol}{" "}
                <span className="text-emerald-300">{fmtMoney(stats.best_trade.pnl, true)}</span>{" "}
                <span className="text-muted-foreground">({fmtPct(stats.best_trade.roc, 2)})</span>
              </div>
            ) : (
              <div className="text-muted-foreground">Best: —</div>
            )}
            {stats.worst_trade ? (
              <div>
                <span className="text-muted-foreground">Worst:</span>{" "}
                {stats.worst_trade.symbol}{" "}
                <span className="text-rose-300">{fmtMoney(stats.worst_trade.pnl, true)}</span>{" "}
                <span className="text-muted-foreground">({fmtPct(stats.worst_trade.roc, 2)})</span>
              </div>
            ) : (
              <div className="text-muted-foreground">Worst: —</div>
            )}
            <div className="text-[10px] text-muted-foreground/70">
              realized trades
            </div>
          </div>
        </StatCard>
      </div>

      <div className="rounded-md border border-border bg-background/40 p-3">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div className="text-base font-medium">Equity curve</div>
          <div className="inline-flex overflow-hidden rounded-md border border-border bg-background/60 text-sm">
            <button
              type="button"
              className={`px-2.5 py-1 ${
                mode === "realized"
                  ? "bg-foreground/10 text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
              onClick={() => setMode("realized")}
            >
              Realized
            </button>
            <button
              type="button"
              className={`px-2.5 py-1 ${
                mode === "total"
                  ? "bg-foreground/10 text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
              onClick={() => setMode("total")}
            >
              Total
            </button>
          </div>
        </div>
        {mode === "total" && (
          <div className="mb-2 rounded border border-border bg-background/50 px-2.5 py-1.5 text-sm">
            {unrealizedLoading ? (
              <span className="text-muted-foreground">
                Fetching open-position marks…
              </span>
            ) : unrealizedError ? (
              <span className="text-rose-300">
                Failed to load unrealized: {unrealizedError}
              </span>
            ) : unrealized ? (
              <div className="flex flex-wrap items-baseline gap-x-4 gap-y-0.5">
                <span>
                  <span className="text-muted-foreground">Realized: </span>
                  <span className={`font-mono ${pnlColor}`}>
                    {fmtMoney(combinedRealized, true)}
                  </span>
                </span>
                <span>
                  <span className="text-muted-foreground">Unrealized: </span>
                  <span className={`font-mono ${unrealizedColor}`}>
                    {fmtMoney(totalUnrealized, true)}
                  </span>
                </span>
                <span>
                  <span className="text-muted-foreground">Total: </span>
                  <span className={`font-mono font-semibold ${grandTotalColor}`}>
                    {fmtMoney(grandTotal, true)}
                  </span>
                </span>
                <span className="ml-auto text-[10px] text-muted-foreground/70">
                  {unrealized.optionsCount} option
                  {unrealized.optionsCount === 1 ? "" : "s"} ·{" "}
                  {unrealized.stockCount} stock
                  {unrealized.stockCount === 1 ? "" : "s"}
                </span>
              </div>
            ) : null}
          </div>
        )}
        {(() => {
          // Day-granularity windows zero-fill every day in the range
          // even when no trades closed, so equity_curve.length can be
          // large while tradeCount across all buckets is zero. Show
          // a tailored message in Total mode (since the user has
          // unrealized to summarize) instead of a flat-line chart
          // that drops to "Now" — which reads as a sudden loss.
          const hasRealizedInWindow = equity_curve.some(
            (p) => p.tradeCount > 0,
          );
          if (mode === "total" && !hasRealizedInWindow) {
            const unrealizedSign =
              totalUnrealized >= 0 ? "text-emerald-300" : "text-rose-300";
            return (
              <div className="py-8 text-center text-base text-muted-foreground">
                <div>No completed trades in this period.</div>
                {unrealizedLoading && !unrealized ? (
                  <div className="mt-1 text-sm">
                    Fetching open-position marks…
                  </div>
                ) : unrealized ? (
                  <div className="mt-1 text-sm">
                    Current unrealized:{" "}
                    <span className={`font-mono font-semibold ${unrealizedSign}`}>
                      {fmtMoney(totalUnrealized, true)}
                    </span>
                  </div>
                ) : null}
              </div>
            );
          }
          if (chartCurve.length < 2) {
            return (
              <div className="py-8 text-center text-base text-muted-foreground">
                Not enough trades in this range to display equity curve.
              </div>
            );
          }
          return null;
        })()}
        {(() => {
          const hasRealizedInWindow = equity_curve.some(
            (p) => p.tradeCount > 0,
          );
          if (mode === "total" && !hasRealizedInWindow) return null;
          if (chartCurve.length < 2) return null;
          return (
          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartCurve}>
                <defs>
                  <linearGradient id="pnlGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#22c55e" stopOpacity={0.4} />
                    <stop offset="100%" stopColor="#ef4444" stopOpacity={0.3} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
                <XAxis dataKey="label" stroke="#71717a" tick={{ fontSize: 11 }} />
                <YAxis
                  stroke="#71717a"
                  tick={{ fontSize: 11 }}
                  tickFormatter={(v) => fmtMoneyAxis(Number(v))}
                />
                <Tooltip content={<EquityTooltip consolidate={shouldConsolidateTooltip} />} />
                <Area
                  type="monotone"
                  dataKey="cumulativePnl"
                  stroke="#3b82f6"
                  strokeWidth={2}
                  fill="url(#pnlGradient)"
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
          );
        })()}
      </div>

      <TickerPnlPanel rows={data.ticker_pnl ?? []} />
      <PartialClosesPanel
        rows={data.partial_closes ?? []}
        total={data.total_partial_pnl ?? 0}
      />
      <PairedAssignmentsPanel pairs={data.paired_assignments ?? []} />
    </section>
  );
}

const TICKER_PNL_MAX_BARS = 25;

function spanningCampaignsNote(spanning: Array<{ allTimeNet: number }>): string | null {
  if (spanning.length === 0) return null;
  if (spanning.length === 1) {
    return `1 campaign spans beyond this window (net ${fmtMoney(spanning[0].allTimeNet, true, true)} all-time)`;
  }
  const sum = Math.round(spanning.reduce((s, c) => s + c.allTimeNet, 0) * 100) / 100;
  return `${spanning.length} campaigns span beyond this window (combined net ${fmtMoney(sum, true, true)} all-time)`;
}

// One vertical column per ticker, netting options + stock together —
// row-level windowed exactly like the Realized P&L card and equity
// curve above it, so these always sum to combined_realized_pnl (rows
// come pre-sorted by |totalNet| descending from the API, so both the
// biggest winner and biggest loser land near the left). Zero sits on
// the category axis so column height is always comparable — no
// diverging-from-center layout, where a bar starting at -$3,700 and
// one starting at $0 read as different scales. Above 25 tickers the
// tail is excluded from the chart entirely (rendering it as an
// aggregate column made the aggregate look like a real position) and
// surfaced as a text line below instead, with the same expand-in-place
// table the chart bar used to offer.
function TickerPnlPanel({ rows }: { rows: TickerPnl[] }) {
  const [othersExpanded, setOthersExpanded] = useState(false);

  const shown = rows.length <= TICKER_PNL_MAX_BARS ? rows : rows.slice(0, TICKER_PNL_MAX_BARS);
  const rest = rows.length <= TICKER_PNL_MAX_BARS ? [] : rows.slice(TICKER_PNL_MAX_BARS);
  const othersNet = Math.round(rest.reduce((s, r) => s + r.totalNet, 0) * 100) / 100;

  // Concentration uses the FULL list (pre-cap) and absolute values in
  // the denominator, per spec — offsetting wins/losses shouldn't hide
  // concentration the way a signed sum would.
  const grossAbs = rows.reduce((s, r) => s + Math.abs(r.totalNet), 0);
  const top3 = rows.slice(0, 3);
  const top3Abs = top3.reduce((s, r) => s + Math.abs(r.totalNet), 0);
  const concentrationPct = grossAbs > 0 ? (top3Abs / grossAbs) * 100 : 0;

  const chartData: ChartData<"bar"> = useMemo(
    () => ({
      labels: shown.map((r) => r.symbol),
      datasets: [
        {
          data: shown.map((r) => r.totalNet),
          backgroundColor: shown.map((r) => (r.totalNet >= 0 ? "#10b981" : "#ef4444")),
          borderRadius: 4,
          maxBarThickness: 24,
        },
      ],
    }),
    [shown],
  );

  const chartOptions: ChartOptions<"bar"> = useMemo(
    () => ({
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: "rgba(24,24,27,0.95)",
          borderColor: "#3f3f46",
          borderWidth: 1,
          titleColor: "#fafafa",
          bodyColor: "#d4d4d8",
          padding: 8,
          cornerRadius: 6,
          titleFont: { size: 13, weight: "bold" as const },
          bodyFont: { size: 11 },
          displayColors: false,
          callbacks: {
            label: () => "",
            title: (items: TooltipItem<"bar">[]) => (items[0]?.label as string) ?? "",
            afterBody: (items: TooltipItem<"bar">[]) => {
              const idx = items[0]?.dataIndex;
              const d = idx !== undefined ? shown[idx] : undefined;
              if (!d) return [];
              const lines = [
                `Options net: ${fmtMoney(d.optionsNet, true, true)}`,
                `Stock net: ${fmtMoney(d.stockNet, true, true)}`,
                `Total: ${fmtMoney(d.totalNet, true, true)}`,
              ];
              if (d.campaignCount > 0) {
                lines.push(`Campaigns (in window): ${d.campaignCount}`);
                lines.push(`Win rate: ${d.winRate !== null ? fmtPct(d.winRate, 0) : "—"}`);
              }
              const note = spanningCampaignsNote(d.spanningCampaigns);
              if (note) lines.push(note);
              return lines;
            },
          },
        },
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { color: "#71717a", font: { size: 11 } },
        },
        y: {
          grid: { color: "#27272a" },
          ticks: {
            color: "#71717a",
            font: { size: 11 },
            callback: (value) => fmtMoneyAxis(Number(value)),
          },
        },
      },
    }),
    [shown],
  );

  if (rows.length === 0) return null;

  return (
    <div className="rounded-md border border-border bg-background/40 p-3">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <div className="text-base font-medium">P&L by ticker</div>
        {top3.length > 0 && (
          <div className="text-[11px] text-muted-foreground">
            Top {top3.length} ({top3.map((t) => t.symbol).join(", ")}) ={" "}
            <span className="font-mono">{Math.round(concentrationPct)}%</span> of gross P&L
          </div>
        )}
      </div>
      <div style={{ width: "100%", height: 280 }}>
        <ChartJsBar data={chartData} options={chartOptions} />
      </div>
      {rest.length > 0 && (
        <div className="mt-2">
          <button
            type="button"
            onClick={() => setOthersExpanded((v) => !v)}
            className="text-[11px] text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground"
          >
            {rest.length} others:{" "}
            <span className={othersNet >= 0 ? "text-emerald-300" : "text-rose-300"}>
              {fmtMoney(othersNet, true, true)}
            </span>{" "}
            ({othersExpanded ? "hide" : "show"})
          </button>
          {othersExpanded && (
            <table className="mt-2 w-full text-[11px]">
              <tbody>
                {rest.map((r) => (
                  <tr key={r.symbol} className="border-t border-border/40">
                    <td className="py-1 text-muted-foreground">{r.symbol}</td>
                    <td className="py-1 text-right text-muted-foreground">
                      {r.campaignCount} {r.campaignCount === 1 ? "campaign" : "campaigns"}
                    </td>
                    <td
                      className={`py-1 text-right font-mono ${r.totalNet >= 0 ? "text-emerald-300" : "text-rose-300"}`}
                    >
                      {fmtMoney(r.totalNet, true, true)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

// Open positions that have a non-zero realized_pnl from a partial
// close (e.g. closed 1 of 3 contracts) — separate from the Realized
// P&L headline since the position hasn't fully resolved. Hidden
// when there are no partial-close rows.
function PartialClosesPanel({
  rows,
  total,
}: {
  rows: PartialClose[];
  total: number;
}) {
  if (rows.length === 0) return null;
  const totalColor = total >= 0 ? "text-emerald-300" : "text-rose-300";
  return (
    <div className="rounded-md border border-border bg-background/40 p-3">
      <div className="mb-2 text-base font-medium">
        Partial closes <span className="text-sm font-normal text-muted-foreground">(open positions)</span>
      </div>
      <div className="space-y-1.5">
        {rows.map((r) => {
          const isStock =
            r.positionType === "stock_long" || r.positionType === "stock_short";
          const label = isStock
            ? `${r.symbol} stock`
            : `${r.symbol} $${r.strike}P`;
          const remainingUnit = isStock ? "shares" : "contracts";
          const pnlColor =
            r.realizedPnl >= 0 ? "text-emerald-300" : "text-rose-300";
          return (
            <div
              key={r.positionId}
              className="flex items-baseline justify-between gap-3 text-base"
            >
              <div className="flex items-baseline gap-2">
                <span className="font-mono font-semibold text-foreground">
                  {label}
                </span>
                {r.broker && (
                  <span className="text-[10px] uppercase tracking-wider text-muted-foreground/70">
                    {r.broker}
                  </span>
                )}
                <span className="text-sm text-muted-foreground">
                  ({r.remainingContracts} {remainingUnit} remaining)
                </span>
              </div>
              <span className={`font-mono font-semibold ${pnlColor}`}>
                {fmtMoney(r.realizedPnl, true)}
              </span>
            </div>
          );
        })}
      </div>
      <div className="mt-2 flex items-baseline justify-between border-t border-border/40 pt-2 text-base">
        <span className="text-muted-foreground">Total partial P&L:</span>
        <span className={`font-mono font-semibold ${totalColor}`}>
          {fmtMoney(total, true)}
        </span>
      </div>
      <div className="mt-1 text-[10px] text-muted-foreground/70">
        These positions are still open — P&L finalizes when fully closed. Excluded from Realized P&L, win rate, ROC,
        and expectancy above (those score fully-resolved trades only) — but included in Total P&L when the Total
        toggle is on, since this money is already banked.
      </div>
    </div>
  );
}

// Lists each closed stock_long alongside its parent put — the linked
// trade view. Renders nothing when there are no closed assignments
// yet, so the panel only shows up when there's something to surface.
function PairedAssignmentsPanel({ pairs }: { pairs: PairedAssignment[] }) {
  if (pairs.length === 0) return null;
  return (
    <div className="rounded-md border border-border bg-background/40 p-3">
      <div className="mb-2 text-base font-medium">Paired assignments</div>
      <div className="space-y-3">
        {pairs.map((p) => {
          const parentPnl = p.parent?.realizedPnl ?? 0;
          const premiumCollected = p.parent?.premiumCollected ?? 0;
          const stockPnl = p.stock.realizedPnl;
          const totalColor =
            p.totalPnl >= 0 ? "text-emerald-300" : "text-rose-300";
          const premiumColor =
            premiumCollected >= 0 ? "text-emerald-300" : "text-rose-300";
          const stockColor =
            stockPnl >= 0 ? "text-emerald-300" : "text-rose-300";
          return (
            <div
              key={p.stock.positionId}
              className="rounded border border-border/60 bg-background/40 p-3 text-base"
            >
              <div className="mb-1 flex items-baseline justify-between">
                <span className="text-base font-semibold">{p.symbol}</span>
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  {p.broker ?? ""}
                </span>
              </div>
              <div className="space-y-0.5 font-mono">
                {p.parent ? (
                  <div
                    className="flex justify-between gap-3"
                    title="Premium collected on the assigned shares — folded into the stock's cost basis below, not counted separately in Total P&L."
                  >
                    <span className="text-muted-foreground">
                      ${p.parent.strike} put × {p.parent.contracts} — premium collected:
                    </span>
                    <span className={premiumColor}>
                      {fmtMoney(premiumCollected, true)}
                    </span>
                  </div>
                ) : (
                  <div className="flex justify-between gap-3 text-muted-foreground">
                    <span>Parent put — not found</span>
                    <span>—</span>
                  </div>
                )}
                {p.parent && Math.abs(parentPnl) > 0.001 && (
                  <div
                    className="flex justify-between gap-3 text-[11px]"
                    title="Left on the option row after the assignment split — from contracts closed separately from the assignment (e.g. a partial buyback), not part of the premium above."
                  >
                    <span className="text-muted-foreground">option leg residual:</span>
                    <span className={parentPnl >= 0 ? "text-emerald-300/80" : "text-rose-300/80"}>
                      {fmtMoney(parentPnl, true)}
                    </span>
                  </div>
                )}
                <div className="flex justify-between gap-3">
                  <span className="text-muted-foreground">
                    {p.stock.shares} shares
                    {p.stock.costBasis !== null
                      ? ` @ $${p.stock.costBasis.toFixed(2)} cost — stock P&L:`
                      : " — stock P&L:"}
                  </span>
                  <span className={stockColor}>{fmtMoney(stockPnl, true)}</span>
                </div>
                <div className="my-1 border-t border-border/60" />
                <div className="flex justify-between gap-3 text-base font-semibold">
                  <span>Total {p.symbol} P&L:</span>
                  <span className={totalColor}>{fmtMoney(p.totalPnl, true)}</span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-2 text-[10px] text-muted-foreground/70">
        Each row is one assignment cycle, not a full campaign — a campaign can also include option
        legs that were rolled or bought back without ever being assigned, so these totals are a
        subset of the campaign figures above, not a reconciliation of them.
      </div>
    </div>
  );
}

// Augmented chart-point type — the synthetic "Now" point in Total mode
// carries an extra `nowDetails` payload so the tooltip can render the
// per-position breakdown instead of the historical-bucket layout.
type NowDetails = {
  lines: Array<{ label: string; pnl: number }>;
  unrealized: number;
  // Banked gain/loss on already-closed contracts of positions still
  // open overall — see totalPartialClosePnl above.
  partialClose: number;
  realized: number;
};
type ChartPoint = EquityPoint & { nowDetails?: NowDetails };

const DEFAULT_TOOLTIP_MAX_ROWS = 15;
// Consolidate the per-fill list once the selected window exceeds one
// week — Today/Week stay per-fill (seeing individual fills matters at
// that granularity), Month/Quarter/YTD/All Time and any custom range
// this wide group by symbol instead, since a single busy day can carry
// dozens of fills on a long window and blow out the tooltip.
const TOOLTIP_CONSOLIDATE_THRESHOLD_DAYS = 7;

type ConsolidatedRow = { symbol: string; pnl: number; count: number };

// Groups a bucket's fills by symbol, summing pnl and counting fills.
// Pure resummation of the same numbers — never rounds or drops
// anything, so the consolidated total always equals the per-fill
// total exactly. TSLA (option) and "TSLA (stock)" are already distinct
// strings at the source (see the server's fill-label construction in
// app/api/intelligence/route.ts), so grouping by the literal symbol
// string can't merge an option leg into its paired stock leg.
function consolidateBySymbol(
  trades: Array<{ symbol: string; pnl: number }>,
): ConsolidatedRow[] {
  const bySymbol = new Map<string, ConsolidatedRow>();
  for (const t of trades) {
    const existing = bySymbol.get(t.symbol);
    if (existing) {
      existing.pnl += t.pnl;
      existing.count += 1;
    } else {
      bySymbol.set(t.symbol, { symbol: t.symbol, pnl: t.pnl, count: 1 });
    }
  }
  return Array.from(bySymbol.values()).sort(
    (a, b) => Math.abs(b.pnl) - Math.abs(a.pnl),
  );
}

// Rich tooltip for the equity curve. Total/Cumulative (or, on the
// synthetic "Now" point, Unrealized/Partial closes/Realized/Total)
// render FIRST, above the per-trade list, so they're always visible
// regardless of how long that list runs. Recharts passes `payload`
// with the raw data point at payload[0].payload; consolidate/maxRows
// are passed through from PerformanceSection via the element it hands
// to <Tooltip content={...}> (recharts merges its own active/payload
// props onto whatever props are already set on that element).
function EquityTooltip({
  active,
  payload,
  consolidate = false,
  maxRows = DEFAULT_TOOLTIP_MAX_ROWS,
}: {
  active?: boolean;
  payload?: Array<{ payload: ChartPoint }>;
  // Whether to group the per-trade list by symbol (Month/Quarter/YTD/
  // All Time and custom ranges beyond a week) or show one row per fill
  // (Today/Week) — see shouldConsolidateTooltip in PerformanceSection.
  consolidate?: boolean;
  maxRows?: number;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const b = payload[0].payload;
  const totalColor = b.tradePnl >= 0 ? "text-emerald-300" : "text-rose-300";
  const cumColor = b.cumulativePnl >= 0 ? "text-emerald-300" : "text-rose-300";

  if (b.nowDetails) {
    const nd = b.nowDetails;
    const unrealizedColor = nd.unrealized >= 0 ? "text-emerald-300" : "text-rose-300";
    const partialCloseColor = nd.partialClose >= 0 ? "text-emerald-300" : "text-rose-300";
    const realizedColor = nd.realized >= 0 ? "text-emerald-300" : "text-rose-300";
    return (
      <div className="min-w-[220px] rounded border border-border bg-zinc-900/95 p-2 text-sm shadow-lg">
        <div className="mb-1 font-medium text-foreground">
          {b.label}{" "}
          <span className="text-muted-foreground">
            ({b.tradeCount} open {b.tradeCount === 1 ? "position" : "positions"})
          </span>
        </div>
        <div className="flex justify-between gap-3">
          <span className="text-muted-foreground">Unrealized:</span>
          <span className={unrealizedColor}>{fmtMoney(nd.unrealized, true)}</span>
        </div>
        {nd.partialClose !== 0 && (
          <div className="flex justify-between gap-3">
            <span className="text-muted-foreground">Partial closes:</span>
            <span className={partialCloseColor}>{fmtMoney(nd.partialClose, true)}</span>
          </div>
        )}
        <div className="flex justify-between gap-3">
          <span className="text-muted-foreground">Realized:</span>
          <span className={realizedColor}>{fmtMoney(nd.realized, true)}</span>
        </div>
        <div className="flex justify-between gap-3 font-semibold">
          <span className="text-muted-foreground">Total:</span>
          <span className={cumColor}>{fmtMoney(b.cumulativePnl, true)}</span>
        </div>
        {nd.lines.length > 0 && (
          <>
            <div className="my-1 border-t border-border" />
            <div className="space-y-0.5">
              {nd.lines.map((l, i) => (
                <div
                  key={`${l.label}-${i}`}
                  className="flex justify-between gap-3 font-mono"
                >
                  <span>{l.label}</span>
                  <span className={l.pnl >= 0 ? "text-emerald-300" : "text-rose-300"}>
                    {fmtMoney(l.pnl, true)}
                  </span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    );
  }

  const rows: ConsolidatedRow[] = consolidate
    ? consolidateBySymbol(b.trades)
    : b.trades.map((t) => ({ symbol: t.symbol, pnl: t.pnl, count: 1 }));
  // Cap only applies once consolidated — per-fill lists (Today/Week)
  // render every row exactly as before, uncapped.
  const visibleRows = consolidate ? rows.slice(0, maxRows) : rows;
  const hiddenRows = consolidate ? rows.slice(maxRows) : [];
  const hiddenPnl = hiddenRows.reduce((s, r) => s + r.pnl, 0);

  return (
    <div className="min-w-[180px] rounded border border-border bg-zinc-900/95 p-2 text-sm shadow-lg">
      <div className="mb-1 font-medium text-foreground">
        {b.label}{" "}
        <span className="text-muted-foreground">
          ({b.tradeCount} {b.tradeCount === 1 ? "trade" : "trades"})
        </span>
      </div>
      <div className="flex justify-between gap-3">
        <span className="text-muted-foreground">Total:</span>
        <span className={totalColor}>{fmtMoney(b.tradePnl, true)}</span>
      </div>
      <div className="flex justify-between gap-3 font-semibold">
        <span className="text-muted-foreground">Cumulative:</span>
        <span className={cumColor}>{fmtMoney(b.cumulativePnl, true)}</span>
      </div>
      {rows.length > 0 ? (
        <>
          <div className="my-1 border-t border-border" />
          <div className="space-y-0.5">
            {visibleRows.map((r, i) => (
              <div
                key={`${r.symbol}-${i}`}
                className="flex justify-between gap-3 font-mono"
              >
                <span>
                  {r.symbol}
                  {r.count > 1 && (
                    <span className="text-muted-foreground"> ×{r.count}</span>
                  )}
                </span>
                <span className={r.pnl >= 0 ? "text-emerald-300" : "text-rose-300"}>
                  {fmtMoney(r.pnl, true)}
                </span>
              </div>
            ))}
            {hiddenRows.length > 0 && (
              <div className="flex justify-between gap-3 font-mono text-muted-foreground">
                <span>+{hiddenRows.length} more</span>
                <span>{fmtMoney(hiddenPnl, true)}</span>
              </div>
            )}
          </div>
        </>
      ) : (
        <div className="mt-1 text-muted-foreground">No trades</div>
      )}
    </div>
  );
}

function StatCard({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-border bg-background/40 p-3">
      <div className="text-sm text-muted-foreground">{label}</div>
      <div className="mt-1 text-lg font-semibold">{children}</div>
    </div>
  );
}

// ================== Section 2: Ticker Rankings ==================

export function TickerRankingsSection({
  rankings,
  expandedSymbol,
  onToggleSymbol,
}: {
  rankings: TickerRanking[];
  expandedSymbol: string | null;
  onToggleSymbol: (s: string) => void;
}) {
  const [search, setSearch] = useState("");
  const normalized = search.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      normalized === ""
        ? rankings
        : rankings.filter((r) => r.symbol.toLowerCase().includes(normalized)),
    [rankings, normalized],
  );

  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-lg font-semibold">Capital Efficiency by Ticker</h2>
        <p className="text-sm text-muted-foreground">
          Sorted by average ROC — your best-performing setups
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search ticker..."
          className="w-full max-w-xs rounded border border-border bg-background px-3 py-1.5 text-base placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-foreground/40"
        />
      </div>
      {rankings.length === 0 ? (
        <div className="rounded border border-border bg-background/40 p-6 text-base text-muted-foreground">
          No closed trades yet. Rankings appear after your first closed position.
        </div>
      ) : (
        <>
          <div className="max-h-[600px] overflow-y-auto rounded border border-border">
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-background">
                <TableRow>
                  <TableHead>Symbol</TableHead>
                  <TableHead className="text-right">Trades</TableHead>
                  <TableHead className="text-right">Win Rate</TableHead>
                  <TableHead className="text-right">Avg ROC</TableHead>
                  <TableHead className="text-right">Best ROC</TableHead>
                  <TableHead>Grade</TableHead>
                  <TableHead className="text-right">Rec Accuracy</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={7}
                      className="py-6 text-center text-base text-muted-foreground"
                    >
                      No tickers match &ldquo;{search}&rdquo;.
                    </TableCell>
                  </TableRow>
                ) : (
                  filtered.map((r) => (
                    <TickerRow
                      key={r.symbol}
                      row={r}
                      expanded={expandedSymbol === r.symbol}
                      onToggle={() => onToggleSymbol(r.symbol)}
                    />
                  ))
                )}
              </TableBody>
            </Table>
          </div>
          <div className="text-sm text-muted-foreground">
            Showing {filtered.length} of {rankings.length} tickers
          </div>
        </>
      )}
    </section>
  );
}

function TickerRow({
  row,
  expanded,
  onToggle,
}: {
  row: TickerRanking;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <TableRow onClick={onToggle} className="cursor-pointer hover:bg-muted/20">
        <TableCell className="font-mono">{row.symbol}</TableCell>
        <TableCell className="text-right">{row.trades}</TableCell>
        <TableCell className={`text-right ${winRateColor(row.win_rate)}`}>
          {fmtPct(row.win_rate, 0)}
        </TableCell>
        <TableCell className="text-right">{fmtPct(row.avg_roc, 2)}</TableCell>
        <TableCell className="text-right">{fmtPct(row.best_roc, 2)}</TableCell>
        <TableCell>
          {row.top_grade ? (
            <span
              className={`inline-block rounded border px-2 py-0.5 text-[11px] font-medium ${gradeColor(row.top_grade)}`}
            >
              {row.top_grade}
            </span>
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </TableCell>
        <TableCell className="text-right text-sm">
          {row.rec_total !== null && row.rec_total > 0 ? (
            `${row.rec_aligned}/${row.rec_total} correct`
          ) : row.rec_count !== null && row.rec_count > 0 ? (
            <span
              className="text-muted-foreground"
              title="Recommendations exist but carried no scoreable CLOSE/HOLD verdict (crush data was missing at analysis time). New recs generated by the T1 capture score automatically on close."
            >
              {row.rec_count} rec{row.rec_count === 1 ? "" : "s"} · unscored
            </span>
          ) : (
            "—"
          )}
        </TableCell>
      </TableRow>
      {expanded && (
        <TableRow className="bg-background/40">
          <TableCell colSpan={7}>
            <div className="space-y-2 py-2">
              <div className="text-sm font-medium text-foreground">
                Closed trades for {row.symbol}
              </div>
              <table className="w-full text-sm">
                <thead className="text-muted-foreground">
                  <tr>
                    <th className="text-left">Opened</th>
                    <th className="text-left">Closed</th>
                    <th className="text-right">Premium</th>
                    <th className="text-right">P&L</th>
                    <th className="text-right">ROC</th>
                    <th className="text-left">Grade</th>
                  </tr>
                </thead>
                <tbody>
                  {row.closed_trades.map((t, i) => (
                    <tr key={i}>
                      <td>{t.opened_date}</td>
                      <td>{t.closed_date ?? "—"}</td>
                      <td className="text-right">{fmtMoney(t.avg_premium_sold)}</td>
                      <td
                        className={`text-right ${
                          t.realized_pnl !== null && t.realized_pnl >= 0
                            ? "text-emerald-300"
                            : "text-rose-300"
                        }`}
                      >
                        {fmtMoney(t.realized_pnl, true)}
                      </td>
                      <td className="text-right">{fmtPct(t.roc, 2)}</td>
                      <td>{t.grade ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

// ================== Section 3: Pattern Intelligence ==================

export function PatternIntelligenceSection({
  patterns,
}: {
  patterns: IntelligenceResponse["patterns"];
}) {
  return (
    <section className="space-y-4">
      <h2 className="text-lg font-semibold">Pattern Intelligence</h2>
      {!patterns.enabled ? (
        <div className="rounded border border-border bg-background/40 p-6 text-base text-muted-foreground">
          Pattern detection requires 10+ closed trades. You have {patterns.total_closed} so
          far — keep trading.
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          <GradePanel buckets={patterns.by_grade} calibration={patterns.calibration} />
          <DayOfWeekPanel buckets={patterns.by_day_of_week} />
          <VixRegimePanel buckets={patterns.by_vix_regime} />
          <DtePanel buckets={patterns.by_dte} />
          <IndustryPanel buckets={patterns.by_industry} />
          <CalibrationPanel buckets={patterns.by_grade} calibration={patterns.calibration} />
          {patterns.rec_accuracy && <RecAccuracyPanel accuracy={patterns.rec_accuracy} />}
        </div>
      )}
    </section>
  );
}

function bucketInterpBest(buckets: PatternBucket[]): PatternBucket | null {
  const valid = buckets.filter((b) => b.trades > 0);
  if (valid.length === 0) return null;
  return valid.reduce((best, b) => (b.win_rate > best.win_rate ? b : best));
}
function bucketInterpWorst(buckets: PatternBucket[]): PatternBucket | null {
  const valid = buckets.filter((b) => b.trades > 0);
  if (valid.length === 0) return null;
  return valid.reduce((worst, b) => (b.win_rate < worst.win_rate ? b : worst));
}

function PanelShell({
  title,
  interp,
  children,
}: {
  title: string;
  interp: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-md border border-border bg-background/40 p-3">
      <div className="mb-2 text-base font-medium">{title}</div>
      <div className="h-48 w-full">{children}</div>
      <div className="mt-2 text-sm text-muted-foreground">{interp}</div>
    </div>
  );
}

function GradePanel({
  buckets,
  calibration,
}: {
  buckets: PatternBucket[];
  calibration: { drift: boolean; summary: string };
}) {
  const chartData = buckets.map((b) => ({
    key: b.key,
    winPct: b.win_rate * 100,
    trades: b.trades,
  }));
  const best = bucketInterpBest(buckets);
  const interp = calibration.drift
    ? "⚠ Grade B outperforms A — review what's different about your A-grade trades."
    : best
      ? `Grade ${best.key} setups are winning at ${Math.round(best.win_rate * 100)}% — screener is well-calibrated at that tier.`
      : "Not enough grade data yet.";
  const colorFor = (k: string) =>
    k === "A" ? "#10b981" : k === "B" ? "#3b82f6" : k === "C" ? "#f59e0b" : "#ef4444";
  return (
    <PanelShell title="Win rate by screener grade" interp={interp}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={chartData}>
          <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
          <XAxis dataKey="key" stroke="#71717a" tick={{ fontSize: 11 }} />
          <YAxis stroke="#71717a" tick={{ fontSize: 11 }} unit="%" />
          <Tooltip
            contentStyle={{ background: "#18181b", border: "1px solid #3f3f46", borderRadius: 6, fontSize: 12 }}
            formatter={(value) => [`${Math.round(Number(value))}%`, "Win rate"]}
          />
          <Bar dataKey="winPct">
            {chartData.map((d) => (
              <Cell key={d.key} fill={colorFor(d.key)} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </PanelShell>
  );
}

function DayOfWeekPanel({ buckets }: { buckets: PatternBucket[] }) {
  const chartData = buckets.map((b) => ({
    key: b.key,
    winPct: b.win_rate * 100,
    trades: b.trades,
  }));
  const best = bucketInterpBest(buckets);
  const worst = bucketInterpWorst(buckets);
  const interp =
    best && worst && best.key !== worst.key
      ? `${best.key} closes win at ${Math.round(best.win_rate * 100)}%. ${worst.key} closes at ${Math.round(worst.win_rate * 100)}% — consider your day-of-week exposure.`
      : "Need more varied-day closes to identify patterns.";
  return (
    <PanelShell title="Win rate by day of week (close)" interp={interp}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={chartData}>
          <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
          <XAxis dataKey="key" stroke="#71717a" tick={{ fontSize: 11 }} />
          <YAxis stroke="#71717a" tick={{ fontSize: 11 }} unit="%" />
          <Tooltip
            contentStyle={{ background: "#18181b", border: "1px solid #3f3f46", borderRadius: 6, fontSize: 12 }}
            formatter={(value) => [`${Math.round(Number(value))}%`, "Win rate"]}
          />
          <Bar dataKey="winPct" fill="#8b5cf6" />
        </BarChart>
      </ResponsiveContainer>
    </PanelShell>
  );
}

function VixRegimePanel({ buckets }: { buckets: PatternBucket[] }) {
  const chartData = buckets.map((b) => ({
    key: b.key.charAt(0).toUpperCase() + b.key.slice(1),
    winPct: b.win_rate * 100,
    trades: b.trades,
  }));
  const panic = buckets.find((b) => b.key === "panic");
  let interp = "VIX regime breakdown across closed trades.";
  if (panic && panic.trades > 0 && panic.trades < 5) {
    interp = `VIX Panic regime: ${panic.trades} trades, ${Math.round(panic.win_rate * 100)}% win rate. Sample too small to conclude — 5+ needed.`;
  } else if (panic && panic.trades >= 5 && panic.win_rate < 0.5) {
    interp = `⚠ VIX Panic: ${Math.round(panic.win_rate * 100)}% win rate over ${panic.trades} trades — you underperform in panic regimes.`;
  }
  const colorFor = (k: string) =>
    k === "calm"
      ? "#10b981"
      : k === "15-20"
        ? "#a3e635"
        : k === "20-25"
          ? "#f59e0b"
          : "#ef4444";
  return (
    <PanelShell title="Win rate by VIX regime (entry)" interp={interp}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={chartData}>
          <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
          <XAxis dataKey="key" stroke="#71717a" tick={{ fontSize: 11 }} />
          <YAxis stroke="#71717a" tick={{ fontSize: 11 }} unit="%" />
          <Tooltip
            contentStyle={{ background: "#18181b", border: "1px solid #3f3f46", borderRadius: 6, fontSize: 12 }}
            formatter={(value) => [`${Math.round(Number(value))}%`, "Win rate"]}
          />
          <Bar dataKey="winPct">
            {chartData.map((d) => (
              <Cell key={d.key} fill={colorFor(d.key.toLowerCase())} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </PanelShell>
  );
}

function DtePanel({ buckets }: { buckets: PatternBucket[] }) {
  const chartData = buckets.map((b) => ({
    key: b.key,
    winPct: b.win_rate * 100,
    trades: b.trades,
  }));
  const best = bucketInterpBest(buckets.filter((b) => b.trades >= 3));
  const interp = best
    ? `${best.key} entries win at ${Math.round(best.win_rate * 100)}% (${best.trades} trades, avg ROC ${best.avg_roc !== null ? (best.avg_roc * 100).toFixed(2) + "%" : "—"}). Shorter DTE = faster theta but tighter margin for error.`
    : "Need 3+ trades in a DTE bucket to compare.";
  return (
    <PanelShell title="Win rate by days-to-expiry (entry)" interp={interp}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={chartData}>
          <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
          <XAxis dataKey="key" stroke="#71717a" tick={{ fontSize: 11 }} />
          <YAxis stroke="#71717a" tick={{ fontSize: 11 }} unit="%" />
          <Tooltip
            contentStyle={{ background: "#18181b", border: "1px solid #3f3f46", borderRadius: 6, fontSize: 12 }}
            formatter={(value, _name, entry) => [
              `${Math.round(Number(value))}% (${(entry?.payload as { trades?: number })?.trades ?? "?"} trades)`,
              "Win rate",
            ]}
          />
          <Bar dataKey="winPct" fill="#06b6d4" />
        </BarChart>
      </ResponsiveContainer>
    </PanelShell>
  );
}

function IndustryPanel({ buckets }: { buckets: PatternBucket[] }) {
  // Industry names are long — a compact table reads better than a
  // squeezed bar chart.
  const best = bucketInterpBest(buckets.filter((b) => b.trades >= 3));
  const worst = bucketInterpWorst(buckets.filter((b) => b.trades >= 3));
  const interp =
    best && worst && best.key !== worst.key
      ? `${best.key} is your strongest industry (${Math.round(best.win_rate * 100)}% over ${best.trades}); ${worst.key} is weakest (${Math.round(worst.win_rate * 100)}% over ${worst.trades}).`
      : "Need 3+ trades in two industries to compare.";
  return (
    <div className="rounded-md border border-border bg-background/40 p-3">
      <div className="mb-2 text-base font-medium">Win rate by industry</div>
      {buckets.length === 0 ? (
        <div className="py-8 text-center text-sm text-muted-foreground">
          No industries with 2+ trades yet.
        </div>
      ) : (
        <div className="max-h-48 overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="text-muted-foreground">
              <tr>
                <th className="text-left">Industry</th>
                <th className="text-right">Trades</th>
                <th className="text-right">Win Rate</th>
                <th className="text-right">Avg ROC</th>
              </tr>
            </thead>
            <tbody>
              {buckets.map((b) => (
                <tr key={b.key}>
                  <td className="max-w-[180px] truncate pr-2" title={b.key}>
                    {b.key}
                  </td>
                  <td className="text-right">{b.trades}</td>
                  <td className={`text-right ${winRateColor(b.win_rate)}`}>
                    {Math.round(b.win_rate * 100)}%
                  </td>
                  <td className="text-right">{fmtPct(b.avg_roc, 2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="mt-2 text-sm text-muted-foreground">{interp}</div>
    </div>
  );
}

// ================== Section: Earnings Move Calibration ==================

// Which symbols does the options market systematically over/under-price
// into earnings? avg_ratio = mean(|actual move| / implied move) across
// that symbol's history. < 1 ⇒ premium is rich relative to what prints
// — the raw material of the CSP crush strategy. This is shared market
// data (all captured earnings events), not just the user's trades.
export function EmCalibrationSection({ rows }: { rows: EmCalibrationRow[] }) {
  const [search, setSearch] = useState("");
  const [tradedOnly, setTradedOnly] = useState(false);
  const normalized = search.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      rows.filter(
        (r) =>
          (!tradedOnly || r.traded) &&
          (normalized === "" || r.symbol.toLowerCase().includes(normalized)),
      ),
    [rows, normalized, tradedOnly],
  );
  const ratioColor = (r: number) =>
    r < 0.7 ? "text-emerald-300" : r < 1.0 ? "text-emerald-200/80" : "text-rose-300";

  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-lg font-semibold">Earnings Move Calibration</h2>
        <p className="text-sm text-muted-foreground">
          Actual move vs options-implied move per symbol (3+ earnings events).
          Ratio &lt; 1 = the market overprices this name&apos;s earnings move —
          systematically rich premium for a CSP seller. Sorted best-first.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search ticker..."
          className="w-full max-w-xs rounded border border-border bg-background px-3 py-1.5 text-base placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-foreground/40"
        />
        <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <input
            type="checkbox"
            checked={tradedOnly}
            onChange={(e) => setTradedOnly(e.target.checked)}
          />
          Only tickers I&apos;ve traded
        </label>
      </div>
      {rows.length === 0 ? (
        <div className="rounded border border-border bg-background/40 p-6 text-base text-muted-foreground">
          No symbols with 3+ implied-vs-actual earnings pairs yet. Pairs
          accumulate from EM tracking and the T0/T1 capture cron.
        </div>
      ) : (
        <div className="max-h-[480px] overflow-y-auto rounded border border-border">
          <Table>
            <TableHeader className="sticky top-0 z-10 bg-background">
              <TableRow>
                <TableHead>Symbol</TableHead>
                <TableHead className="text-right">Events</TableHead>
                <TableHead className="text-right">Actual/Implied</TableHead>
                <TableHead className="text-right">Stayed Within EM</TableHead>
                <TableHead className="text-right">Avg Implied</TableHead>
                <TableHead className="text-right">Avg Actual</TableHead>
                <TableHead className="text-right">Last Event</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="py-6 text-center text-base text-muted-foreground">
                    No tickers match.
                  </TableCell>
                </TableRow>
              ) : (
                filtered.map((r) => (
                  <TableRow key={r.symbol}>
                    <TableCell className="font-mono">
                      {r.symbol}
                      {r.traded && (
                        <span
                          className="ml-1.5 rounded bg-foreground/10 px-1 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground"
                          title="You have closed trades on this symbol"
                        >
                          traded
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">{r.events}</TableCell>
                    <TableCell className={`text-right font-medium ${ratioColor(r.avg_ratio)}`}>
                      {r.avg_ratio.toFixed(2)}×
                    </TableCell>
                    <TableCell className="text-right">
                      {Math.round(r.within_implied_pct * 100)}%
                    </TableCell>
                    <TableCell className="text-right">
                      {(r.avg_implied_pct * 100).toFixed(1)}%
                    </TableCell>
                    <TableCell className="text-right">
                      {(r.avg_actual_pct * 100).toFixed(1)}%
                    </TableCell>
                    <TableCell className="text-right text-sm text-muted-foreground">
                      {r.last_event}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      )}
      <div className="text-sm text-muted-foreground">
        Showing {filtered.length} of {rows.length} symbols · shared market data
        across all captured earnings events
      </div>
    </section>
  );
}

function CalibrationPanel({
  buckets,
  calibration,
}: {
  buckets: PatternBucket[];
  calibration: { drift: boolean; summary: string };
}) {
  const expected: Record<string, string> = { A: "High", B: "Medium", C: "Low", F: "Skip" };
  return (
    <div className="rounded-md border border-border bg-background/40 p-3">
      <div className="mb-2 text-base font-medium">Was the screener right?</div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-muted-foreground">
            <tr>
              <th className="text-left">Grade</th>
              <th className="text-right">Trades</th>
              <th className="text-right">Wins</th>
              <th className="text-right">Win Rate</th>
              <th className="text-right">Avg ROC</th>
              <th>Expected</th>
            </tr>
          </thead>
          <tbody>
            {buckets.map((b) => {
              const mark =
                b.trades === 0
                  ? ""
                  : (b.key === "A" && b.win_rate >= 0.75) ||
                      (b.key === "B" && b.win_rate >= 0.6) ||
                      (b.key === "C" && b.win_rate >= 0.4) ||
                      b.key === "F"
                    ? "✓"
                    : "⚠";
              return (
                <tr key={b.key}>
                  <td>{b.key}</td>
                  <td className="text-right">{b.trades}</td>
                  <td className="text-right">{b.wins}</td>
                  <td className="text-right">
                    {b.trades > 0 ? `${Math.round(b.win_rate * 100)}%` : "—"}
                  </td>
                  <td className="text-right">{fmtPct(b.avg_roc, 2)}</td>
                  <td className="text-muted-foreground">
                    {expected[b.key]} {mark}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="mt-3 text-sm text-muted-foreground">{calibration.summary}</div>
    </div>
  );
}

function RecAccuracyPanel({
  accuracy,
}: {
  accuracy: NonNullable<IntelligenceResponse["patterns"]["rec_accuracy"]>;
}) {
  return (
    <div className="rounded-md border border-border bg-background/40 p-3">
      <div className="mb-2 text-base font-medium">Post-earnings recommendation accuracy</div>
      <div className="space-y-1 text-sm">
        <div>
          CLOSE recommendations:{" "}
          <span className="text-foreground">
            {accuracy.close_correct}/{accuracy.close_total} correct
          </span>
        </div>
        <div>
          HOLD recommendations:{" "}
          <span className="text-foreground">
            {accuracy.hold_correct}/{accuracy.hold_total} correct
          </span>
        </div>
        <div>
          Overall:{" "}
          <span className="text-foreground">{Math.round(accuracy.overall_pct * 100)}%</span>
        </div>
      </div>
    </div>
  );
}

// ================== Section 4: Export ==================

export function ExportSection({
  onCopy,
  copyStatus,
}: {
  onCopy: () => void;
  copyStatus: string | null;
}) {
  return (
    <section className="space-y-2">
      <div>
        <h2 className="text-lg font-semibold">Export Intelligence</h2>
        <p className="text-sm text-muted-foreground">
          One-click JSON dump for pasting into Claude chat for deeper analysis
        </p>
      </div>
      <div className="flex items-center gap-3">
        <Button onClick={onCopy}>📋 Copy Intelligence JSON</Button>
        {copyStatus && <span className="text-sm text-emerald-300">{copyStatus}</span>}
      </div>
    </section>
  );
}

// ================== Shared shell for sub-pages ==================

export function IntelligencePageShell({
  title,
  controls,
  error,
  loading,
  data,
  children,
}: {
  title: string;
  controls?: React.ReactNode;
  error: string | null;
  loading: boolean;
  data: IntelligenceResponse | null;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h1 className="text-2xl font-semibold">{title}</h1>
      </div>
      {controls && <div className="space-y-3">{controls}</div>}
      {error && (
        <div className="rounded border border-rose-500/40 bg-rose-500/10 p-3 text-base text-rose-300">
          {error}
        </div>
      )}
      {loading && !data && (
        <div className="text-base text-muted-foreground">Loading intelligence…</div>
      )}
      {data && <div className="space-y-8">{children}</div>}
    </div>
  );
}

"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  Bookmark,
  BookmarkCheck,
  BookSearch,
  ChevronDown,
  ChevronRight,
  Loader2,
  RefreshCw,
  Target,
  TrendingUp,
  Upload,
  Users,
  Zap,
} from "lucide-react";
import { ImportStockScreenshotModal } from "@/components/import-stock-screenshot-modal";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip as RTooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

// Hoverable text: dotted underline + cursor:help + tooltip with the
// formula or the actual numbers behind a metric. Used everywhere a value
// or label is non-obvious. NO icons — the dotted underline is the affordance.
function Tipped({
  children,
  content,
  side = "top",
}: {
  children: React.ReactNode;
  content: React.ReactNode;
  side?: "top" | "right" | "bottom" | "left";
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="cursor-help"
          style={{ borderBottom: "1px dotted rgba(255,255,255,0.4)" }}
        >
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent
        side={side}
        className="max-w-sm whitespace-pre-line text-sm leading-relaxed"
      >
        {content}
      </TooltipContent>
    </Tooltip>
  );
}

// Mirror of lib/swing-screener.ts SwingCandidate. Kept in sync by hand —
// the API serializes the engine type as JSON, and the component never
// constructs candidates itself, so a structural type is enough.
type InsiderTransaction = {
  name: string;
  // Finnhub free tier doesn't return officer titles. We surface the
  // SEC Form-4 transaction code as a human label instead — Purchase /
  // Sale / Grant / Option Exercise — which is what actually distinguishes
  // a conviction signal from comp.
  action: string;
  transactionCode: string;
  shares: number;
  price: number;
  date: string;
  type: "buy" | "sell";
  dollarValue: number;
};

type SwingCandidate = {
  symbol: string;
  companyName: string;
  currentPrice: number;
  priceChange1d: number;
  ma50: number;
  ma200: number;
  week52Low: number;
  week52High: number;
  analystTarget: number | null;
  numAnalysts: number;
  avgVolume10d: number;
  todayVolume: number;
  marketCap: number;
  shortPercentFloat: number | null;
  revenueGrowth: number | null;
  pctFromHigh: number;
  pctFrom52wLow: number;
  vsMA50: number;
  vsMA200: number;
  volumeRatio: number;
  rr: number | null;
  entryPrice: number;
  targetPrice: number;
  stopPrice: number;
  nextEarningsDate: string | null;
  daysToEarnings: number | null;
  insiderTransactions: InsiderTransaction[];
  insiderSignal: "strong_bullish" | "bullish" | "neutral" | "bearish";
  executiveBuys: InsiderTransaction[];
  // Open-market purchase breakdown. Optional — rows persisted before
  // this field existed fall back to deriving from insiderTransactions.
  insiderBuyDollars?: number;
  insiderBuyerCount?: number;
  insiderLastBuyDaysAgo?: number | null;
  unusualOptionsActivity: boolean;
  callVolumeOiRatio: number | null;
  optionsSignal: "bullish" | "neutral" | "bearish";
  topOptionsStrike: number | null;
  topOptionsExpiry: string | null;
  catalystFound: boolean;
  catalystType: string;
  catalystDate: string | null;
  catalystDescription: string | null;
  catalystConfidence: "high" | "medium" | "low" | "none";
  catalystInsiderAngle: string | null;
  catalystRawResponse: string | null;
  tier1Signals: string[];
  tier2Signals: string[];
  redFlags: string[];
  signalCount: number;
  setupScore: number;
  // Setup-type tabs. Optional — rows persisted before the tab redesign
  // lack them and get backfilled by normalizeCandidate().
  setupTabs?: SetupTab[];
  tabScores?: Partial<Record<SetupTab, number>>;
  tabStats?: TabStats | null;
  // Kept separate from tabStats so a confluence row shown under either
  // tab gets that tab's own stats. Optional for pre-redesign rows.
  capitulationStats?: TabStats | null;
  pullbackStats?: TabStats | null;
  // 14-day ATR — the volatility basis for entry/target/stop. Optional/
  // null for rows saved before the real-levels redesign or when Yahoo
  // didn't return enough daily history.
  atr14?: number | null;
};

type TabStats = {
  redDayCount: number;
  move5dPct: number;
  rsi14: number | null;
  sma20: number | null;
  return3m: number | null;
  return1y: number | null;
};

type SetupTab = "capitulation" | "pullback" | "insider" | "options_flow";

const SETUP_TABS: Array<{ key: SetupTab; label: string; blurb: string }> = [
  {
    key: "capitulation",
    label: "Capitulation",
    blurb:
      "Oversold bounce candidates: 3+ consecutive red days, worse than -12% over 5 days, RSI14 < 40. Ranked by severity (deeper selloff + lower RSI + larger cap).",
  },
  {
    key: "pullback",
    label: "Pullback",
    blurb:
      "Strong uptrends pulling back to support: above the 200d SMA with a positive 3-month return, sitting at the 50d SMA (or between the 20d and 50d), 5-12% off the recent high. Ranked by trend quality.",
  },
  {
    key: "insider",
    label: "Insider",
    blurb:
      "Recent open-market insider buys, excluding stocks in freefall (worse than -25% vs the 200d SMA). Ranked by conviction (buy size, distinct insiders, recency).",
  },
  {
    key: "options_flow",
    label: "Options Flow",
    blurb:
      "Unusual call activity (volume/OI on the hottest strike). Ranked by flow aggressiveness (vol/OI ratio + OTM skew).",
  },
];

const TAB_LABEL: Record<SetupTab, string> = {
  capitulation: "Capitulation",
  pullback: "Pullback",
  insider: "Insider",
  options_flow: "Options Flow",
};

// Rows saved before the tab redesign carry tier1Signals but no
// setupTabs — backfill insider/options membership so an old cached
// run still renders sensibly in the new layout.
function normalizeCandidate(c: SwingCandidate): SwingCandidate {
  if (Array.isArray(c.setupTabs)) return c;
  const setupTabs: SetupTab[] = [];
  const tabScores: Partial<Record<SetupTab, number>> = {};
  if (c.tier1Signals.includes("INSIDER_BUYING") && c.vsMA200 > -0.25) {
    setupTabs.push("insider");
    tabScores.insider = c.setupScore;
  }
  if (c.tier1Signals.includes("UNUSUAL_OPTIONS")) {
    setupTabs.push("options_flow");
    tabScores.options_flow = c.setupScore;
  }
  return { ...c, setupTabs, tabScores, tabStats: null };
}

function candidateTabs(c: SwingCandidate): SetupTab[] {
  return c.setupTabs ?? [];
}

function tabScoreOf(c: SwingCandidate, tab: SetupTab): number {
  return c.tabScores?.[tab] ?? c.setupScore;
}

// Mirror of /api/swings/screen/chart row shape — see route handler.
type ChartPoint = {
  date: string;
  close: number;
  volume: number;
  ma50: number | null;
  ma200: number | null;
};

type CachedResult = {
  candidates: SwingCandidate[];
  screened: number;
  pass1Survivors: number;
  pass2Results: number;
  durationMs: number;
  errors: string[];
  screenedAt: string | null;
};

// Column keys are dynamic per tab (see TAB_COLUMNS) plus a fixed set of
// common columns (symbol/company/price/chg/score/signals) — no longer a
// closed union, since each tab defines its own metric columns.
type SortKey = string;

type SortDir = "asc" | "desc";
type SortState = { key: SortKey; dir: SortDir };

const DEFAULT_SORT: SortState = { key: "setupScore", dir: "desc" };

type SortValue = number | string | null;

// Nulls/missing sort last regardless of direction — a sparse column
// (e.g. Last Buy when a symbol somehow has no dated purchase) shouldn't
// push empty rows to the top just because the direction flipped.
function compareSortValues(a: SortValue, b: SortValue, dir: SortDir): number {
  const aMissing = a === null || (typeof a === "number" && !Number.isFinite(a));
  const bMissing = b === null || (typeof b === "number" && !Number.isFinite(b));
  if (aMissing && bMissing) return 0;
  if (aMissing) return 1;
  if (bMissing) return -1;
  const mult = dir === "asc" ? 1 : -1;
  if (typeof a === "string" || typeof b === "string") {
    return mult * String(a).localeCompare(String(b));
  }
  return mult * ((a as number) - (b as number));
}

function fmtMoney(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return `$${n.toFixed(digits)}`;
}

function fmtPct(n: number | null | undefined, digits = 1): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${(n * 100).toFixed(digits)}%`;
}

// Same as fmtPct but for fields that are ALREADY percent-scaled
// (TabStats.return3m/return1y come out of the snapshot cache as e.g.
// 12.5, not 0.125 — unlike move5dPct/vsMA50/pctFromHigh, which are
// decimal fractions).
function fmtPctNumber(n: number | null | undefined, digits = 1): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(digits)}%`;
}

function fmtRatio(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return `${n.toFixed(digits)}x`;
}

function fmtCompactMoney(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n) || n <= 0) return "—";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${Math.round(n / 1000)}K`;
  return `$${Math.round(n)}`;
}

function fmtDaysAgo(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  if (n <= 0) return "today";
  return `${n}d ago`;
}

function fmtRr(rr: number | null): { text: string; cls: string } {
  if (rr === null || !Number.isFinite(rr)) {
    return { text: "—", cls: "text-muted-foreground" };
  }
  const cls =
    rr >= 3 ? "text-emerald-300" : rr >= 2 ? "text-amber-300" : "text-rose-300";
  return { text: `${rr.toFixed(1)}:1`, cls };
}

// Insider $ / buyer-count / recency for rows saved before those fields
// existed on the candidate — derived client-side from the raw
// transaction list the same way lib/swing-screener.ts's
// insiderPurchaseBreakdown does server-side.
function insiderBreakdownOf(c: SwingCandidate): {
  dollars: number;
  buyers: number;
  lastBuyDaysAgo: number | null;
} {
  if (
    c.insiderBuyDollars !== undefined &&
    c.insiderBuyerCount !== undefined &&
    c.insiderLastBuyDaysAgo !== undefined
  ) {
    return {
      dollars: c.insiderBuyDollars,
      buyers: c.insiderBuyerCount,
      lastBuyDaysAgo: c.insiderLastBuyDaysAgo,
    };
  }
  const buys = c.insiderTransactions.filter((t) => t.transactionCode === "P");
  const dollars = buys.reduce((s, t) => s + t.dollarValue, 0);
  const buyers = new Set(buys.map((t) => t.name)).size;
  let lastBuyDaysAgo: number | null = null;
  for (const t of buys) {
    if (!t.date) continue;
    const days = Math.round(
      (Date.now() - new Date(t.date).getTime()) / (24 * 60 * 60 * 1000),
    );
    if (Number.isFinite(days) && (lastBuyDaysAgo === null || days < lastBuyDaysAgo)) {
      lastBuyDaysAgo = days;
    }
  }
  return { dollars, buyers, lastBuyDaysAgo };
}

// How far OTM the hottest call strike is positioned, as a % of price.
function strikeSkewPct(c: SwingCandidate): number | null {
  if (c.topOptionsStrike === null || c.currentPrice <= 0) return null;
  return (c.topOptionsStrike - c.currentPrice) / c.currentPrice;
}

type MetricColumn = {
  key: string;
  label: string;
  width: string;
  tooltip?: string;
  render: (c: SwingCandidate) => React.ReactNode;
  // Raw value to sort on (independent of the formatted render output) and
  // which direction "most interesting first" means for this column —
  // e.g. ascending for a metric where more negative is more extreme
  // (5D move, RSI, distance below a moving average), descending for
  // "more is more" metrics (buy $, volume ratio).
  sortValue: (c: SwingCandidate) => SortValue;
  defaultDir: SortDir;
};

const mutedRight = "text-right text-foreground";

// Every column here is something that tab's own qualifier or scorer
// reads (see lib/swing-screener.ts qualifiesCapitulation/qualifiesPullback/
// scoreInsiderConviction/scoreOptionsFlow) — the row should read as
// evidence for why the setup is on this tab, not a generic quote strip.
const TAB_COLUMNS: Record<SetupTab, MetricColumn[]> = {
  capitulation: [
    {
      key: "move5d",
      label: "5D Move",
      width: "70px",
      tooltip: "Cumulative move over ~5 trading days. Qualifies at ≤ -12%.",
      render: (c) => (
        <span className={mutedRight}>
          {fmtPct(c.capitulationStats?.move5dPct ?? c.tabStats?.move5dPct, 0)}
        </span>
      ),
      sortValue: (c) => c.capitulationStats?.move5dPct ?? c.tabStats?.move5dPct ?? null,
      defaultDir: "asc",
    },
    {
      key: "rsi14",
      label: "RSI14",
      width: "60px",
      tooltip: "14-day RSI. Qualifies below 40 — lower reads more oversold.",
      render: (c) => {
        const rsi = c.capitulationStats?.rsi14 ?? c.tabStats?.rsi14 ?? null;
        const cls =
          rsi !== null && rsi < 30
            ? "text-emerald-300"
            : rsi !== null && rsi < 40
              ? "text-amber-300"
              : "text-foreground";
        return (
          <span className={`text-right ${cls}`}>
            {rsi !== null ? rsi.toFixed(0) : "—"}
          </span>
        );
      },
      sortValue: (c) => c.capitulationStats?.rsi14 ?? c.tabStats?.rsi14 ?? null,
      defaultDir: "asc",
    },
    {
      key: "vsma50cap",
      label: "vs 50MA",
      width: "70px",
      tooltip:
        "% below the 50d MA — the trend break this setup is capitulating out of.",
      render: (c) => (
        <span
          className={`text-right ${c.vsMA50 < 0 ? "text-rose-300" : "text-foreground"}`}
        >
          {fmtPct(c.vsMA50, 1)}
        </span>
      ),
      sortValue: (c) => c.vsMA50,
      defaultDir: "asc",
    },
    {
      key: "volratiocap",
      label: "Vol×Avg",
      width: "70px",
      tooltip:
        "Today's volume ÷ 10-day average. >1.5x scores as seller-exhaustion.",
      render: (c) => (
        <span
          className={`text-right ${c.volumeRatio > 1.5 ? "text-emerald-300" : "text-foreground"}`}
        >
          {fmtRatio(c.volumeRatio, 1)}
        </span>
      ),
      sortValue: (c) => c.volumeRatio,
      defaultDir: "desc",
    },
  ],
  pullback: [
    {
      key: "ret3m",
      label: "3M Ret",
      width: "70px",
      tooltip: "3-month return. Stronger trend scores higher (≥20% is top tier).",
      render: (c) => (
        <span className={mutedRight}>
          {fmtPctNumber(c.pullbackStats?.return3m ?? c.tabStats?.return3m)}
        </span>
      ),
      sortValue: (c) => c.pullbackStats?.return3m ?? c.tabStats?.return3m ?? null,
      defaultDir: "desc",
    },
    {
      key: "vsma50pb",
      label: "vs 50MA",
      width: "70px",
      tooltip: "Tightness of the pullback to the 50d MA — the support being tested.",
      render: (c) => (
        <span
          className={`text-right ${Math.abs(c.vsMA50) <= 0.02 ? "text-emerald-300" : "text-foreground"}`}
        >
          {fmtPct(c.vsMA50, 1)}
        </span>
      ),
      sortValue: (c) => c.vsMA50,
      defaultDir: "asc",
    },
    {
      key: "fromhighpb",
      label: "From High",
      width: "80px",
      tooltip: "Depth off the 52-week high. Qualifies at -5% to -12% — an orderly dip.",
      render: (c) => <span className={mutedRight}>{fmtPct(c.pctFromHigh, 0)}</span>,
      sortValue: (c) => c.pctFromHigh,
      defaultDir: "asc",
    },
  ],
  insider: [
    {
      key: "buydollars",
      label: "Buy $",
      width: "80px",
      tooltip: "Total open-market (Form 4 code P) purchase dollars.",
      render: (c) => (
        <span className={mutedRight}>{fmtCompactMoney(insiderBreakdownOf(c).dollars)}</span>
      ),
      sortValue: (c) => insiderBreakdownOf(c).dollars,
      defaultDir: "desc",
    },
    {
      key: "buyers",
      label: "Buyers",
      width: "60px",
      tooltip: "Distinct insiders who bought. 3+ scores as broad conviction.",
      render: (c) => <span className={mutedRight}>{insiderBreakdownOf(c).buyers || "—"}</span>,
      sortValue: (c) => insiderBreakdownOf(c).buyers,
      defaultDir: "desc",
    },
    {
      key: "lastbuy",
      label: "Last Buy",
      width: "80px",
      tooltip: "Days since the most recent open-market buy. Within 7d scores highest.",
      render: (c) => (
        <span className={mutedRight}>{fmtDaysAgo(insiderBreakdownOf(c).lastBuyDaysAgo)}</span>
      ),
      sortValue: (c) => insiderBreakdownOf(c).lastBuyDaysAgo,
      defaultDir: "asc",
    },
    {
      key: "vsma200ins",
      label: "vs 200MA",
      width: "70px",
      tooltip:
        "Trend sanity gate: insider buying below -25% vs the 200d MA is excluded (averaging down, not a swing setup).",
      render: (c) => (
        <span
          className={`text-right ${c.vsMA200 < -0.25 ? "text-rose-300" : "text-foreground"}`}
        >
          {fmtPct(c.vsMA200, 1)}
        </span>
      ),
      sortValue: (c) => c.vsMA200,
      defaultDir: "asc",
    },
  ],
  options_flow: [
    {
      key: "voloi",
      label: "Vol/OI",
      width: "70px",
      tooltip: "Hottest call strike's volume ÷ open interest. >0.5x qualifies as unusual.",
      render: (c) => <span className={mutedRight}>{fmtRatio(c.callVolumeOiRatio)}</span>,
      sortValue: (c) => c.callVolumeOiRatio,
      defaultDir: "desc",
    },
    {
      key: "skew",
      label: "Strike Skew",
      width: "90px",
      tooltip: "How far OTM the hottest strike sits, as % of price.",
      render: (c) => <span className={mutedRight}>{fmtPct(strikeSkewPct(c), 1)}</span>,
      sortValue: (c) => strikeSkewPct(c),
      defaultDir: "desc",
    },
    {
      key: "voloptions",
      label: "Vol×Avg",
      width: "70px",
      tooltip: "Today's share volume ÷ 10-day average.",
      render: (c) => <span className={mutedRight}>{fmtRatio(c.volumeRatio, 1)}</span>,
      sortValue: (c) => c.volumeRatio,
      defaultDir: "desc",
    },
    {
      key: "expiry",
      label: "Expiry",
      width: "90px",
      tooltip: "Expiration date of the hottest call contract.",
      render: (c) => (
        <span className={mutedRight}>{fmtCalendarDate(c.topOptionsExpiry)}</span>
      ),
      sortValue: (c) => c.topOptionsExpiry,
      defaultDir: "asc",
    },
  ],
};

// Mobile stays a fixed 5-col strip (Symbol/Price/Chg%/Score/Actions) —
// same across tabs. Desktop column count varies by tab (3-4 metric
// columns), so each tab gets its own literal grid-cols class: Tailwind's
// scanner needs the full class text present in source, not assembled
// from a runtime template string.
const ROW_GRID_MOBILE =
  "grid-cols-[minmax(60px,1fr)_70px_60px_60px_minmax(80px,1fr)]";
const ROW_GRID_DESKTOP: Record<SetupTab, string> = {
  capitulation:
    "md:grid-cols-[minmax(60px,80px)_minmax(120px,1.5fr)_80px_70px_70px_60px_70px_70px_70px_minmax(120px,1fr)_190px]",
  pullback:
    "md:grid-cols-[minmax(60px,80px)_minmax(120px,1.5fr)_80px_70px_70px_70px_80px_70px_minmax(120px,1fr)_190px]",
  insider:
    "md:grid-cols-[minmax(60px,80px)_minmax(120px,1.5fr)_80px_70px_80px_60px_80px_70px_70px_minmax(120px,1fr)_190px]",
  options_flow:
    "md:grid-cols-[minmax(60px,80px)_minmax(120px,1.5fr)_80px_70px_70px_90px_70px_90px_70px_minmax(120px,1fr)_190px]",
};

function rowGridClass(tab: SetupTab): string {
  return `grid w-full items-center gap-2 px-3 ${ROW_GRID_MOBILE} ${ROW_GRID_DESKTOP[tab]}`;
}

function fmtRelDate(iso: string | null): string {
  if (!iso) return "never";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "unknown";
  return (
    d.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    }) +
    " at " +
    d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
  );
}

function fmtCalendarDate(iso: string | null): string {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

// Columns common to every tab, regardless of which metric columns that
// tab adds. Score is tab-relative (each tab ranks its own way), so its
// value extractor needs the active tab.
const COMMON_SORT_VALUES: Record<
  string,
  { value: (c: SwingCandidate, activeTab: SetupTab) => SortValue; defaultDir: SortDir }
> = {
  symbol: { value: (c) => c.symbol, defaultDir: "asc" },
  company: { value: (c) => c.companyName, defaultDir: "asc" },
  currentPrice: { value: (c) => c.currentPrice, defaultDir: "desc" },
  priceChange1d: { value: (c) => c.priceChange1d, defaultDir: "desc" },
  setupScore: { value: (c, activeTab) => tabScoreOf(c, activeTab), defaultDir: "desc" },
  signalCount: { value: (c) => c.signalCount, defaultDir: "desc" },
};

function sortDescriptor(
  key: SortKey,
  activeTab: SetupTab,
): { value: (c: SwingCandidate) => SortValue; defaultDir: SortDir } | null {
  const common = COMMON_SORT_VALUES[key];
  if (common) return { value: (c) => common.value(c, activeTab), defaultDir: common.defaultDir };
  const col = TAB_COLUMNS[activeTab].find((c) => c.key === key);
  if (col) return { value: col.sortValue, defaultDir: col.defaultDir };
  return null;
}

function sortCandidates(
  list: SwingCandidate[],
  sort: SortState,
  activeTab: SetupTab,
): SwingCandidate[] {
  const desc = sortDescriptor(sort.key, activeTab);
  return [...list].sort((a, b) => {
    const primary = desc
      ? compareSortValues(desc.value(a), desc.value(b), sort.dir)
      : 0;
    if (primary !== 0) return primary;
    // Stable-ish tiebreaker so re-sorts don't churn order on ties.
    return a.symbol.localeCompare(b.symbol);
  });
}

type RunPhase = "idle" | "pass1" | "pass2" | "pass3" | "saving";

// Fetch + parse defensively. Vercel kills a function that exceeds the
// 60s production ceiling with a PLAIN-TEXT body ("An error occurred…"),
// which res.json() turns into a useless "Unexpected token 'A'" parse
// error — so read text first and translate non-JSON bodies into a
// labelled, human-readable failure for the banner.
async function fetchPassJson<T>(
  label: string,
  url: string,
  init?: RequestInit,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { cache: "no-store", ...init });
  } catch (e) {
    throw new Error(
      `${label} failed — network error (${e instanceof Error ? e.message : "unknown"})`,
    );
  }
  const text = await res.text();
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = null;
  }
  if (!res.ok || json === null) {
    const detail =
      json && typeof json.error === "string"
        ? json.error
        : /^an error occurred/i.test(text.trim())
          ? `the server timed out (HTTP ${res.status} — Vercel 60s function ceiling)`
          : `HTTP ${res.status}${text ? ` — ${text.slice(0, 120).trim()}` : ""}`;
    throw new Error(`${label} failed — ${detail}`);
  }
  return json as T;
}

type Pass1Wire = {
  survivors: string[];
  screened: number;
  errors: string[];
  quotes: Record<string, unknown>;
  trades: Record<string, unknown>;
  tier2ByCandidate: Record<string, string[]>;
  durationMs?: number;
};

export function SwingScreenView() {
  const [data, setData] = useState<CachedResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [phase, setPhase] = useState<RunPhase>("idle");
  // Survivor count from pass 1 — shown in the inter-pass progress text so
  // the user knows how many symbols pass 2 is enriching.
  const [pass1Count, setPass1Count] = useState<number | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  // Non-fatal degradation (pass 3 or save failed but results exist).
  const [runWarning, setRunWarning] = useState<string | null>(null);
  const [sort, setSort] = useState<SortState>(DEFAULT_SORT);
  const [importOpen, setImportOpen] = useState(false);
  // Which symbol Enter was clicked for, so the import modal opens
  // knowing what it's importing a fill for instead of blank/generic.
  const [importSymbol, setImportSymbol] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  // Symbols tracked to the Kanban this session — lets the Track button
  // flip to a disabled "Tracked" state without re-fetching the ideas
  // list just to check membership.
  const [trackedSymbols, setTrackedSymbols] = useState<Set<string>>(new Set());
  const [trackingSymbol, setTrackingSymbol] = useState<string | null>(null);
  // One Run Screen populates all four setup tabs; Capitulation is the
  // default view. Tab membership is baked into each candidate
  // (setupTabs) so the split survives reload via the saved run.
  const [activeTab, setActiveTab] = useState<SetupTab>("capitulation");

  const running = phase !== "idle";

  async function loadCached() {
    try {
      const res = await fetch("/api/swings/screen", { cache: "no-store" });
      const json = (await res.json()) as CachedResult & { error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setData({
        ...json,
        candidates: (json.candidates ?? []).map(normalizeCandidate),
      });
    } catch (e) {
      setRunError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadCached();
  }, []);

  async function runScreen() {
    setRunError(null);
    setRunWarning(null);
    setPass1Count(null);
    const started = Date.now();
    try {
      // Pass 1 — Yahoo technical filter + tab qualification on the
      // full universe (~20-40s). A failure here aborts the run.
      setPhase("pass1");
      const p1 = await fetchPassJson<Pass1Wire>(
        "Pass 1 (technical filter)",
        "/api/swings/screen/pass1",
        { method: "POST" },
      );
      setPass1Count(p1.survivors.length);

      // Pass 2 — Finnhub insider + earnings + Schwab options on
      // survivors. A failure here also aborts (no candidates exist
      // without it).
      setPhase("pass2");
      const p2 = await fetchPassJson<{ candidates?: SwingCandidate[] }>(
        "Pass 2 (insider/options enrichment)",
        "/api/swings/screen/pass2",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(p1),
        },
      );
      const enriched = p2.candidates ?? [];

      // Pass 3 — Perplexity catalyst discovery. NON-FATAL: if it
      // fails, the run continues with pass-2 candidates (tabs intact,
      // catalysts empty) and the banner explains the degradation.
      setPhase("pass3");
      // Carry forward catalysts from the prior run when it's < 24h
      // old — Perplexity enrichment is expensive and a catalyst found
      // this morning is still the catalyst this afternoon.
      const knownCatalysts: Record<string, unknown> = {};
      if (
        data?.screenedAt &&
        Date.now() - new Date(data.screenedAt).getTime() < 24 * 3600_000
      ) {
        for (const prev of data.candidates) {
          if (prev.catalystRawResponse === null && !prev.catalystFound) continue;
          knownCatalysts[prev.symbol.toUpperCase()] = {
            catalystFound: prev.catalystFound,
            catalystType: prev.catalystType,
            catalystDate: prev.catalystDate,
            catalystDescription: prev.catalystDescription,
            catalystConfidence: prev.catalystConfidence,
            catalystInsiderAngle: prev.catalystInsiderAngle,
            catalystRawResponse: prev.catalystRawResponse,
          };
        }
      }
      let candidates: SwingCandidate[];
      try {
        const p3 = await fetchPassJson<{ candidates?: SwingCandidate[] }>(
          "Pass 3 (catalyst research)",
          "/api/swings/screen/pass3",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ candidates: enriched, knownCatalysts }),
          },
        );
        candidates = (p3.candidates ?? enriched).map(normalizeCandidate);
      } catch (e) {
        candidates = enriched.map(normalizeCandidate);
        setRunWarning(
          `${e instanceof Error ? e.message : "Pass 3 failed"}. Showing the screen without catalyst enrichment — all four tabs are still populated.`,
        );
      }

      const result: CachedResult = {
        candidates,
        screened: p1.screened,
        pass1Survivors: p1.survivors.length,
        pass2Results: candidates.length,
        durationMs: Date.now() - started,
        errors: p1.errors ?? [],
        screenedAt: new Date().toISOString(),
      };

      // Save — fast (<1s). NON-FATAL: failure keeps the visible
      // result, it just won't survive a reload.
      setPhase("saving");
      try {
        await fetchPassJson<{ ok?: boolean }>(
          "Save",
          "/api/swings/screen/save",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              candidates: result.candidates,
              screened: result.screened,
              pass1Survivors: result.pass1Survivors,
              pass2Results: result.pass2Results,
              durationMs: result.durationMs,
            }),
          },
        );
      } catch (e) {
        console.warn("[swing-screen] save failed:", e);
        setRunWarning(
          (prev) =>
            prev ??
            "Results shown but could not be saved — they won't survive a page reload.",
        );
      }

      setData(result);
    } catch (e) {
      setRunError(e instanceof Error ? e.message : "Screen failed");
    } finally {
      setPhase("idle");
      setPass1Count(null);
    }
  }

  // Save the candidate to the Swing Ideas Kanban as setup_ready, carrying
  // everything the screener knows — levels, the tab + its score, signals,
  // and the catalyst text as the initial thesis. Frozen at this moment:
  // nothing here gets recomputed later as the stock moves.
  async function handleTrack(c: SwingCandidate, tab: SetupTab) {
    setTrackingSymbol(c.symbol);
    try {
      const score = tabScoreOf(c, tab);
      const body = {
        symbol: c.symbol,
        catalyst: c.catalystType !== "none" ? catalystTypeLabel(c.catalystType) : null,
        user_thesis:
          c.catalystDescription ??
          `Tracked from Discover → ${TAB_LABEL[tab]} (score ${score}/10).`,
        analyst_sentiment: "bullish",
        analyst_target: c.analystTarget,
        price_at_discovery: c.currentPrice,
        source: "screener_track",
        source_tab: tab,
        source_score: score,
        entry_price: c.entryPrice,
        target_price: c.targetPrice,
        stop_price: c.stopPrice,
        rr: c.rr,
        atr14: c.atr14 ?? null,
        tier1_signals: c.tier1Signals,
        tier2_signals: c.tier2Signals,
        red_flags: c.redFlags,
        catalyst_type: c.catalystType,
        catalyst_confidence: c.catalystConfidence,
      };
      const res = await fetch("/api/swings/ideas", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setTrackedSymbols((prev) => new Set(prev).add(c.symbol));
      setToast(`Tracked ${c.symbol} to Setup Ready`);
      setTimeout(() => setToast(null), 5000);
    } catch (e) {
      setToast(
        `Failed to track ${c.symbol}: ${e instanceof Error ? e.message : "unknown error"}`,
      );
      setTimeout(() => setToast(null), 5000);
    } finally {
      setTrackingSymbol(null);
    }
  }

  const tabCounts = useMemo(() => {
    const counts: Record<SetupTab, number> = {
      capitulation: 0,
      pullback: 0,
      insider: 0,
      options_flow: 0,
    };
    for (const c of data?.candidates ?? []) {
      for (const t of candidateTabs(c)) counts[t] += 1;
    }
    return counts;
  }, [data]);

  const sortedCandidates = useMemo(
    () =>
      sortCandidates(
        (data?.candidates ?? []).filter((c) =>
          candidateTabs(c).includes(activeTab),
        ),
        sort,
        activeTab,
      ),
    [data, sort, activeTab],
  );

  function handleHeaderClick(key: SortKey) {
    setSort((cur) => {
      if (cur.key !== key) {
        // Each column defines its own "most interesting first" direction
        // (see COMMON_SORT_VALUES / TAB_COLUMNS[...].defaultDir) — e.g.
        // descending for buy $, ascending for RSI/5D move where more
        // negative is more extreme.
        const d = sortDescriptor(key, activeTab);
        return { key, dir: d?.defaultDir ?? "desc" };
      }
      return { key, dir: cur.dir === "asc" ? "desc" : "asc" };
    });
  }

  // Each tab has its own column set and its own notion of "most
  // interesting" — switching tabs resets to that tab's default (Score
  // descending) rather than carrying over a sort key that column may not
  // even have.
  function handleTabSelect(tab: SetupTab) {
    setActiveTab(tab);
    setSort(DEFAULT_SORT);
  }

  return (
    <TooltipProvider delayDuration={200}>
    <div className="space-y-4">
      <ControlsBar
        data={data}
        loading={loading}
        running={running}
        onRun={runScreen}
      />

      {running && <RunningBanner phase={phase} pass1Count={pass1Count} />}
      {runError && (
        <div className="rounded border border-rose-500/40 bg-rose-500/10 p-3 text-base text-rose-300">
          {runError}
        </div>
      )}
      {runWarning && (
        <div className="rounded border border-amber-500/40 bg-amber-500/10 p-3 text-base text-amber-200">
          {runWarning}
        </div>
      )}
      {toast && (
        <div className="rounded border border-emerald-500/40 bg-emerald-500/10 p-3 text-base text-emerald-300">
          {toast}
        </div>
      )}

      {loading ? (
        <div className="rounded border border-border bg-background/40 p-6 text-base text-muted-foreground">
          Loading cached screen…
        </div>
      ) : !data || data.screenedAt === null ? (
        <EmptyStateNoScan />
      ) : (
        <>
          <SetupTabBar
            active={activeTab}
            counts={tabCounts}
            onSelect={handleTabSelect}
          />
          {sortedCandidates.length === 0 ? (
            data.candidates.length === 0 ? (
              <EmptyStateNoResults data={data} />
            ) : (
              <EmptyTab tab={activeTab} />
            )
          ) : (
            <ResultsTable
              candidates={sortedCandidates}
              sort={sort}
              activeTab={activeTab}
              onSort={handleHeaderClick}
              onEnterTrade={(symbol) => {
                setImportSymbol(symbol);
                setImportOpen(true);
              }}
              onTrack={handleTrack}
              trackedSymbols={trackedSymbols}
              trackingSymbol={trackingSymbol}
            />
          )}
        </>
      )}

      <ImportStockScreenshotModal
        open={importOpen}
        symbol={importSymbol}
        onOpenChange={(v) => {
          setImportOpen(v);
          if (!v) setImportSymbol(null);
        }}
        onSuccess={(msg) => {
          setToast(msg);
          setTimeout(() => setToast(null), 5000);
        }}
      />
    </div>
    </TooltipProvider>
  );
}

function ControlsBar({
  data,
  loading,
  running,
  onRun,
}: {
  data: CachedResult | null;
  loading: boolean;
  running: boolean;
  onRun: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-background/40 p-3">
      <div className="flex flex-col gap-0.5">
        <div className="text-sm text-muted-foreground">
          Last screened:{" "}
          <span className="text-foreground">{fmtRelDate(data?.screenedAt ?? null)}</span>
        </div>
        {data && data.screenedAt !== null && (
          <div className="text-sm text-muted-foreground">
            <span className="text-foreground">{data.candidates.length}</span> setups
            from <span className="text-foreground">{data.screened}</span> stocks
            screened ·{" "}
            <span className="text-foreground">{data.pass1Survivors}</span> passed
            technical filter
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={onRun}
        disabled={loading || running}
        className="inline-flex items-center gap-2 rounded-md border border-border bg-emerald-500/10 px-3 py-1.5 text-base font-medium text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-50"
      >
        {running ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Zap className="h-4 w-4" />
        )}
        {running ? "Running…" : "Run Screen"}
      </button>
    </div>
  );
}

function RunningBanner({
  phase,
  pass1Count,
}: {
  phase: RunPhase;
  pass1Count: number | null;
}) {
  const { title, detail } = (() => {
    if (phase === "pass1") {
      return {
        title: "Pass 1 — technical filter",
        detail:
          "Scanning ~580 S&P 500 + Nasdaq 100 stocks for setups (price/MA/52w range/R-R). ~15-25 seconds.",
      };
    }
    if (phase === "pass2") {
      const n = pass1Count ?? "—";
      return {
        title: `Pass 2 — enriching ${n} survivors`,
        detail:
          "Pulling Finnhub insider transactions + earnings dates and Schwab options flow on candidates that survive the technical filter. ~25-45 seconds.",
      };
    }
    if (phase === "pass3") {
      return {
        title: "Pass 3 — finding catalysts",
        detail:
          "Perplexity catalyst research on the Tier-1 survivors (product launches, FDA decisions, partnerships, etc.). ~15-30 seconds.",
      };
    }
    if (phase === "saving") {
      return {
        title: "Saving results…",
        detail: "Writing to swing_screen_results.",
      };
    }
    return { title: "Working…", detail: "" };
  })();
  return (
    <div className="flex items-start gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-base text-amber-200">
      <RefreshCw className="mt-0.5 h-4 w-4 animate-spin shrink-0" />
      <div className="space-y-1">
        <div className="font-medium">{title}</div>
        {detail && <div className="text-sm text-amber-200/80">{detail}</div>}
      </div>
    </div>
  );
}

function SetupTabBar({
  active,
  counts,
  onSelect,
}: {
  active: SetupTab;
  counts: Record<SetupTab, number>;
  onSelect: (tab: SetupTab) => void;
}) {
  const blurb = SETUP_TABS.find((t) => t.key === active)?.blurb ?? "";
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap gap-1 rounded-md border border-border bg-background/40 p-1">
        {SETUP_TABS.map((t) => {
          const isActive = t.key === active;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => onSelect(t.key)}
              className={`inline-flex items-center gap-1.5 rounded px-3 py-1.5 text-sm font-medium transition ${
                isActive
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {t.label}
              <span
                className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${
                  isActive
                    ? "bg-emerald-500/20 text-emerald-300"
                    : "bg-muted text-muted-foreground"
                }`}
              >
                {counts[t.key]}
              </span>
            </button>
          );
        })}
      </div>
      <div className="px-1 text-[11px] text-muted-foreground/80">{blurb}</div>
    </div>
  );
}

function EmptyTab({ tab }: { tab: SetupTab }) {
  return (
    <div className="rounded-md border border-dashed border-border bg-background/40 p-8 text-center">
      <div className="text-base font-medium">
        No {TAB_LABEL[tab].toLowerCase()} setups in this screen
      </div>
      <p className="mx-auto mt-1.5 max-w-xl text-sm text-muted-foreground">
        Nothing in the last run qualified for this setup type. Check the
        other tabs or re-run the screen later.
      </p>
    </div>
  );
}

function EmptyStateNoScan() {
  return (
    <div className="rounded-md border border-dashed border-border bg-background/40 p-10 text-center">
      <div className="text-lg font-medium">No screens run yet</div>
      <p className="mx-auto mt-2 max-w-xl text-base text-muted-foreground">
        Click <span className="font-medium text-foreground">Run Screen</span> to
        scan S&amp;P 500 + Nasdaq 100 for swing setups.
      </p>
    </div>
  );
}

function EmptyStateNoResults({ data }: { data: CachedResult }) {
  return (
    <div className="rounded-md border border-dashed border-border bg-background/40 p-10 text-center">
      <div className="text-lg font-medium">No setups today</div>
      <p className="mx-auto mt-2 max-w-xl text-base text-muted-foreground">
        Market conditions don&rsquo;t favor swing setups right now. Try again
        tomorrow.
      </p>
      <p className="mx-auto mt-3 text-sm text-muted-foreground">
        Screened <span className="text-foreground">{data.screened}</span>{" "}
        stocks · <span className="text-foreground">{data.pass1Survivors}</span>{" "}
        passed technical filter ·{" "}
        <span className="text-foreground">{data.pass2Results}</span> passed
        signal filter
      </p>
    </div>
  );
}

function ResultsTable({
  candidates,
  sort,
  activeTab,
  onSort,
  onEnterTrade,
  onTrack,
  trackedSymbols,
  trackingSymbol,
}: {
  candidates: SwingCandidate[];
  sort: SortState;
  activeTab: SetupTab;
  onSort: (key: SortKey) => void;
  onEnterTrade: (symbol: string) => void;
  onTrack: (candidate: SwingCandidate, tab: SetupTab) => void;
  trackedSymbols: Set<string>;
  trackingSymbol: string | null;
}) {
  return (
    <div className="space-y-1">
      <TableHeader sort={sort} onSort={onSort} activeTab={activeTab} />
      <div className="space-y-1">
        {candidates.map((c) => (
          <CandidateRow
            key={c.symbol}
            candidate={c}
            activeTab={activeTab}
            onEnterTrade={() => onEnterTrade(c.symbol)}
            onTrack={() => onTrack(c, activeTab)}
            tracked={trackedSymbols.has(c.symbol)}
            tracking={trackingSymbol === c.symbol}
          />
        ))}
      </div>
    </div>
  );
}

function TableHeader({
  sort,
  onSort,
  activeTab,
}: {
  sort: SortState;
  onSort: (key: SortKey) => void;
  activeTab: SetupTab;
}) {
  return (
    <div
      className={`${rowGridClass(activeTab)} border-b border-border/60 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground`}
    >
      <SortHeader label="Symbol" sortKey="symbol" sort={sort} onSort={onSort} />
      <SortHeader
        label="Company"
        sortKey="company"
        sort={sort}
        onSort={onSort}
        className="hidden md:block"
      />
      <SortHeader
        label="Price"
        sortKey="currentPrice"
        sort={sort}
        onSort={onSort}
        align="right"
      />
      <SortHeader
        label="Chg %"
        sortKey="priceChange1d"
        sort={sort}
        onSort={onSort}
        align="right"
      />
      {TAB_COLUMNS[activeTab].map((col) => (
        <SortHeader
          key={col.key}
          label={col.label}
          sortKey={col.key}
          sort={sort}
          onSort={onSort}
          align="right"
          className="hidden md:block"
          tooltip={col.tooltip}
        />
      ))}
      <SortHeader
        label="Score"
        sortKey="setupScore"
        sort={sort}
        onSort={onSort}
        align="center"
        tooltip={
          "Setup score out of 10 — this tab's own ranking (see the tab blurb above).\n\n" +
          "+2 open-market insider purchase >$100K\n" +
          "+2 unusual options activity (vol/OI >0.5x)\n" +
          "+2 high-confidence near-term catalyst (Perplexity)\n" +
          "+1 medium-confidence catalyst\n" +
          "+1 volume spike (>2× average, price up)\n" +
          "+1 short float >15%\n" +
          "+1 within 2% of 50d MA\n" +
          "-2 insider selling (bearish signal on a bullish-only screener)\n\n" +
          "R/R is shown separately as a trade-geometry sanity check — it does " +
          "not feed this score.\n\n" +
          "7–10 = strong · 4–6 = decent · <4 = marginal"
        }
      />
      <SortHeader
        label="Signals"
        sortKey="signalCount"
        sort={sort}
        onSort={onSort}
        className="hidden md:block"
      />
      <SortHeader label="Actions" align="right" />
    </div>
  );
}

function SortHeader({
  label,
  sortKey,
  sort,
  onSort,
  className = "",
  align = "left",
  tooltip,
}: {
  label: string;
  sortKey?: SortKey;
  sort?: SortState;
  onSort?: (k: SortKey) => void;
  className?: string;
  align?: "left" | "right" | "center";
  tooltip?: React.ReactNode;
}) {
  const justify =
    align === "right"
      ? "justify-end"
      : align === "center"
        ? "justify-center"
        : "justify-start";
  // The label itself is the dotted-underline target when a tooltip is set
  // — keeps the affordance on the text, not the surrounding button chrome.
  const labelEl = tooltip ? <Tipped content={tooltip}>{label}</Tipped> : <span>{label}</span>;
  if (!sortKey || !sort || !onSort) {
    return (
      <div className={`flex items-center gap-1 ${justify} ${className}`}>
        {labelEl}
      </div>
    );
  }
  const isActive = sort.key === sortKey;
  return (
    <button
      type="button"
      onClick={() => onSort(sortKey)}
      className={`flex items-center gap-1 ${justify} ${className} ${
        isActive ? "text-foreground" : "hover:text-foreground"
      }`}
    >
      {labelEl}
      {isActive && (
        <span className="text-[9px]">{sort.dir === "asc" ? "▲" : "▼"}</span>
      )}
    </button>
  );
}

// ---------- Row ----------

function CandidateRow({
  candidate: c,
  activeTab,
  onEnterTrade,
  onTrack,
  tracked,
  tracking,
}: {
  candidate: SwingCandidate;
  activeTab: SetupTab;
  onEnterTrade: () => void;
  onTrack: () => void;
  tracked: boolean;
  tracking: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  // Chart state lives at the row level (not in ExpandedDetail) so collapsing
  // and re-expanding doesn't drop the cached payload.
  const [chartData, setChartData] = useState<ChartPoint[] | null>(null);
  const [chartLoading, setChartLoading] = useState(false);
  const [chartError, setChartError] = useState<string | null>(null);
  // Tracks the symbol we've already kicked off a fetch for, so the effect
  // doesn't re-trigger when chartLoading flips. Including chartLoading in
  // the deps array dead-locked the effect: the cleanup fired on the
  // re-render mid-fetch, every setState was gated behind !cancelled, and
  // chartLoading was never reset to false → permanent skeleton.
  const fetchedSymbolRef = useRef<string | null>(null);

  useEffect(() => {
    if (!expanded) return;
    if (fetchedSymbolRef.current === c.symbol) return;
    fetchedSymbolRef.current = c.symbol;

    let cancelled = false;
    setChartLoading(true);
    setChartError(null);
    setChartData(null);
    (async () => {
      try {
        const res = await fetch(
          `/api/swings/screen/chart?symbol=${encodeURIComponent(c.symbol)}`,
          { cache: "no-store" },
        );
        const json = (await res.json().catch(() => ({}))) as {
          data?: ChartPoint[];
          error?: string;
        };
        if (!res.ok) {
          throw new Error(json.error ?? `HTTP ${res.status}`);
        }
        if (!cancelled) setChartData(json.data ?? []);
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Chart load failed";
        if (!cancelled) setChartError(msg);
        // Allow a retry on next expand if the failure was transient.
        fetchedSymbolRef.current = null;
      } finally {
        // Always reset loading regardless of cancellation — leaving it
        // true on cancel was the original deadlock.
        setChartLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [expanded, c.symbol]);

  const changeColor =
    !Number.isFinite(c.priceChange1d)
      ? "text-muted-foreground"
      : c.priceChange1d >= 0
        ? "text-emerald-300"
        : "text-rose-300";
  return (
    <div className="overflow-hidden rounded-md border border-border bg-background/30">
      <div className={`${rowGridClass(activeTab)} pt-2 text-sm`}>
        {/* 1. Symbol */}
        <div className="truncate text-left font-mono text-base font-semibold text-foreground">
          {c.symbol}
        </div>
        {/* 2. Company — hidden mobile */}
        <div className="hidden truncate text-left text-[11px] text-muted-foreground md:block">
          {c.companyName}
        </div>
        {/* 3. Price */}
        <div className="text-right font-mono text-foreground">
          {fmtMoney(c.currentPrice)}
        </div>
        {/* 4. Chg% */}
        <div className={`text-right ${changeColor}`}>
          {Number.isFinite(c.priceChange1d)
            ? `${c.priceChange1d >= 0 ? "▲" : "▼"}${Math.abs(c.priceChange1d).toFixed(2)}%`
            : "—"}
        </div>
        {/* 5+. Tab-specific metric columns — whatever this tab's own
            qualifier/scorer reads (see TAB_COLUMNS). */}
        {TAB_COLUMNS[activeTab].map((col) => (
          <div key={col.key} className="hidden md:block">
            {col.render(c)}
          </div>
        ))}
        {/* Score — the ACTIVE TAB's score (each tab ranks its own way) */}
        <div className="flex justify-center">
          <ScoreBadge score={tabScoreOf(c, activeTab)} />
        </div>
        {/* Signals — R/R rides along here as a muted sanity-check badge,
            not a ranked column: it's a trade-geometry check, not part of
            any tab's score. */}
        <div className="hidden flex-wrap items-center justify-start gap-1 md:flex">
          <SignalBadges
            tier1={c.tier1Signals}
            insiderSignal={c.insiderSignal}
            catalystConfidence={c.catalystConfidence}
            catalystDescription={c.catalystDescription}
          />
          <ConfluenceBadge candidate={c} activeTab={activeTab} />
          <RrBadge rr={c.rr} />
        </div>
        {/* 10. Actions */}
        <div
          className="flex items-center justify-end gap-1"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            onClick={onTrack}
            disabled={tracked || tracking}
            className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium ${
              tracked
                ? "cursor-default border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                : "border-border text-muted-foreground hover:bg-white/5 hover:text-foreground"
            }`}
            title={
              tracked
                ? `${c.symbol} is on the Setup Ready board`
                : `Save this setup — entry ${fmtMoney(c.entryPrice)}, target ${fmtMoney(c.targetPrice)}, stop ${fmtMoney(c.stopPrice)} — to the Swing Ideas Kanban as Setup Ready, before any money moves`
            }
          >
            {tracking ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : tracked ? (
              <BookmarkCheck className="h-3 w-3" />
            ) : (
              <Bookmark className="h-3 w-3" />
            )}
            {tracked ? "Tracked" : "Track"}
          </button>
          <Link
            href={`/research/${encodeURIComponent(c.symbol)}`}
            className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground hover:bg-white/5 hover:text-foreground"
            title="Open Deep Research for this symbol"
          >
            <BookSearch className="h-3 w-3" />
            Research
          </Link>
          <button
            type="button"
            onClick={onEnterTrade}
            className="inline-flex items-center gap-1 rounded border border-border bg-white/5 px-1.5 py-0.5 text-[10px] font-medium text-foreground hover:bg-white/10"
            title={`Import a broker fill screenshot for ${c.symbol} — links to the tracked idea if one exists`}
          >
            <Upload className="h-3 w-3" />
            Enter
          </button>
        </div>
      </div>
      <Line2
        candidate={c}
        activeTab={activeTab}
        expanded={expanded}
        onToggle={() => setExpanded((v) => !v)}
      />
      {expanded && (
        <ExpandedDetail
          candidate={c}
          chartData={chartData}
          chartLoading={chartLoading}
          chartError={chartError}
        />
      )}
    </div>
  );
}

// Confluence: a stock qualifying for multiple setup types is a
// feature — surface the OTHER tabs it also appears in.
function ConfluenceBadge({
  candidate: c,
  activeTab,
}: {
  candidate: SwingCandidate;
  activeTab: SetupTab;
}) {
  const others = candidateTabs(c).filter((t) => t !== activeTab);
  if (others.length === 0) return null;
  return (
    <span
      className="inline-flex items-center gap-1 rounded border border-sky-500/40 bg-sky-500/10 px-1 py-0.5 text-[9px] font-medium text-sky-300"
      title={`Also qualifies for: ${others.map((t) => TAB_LABEL[t]).join(", ")} — multi-setup confluence`}
    >
      ⧉ ALSO {others.map((t) => TAB_LABEL[t].toUpperCase()).join(" · ")}
    </span>
  );
}

// Trade-geometry sanity check, deliberately styled muted/secondary (not
// score-colored like ScoreBadge) — R/R does not feed any tab's score, it
// only tells you whether the entry/target/stop are worth placing an
// order against.
function RrBadge({ rr }: { rr: number | null }) {
  const { text, cls } = fmtRr(rr);
  return (
    <Tipped
      content={
        "Risk/Reward — trade geometry only, does NOT affect the score.\n" +
        "Formula: (Target − Entry) / (Entry − Stop)\n\n" +
        "Entry/target/stop are structural: stop = 1.5x ATR14 (or the 50d " +
        "MA / 52w low being defended, whichever is wider), target = the " +
        "nearer of analyst consensus and the 52-week high."
      }
    >
      <span
        className={`inline-flex items-center gap-1 rounded border border-border/60 bg-white/5 px-1 py-0.5 text-[9px] font-medium ${cls}`}
      >
        R/R {text}
      </span>
    </Tipped>
  );
}

function ScoreBadge({ score }: { score: number }) {
  const cls =
    score >= 7
      ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-300"
      : score >= 4
        ? "border-amber-500/40 bg-amber-500/15 text-amber-300"
        : "border-zinc-500/40 bg-zinc-500/15 text-zinc-300";
  return (
    <span
      className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold ${cls}`}
    >
      {score}/10
    </span>
  );
}

function SignalBadges({
  tier1,
  insiderSignal,
  catalystConfidence,
  catalystDescription,
}: {
  tier1: string[];
  insiderSignal: SwingCandidate["insiderSignal"];
  catalystConfidence: SwingCandidate["catalystConfidence"];
  catalystDescription: string | null;
}) {
  return (
    <>
      {tier1.includes("INSIDER_BUYING") && (
        <span
          className={`inline-flex items-center gap-1 rounded border px-1 py-0.5 text-[9px] font-medium ${
            insiderSignal === "strong_bullish"
              ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
              : "border-teal-500/40 bg-teal-500/10 text-teal-300"
          }`}
          title={`Insider signal: ${insiderSignal}`}
        >
          <Users className="h-3 w-3" />
          INSIDER
        </span>
      )}
      {tier1.includes("UNUSUAL_OPTIONS") && (
        <span
          className="inline-flex items-center gap-1 rounded border border-purple-500/40 bg-purple-500/10 px-1 py-0.5 text-[9px] font-medium text-purple-300"
          title="Unusual call options activity"
        >
          <TrendingUp className="h-3 w-3" />
          OPTIONS
        </span>
      )}
      <CatalystBadge
        confidence={catalystConfidence}
        description={catalystDescription}
      />
      {tier1.includes("VOLUME_SPIKE") && (
        <span
          className="inline-flex items-center gap-1 rounded border border-orange-500/40 bg-orange-500/10 px-1 py-0.5 text-[9px] font-medium text-orange-300"
          title="Today's volume > 2x 10-day average with price up"
        >
          <Zap className="h-3 w-3" />
          VOLUME
        </span>
      )}
    </>
  );
}

// Always renders — the point is that "no catalyst found" (most rows) is
// as visible at a glance as "found, high confidence" (a handful of
// rows), instead of a two-line prose block that only shows up for the
// found ones and dominates the row for everyone else. Full text (when
// there is any) lives in the tooltip, not inline.
function CatalystBadge({
  confidence,
  description,
}: {
  confidence: SwingCandidate["catalystConfidence"];
  description: string | null;
}) {
  const cls =
    confidence === "high"
      ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
      : confidence === "medium"
        ? "border-amber-500/40 bg-amber-500/10 text-amber-300"
        : confidence === "low"
          ? "border-zinc-500/40 bg-zinc-500/10 text-zinc-400"
          : "border-border/60 bg-white/5 text-muted-foreground/70";
  const label =
    confidence === "high"
      ? "CATALYST: HIGH"
      : confidence === "medium"
        ? "CATALYST: MED"
        : confidence === "low"
          ? "CATALYST: LOW"
          : "NO CATALYST";
  const tooltip = description
    ? description
    : confidence === "low"
      ? "Perplexity found nothing specific enough to call a real catalyst — treat as unconfirmed."
      : "Not researched, or Perplexity found no near-term catalyst (earnings alone doesn't count). +0 to score.";
  return (
    <Tipped content={tooltip}>
      <span
        className={`inline-flex items-center gap-1 rounded border px-1 py-0.5 text-[9px] font-medium ${cls}`}
      >
        <Target className="h-3 w-3" />
        {label}
      </span>
    </Tipped>
  );
}

function tier1Label(sig: string): string {
  if (sig === "INSIDER_BUYING") return "INSIDER BUYING";
  if (sig === "UNUSUAL_OPTIONS") return "UNUSUAL OPTIONS";
  if (sig === "VOLUME_SPIKE") return "VOLUME SPIKE";
  return sig;
}

function tier2Label(sig: string): string {
  if (sig === "AT_SUPPORT") return "at 52w support";
  if (sig === "MA50_RECLAIM") return "50d MA reclaim";
  if (sig === "PULLBACK_TO_MA") return "pullback to 50d MA";
  if (sig === "OVERSOLD_BOUNCE") return "oversold bounce";
  return sig;
}

function tier2Tooltip(sig: string, c: SwingCandidate): string {
  if (sig === "AT_SUPPORT") {
    return (
      `Price is within 5% above the 52-week low of ${fmtMoney(c.week52Low)}.\n\n` +
      `Buyers historically step in at 52w lows.\n` +
      `Risk is well-defined — stop goes just below this level.`
    );
  }
  if (sig === "MA50_RECLAIM") {
    return (
      `Price has crossed back above the 50d MA (${fmtMoney(c.ma50)}) after a drawdown — a fresh trend reclaim.\n\n` +
      `Currently ${fmtPct(c.vsMA50, 1)} from 50d MA, ${fmtPct(c.pctFromHigh, 0)} from 52w high.`
    );
  }
  if (sig === "PULLBACK_TO_MA") {
    return (
      `Price is within ±2% of the 50d MA (${fmtMoney(c.ma50)}) — testing the trendline as support.\n\n` +
      `Currently ${fmtPct(c.vsMA50, 1)} vs 50d MA, ${fmtPct(c.pctFromHigh, 0)} from 52w high.`
    );
  }
  if (sig === "OVERSOLD_BOUNCE") {
    return (
      `Stock is >40% off its 52-week high (${fmtPct(c.pctFromHigh, 0)}) with elevated volume and price up today (+${c.priceChange1d.toFixed(2)}%).\n\n` +
      `Volume ${c.volumeRatio.toFixed(2)}x 10-day average — capitulation/reversal signal.`
    );
  }
  return sig;
}

// Tier-1 presence is the qualifying criterion for Insider/Options Flow
// (that's literally what puts a candidate on those tabs), but
// Capitulation/Pullback qualify on price/technical criteria that have
// nothing to do with tier-1 signals — so "No tier-1 signals" there is
// empty by construction on nearly every row and reads as a permanent
// unresolved warning rather than useful information. Only show the line
// when there's something to say, or when its absence is actually
// meaningful (Insider/Options Flow).
function showsTier1Line(activeTab: SetupTab, tier1Text: string): boolean {
  return tier1Text.length > 0 || activeTab === "insider" || activeTab === "options_flow";
}

function Line2({
  candidate: c,
  activeTab,
  expanded,
  onToggle,
}: {
  candidate: SwingCandidate;
  activeTab: SetupTab;
  expanded: boolean;
  onToggle: () => void;
}) {
  const tier1Text = c.tier1Signals.map(tier1Label).join(" · ");
  const showTier1 = showsTier1Line(activeTab, tier1Text);
  const stopBasis = c.currentPrice > c.ma50 ? "50d MA" : "52-week low";
  const atrText =
    c.atr14 !== null && c.atr14 !== undefined ? fmtMoney(c.atr14) : "unavailable";
  const tradeTooltip =
    `Entry:  ${fmtMoney(c.entryPrice)} (current price)\n` +
    `Stop:   ${fmtMoney(c.stopPrice)}\n` +
    `  = tighter of 1.5x ATR14 (ATR ${atrText}) and just under the ${stopBasis}\n` +
    `  clamped to a 3-15% risk band\n` +
    `Target: ${fmtMoney(c.targetPrice)}\n` +
    `  = nearer of analyst mean (${fmtMoney(c.analystTarget)}) and 52w high (${fmtMoney(c.week52High)})\n\n` +
    `R/R = (${fmtMoney(c.targetPrice)} − ${fmtMoney(c.entryPrice)}) / ` +
    `(${fmtMoney(c.entryPrice)} − ${fmtMoney(c.stopPrice)}) = ${(c.rr ?? 0).toFixed(2)}:1 ` +
    `(sanity check only — not part of the score)`;
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onToggle}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onToggle();
        }
      }}
      className="flex cursor-pointer items-start gap-2 px-3 pb-2 pt-1 text-base text-muted-foreground hover:bg-white/[0.02]"
    >
      <span className="flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground/70">
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5" />
        )}
      </span>
      <div className="min-w-0 flex-1 line-clamp-2">
        {showTier1 && (
          <>
            <span className="text-foreground/90">
              📡 {tier1Text || "No tier-1 signals"}
            </span>
            <span className="px-1.5 text-muted-foreground/60">·</span>
          </>
        )}
        {c.tier2Signals.length > 0 && (
          <>
            {c.tier2Signals.map((sig, i) => (
              <Fragment key={sig}>
                {i > 0 && (
                  <span className="px-1.5 text-muted-foreground/60">·</span>
                )}
                <Tipped content={tier2Tooltip(sig, c)}>
                  {tier2Label(sig)}
                </Tipped>
              </Fragment>
            ))}
            <span className="px-1.5 text-muted-foreground/60">|</span>
          </>
        )}
        <Tipped content={tradeTooltip}>
          Entry {fmtMoney(c.entryPrice)} → Target {fmtMoney(c.targetPrice)} →
          Stop {fmtMoney(c.stopPrice)}
        </Tipped>
        <RedFlagBadges redFlags={c.redFlags} />
      </div>
    </div>
  );
}

// EARNINGS_TOO_SOON never reaches here (it's a hard exclude in pass 2,
// see lib/swing-screener.ts) — of the flags that do, INSIDER_SELLING now
// costs real score (see the -2 penalty note on the Score header), so it's
// styled as a penalty. HIGH_SHORT_* is genuinely ambiguous (squeeze fuel
// vs. bearish crowd conviction) and stays purely informational — styled
// to look distinctly less alarming than the flag that actually moves rank.
function RedFlagBadges({ redFlags }: { redFlags: string[] }) {
  if (redFlags.length === 0) return null;
  return (
    <>
      {redFlags.map((flag) => {
        const isPenalty = flag === "INSIDER_SELLING";
        const cls = isPenalty
          ? "border-rose-500/50 bg-rose-500/15 text-rose-300"
          : "border-border/60 bg-white/5 text-muted-foreground";
        const tooltip = isPenalty
          ? "Net insider selling — the inverse of the INSIDER_BUYING tier-1 " +
            "signal. -2 to every tab score this candidate qualifies for."
          : "Informational only — does not affect score or rank. Elevated " +
            "short interest is ambiguous: could mean squeeze fuel or bearish " +
            "crowd conviction, so there's no defensible direction to score it.";
        return (
          <Tipped key={flag} content={tooltip}>
            <span
              className={`ml-1.5 inline-flex items-center gap-1 rounded border px-1 py-0.5 text-[10px] font-medium ${cls}`}
            >
              <AlertTriangle className="h-3 w-3" />
              {flag}
              {isPenalty ? " (-2)" : ""}
            </span>
          </Tipped>
        );
      })}
    </>
  );
}

// ---------- Expanded detail ----------

function ExpandedDetail({
  candidate: c,
  chartData,
  chartLoading,
  chartError,
}: {
  candidate: SwingCandidate;
  chartData: ChartPoint[] | null;
  chartLoading: boolean;
  chartError: string | null;
}) {
  const upsidePct =
    c.entryPrice > 0 ? (c.targetPrice - c.entryPrice) / c.entryPrice : 0;
  const stopPct =
    c.entryPrice > 0 ? (c.stopPrice - c.entryPrice) / c.entryPrice : 0;
  const rangePct =
    c.week52High > c.week52Low
      ? (c.currentPrice - c.week52Low) / (c.week52High - c.week52Low)
      : 0;

  return (
    <div className="space-y-3 border-t border-border/60 bg-background/40 px-3 py-3 text-sm">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-[3fr_2fr]">
        <div className="space-y-3">
          <DetailSection title="Trade setup">
            <DetailRow
              label="Entry"
              value={`${fmtMoney(c.entryPrice)} (current)`}
            />
            <DetailRow
              label="Target"
              value={`${fmtMoney(c.targetPrice)} (${fmtPct(upsidePct, 1)})`}
              tone="good"
            />
            <DetailRow
              label="Stop"
              value={`${fmtMoney(c.stopPrice)} (${fmtPct(stopPct, 1)} — 3% below 52w low)`}
              tone="bad"
            />
            <DetailRow label="R/R" value={fmtRr(c.rr).text} tone={(c.rr ?? 0) >= 3 ? "good" : (c.rr ?? 0) >= 2 ? "warn" : "bad"} />
          </DetailSection>

          <DetailSection title="Technical">
            <DetailRow
              label="50d MA"
              value={`${fmtMoney(c.ma50)} (${fmtPct(c.vsMA50, 1)})`}
            />
            <DetailRow
              label="200d MA"
              value={`${fmtMoney(c.ma200)} (${fmtPct(c.vsMA200, 1)})`}
            />
            <DetailRow
              label="52w Range"
              value={`${fmtMoney(c.week52Low)} — ${fmtMoney(c.week52High)}`}
            />
            <DetailRow
              label="Position"
              value={`${(rangePct * 100).toFixed(0)}% of range · ${fmtPct(c.pctFrom52wLow, 1)} above low`}
            />
            <DetailRow
              label="Volume"
              value={`${(c.volumeRatio).toFixed(2)}x avg (${formatVolume(c.todayVolume)} vs ${formatVolume(c.avgVolume10d)})`}
            />
          </DetailSection>

          <DetailSection title="Price chart (6 months)">
            <PriceChart
              candidate={c}
              data={chartData}
              loading={chartLoading}
              error={chartError}
            />
          </DetailSection>
        </div>

        <div className="space-y-3">
          <InsiderSection candidate={c} />
          <OptionsSection candidate={c} />
          <CatalystSection candidate={c} />
          <EarningsAndShortSection candidate={c} />
        </div>
      </div>

      <ScoreBreakdown candidate={c} />
    </div>
  );
}

function DetailSection({
  title,
  titleTooltip,
  children,
}: {
  title: string;
  titleTooltip?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded border border-border/50 bg-white/[0.02] p-2">
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {titleTooltip ? <Tipped content={titleTooltip}>{title}</Tipped> : title}
      </div>
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}

function DetailRow({
  label,
  value,
  tone,
  valueTooltip,
}: {
  label: string;
  value: string;
  tone?: "good" | "warn" | "bad";
  valueTooltip?: React.ReactNode;
}) {
  const cls =
    tone === "good"
      ? "text-emerald-300"
      : tone === "warn"
        ? "text-amber-300"
        : tone === "bad"
          ? "text-rose-300"
          : "text-foreground";
  const valueEl = valueTooltip ? (
    <Tipped content={valueTooltip}>{value}</Tipped>
  ) : (
    value
  );
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span className={`font-mono ${cls}`}>{valueEl}</span>
    </div>
  );
}

function formatVolume(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return "—";
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(0)}K`;
  return String(Math.round(v));
}

function InsiderSection({ candidate: c }: { candidate: SwingCandidate }) {
  // Real conviction signal = open-market purchases (code P) only. Grants /
  // option exercises / dispositions are summarised separately so the user
  // can see they happened but they don't drown out the buy/sell math.
  const purchases = c.insiderTransactions.filter((t) => t.transactionCode === "P");
  const sales = c.insiderTransactions.filter((t) => t.transactionCode === "S");
  const buyShares = purchases.reduce((s, t) => s + t.shares, 0);
  const buyDollars = purchases.reduce((s, t) => s + t.dollarValue, 0);
  const sellDollars = sales.reduce((s, t) => s + t.dollarValue, 0);
  const netDollars = buyDollars - sellDollars;
  const tone =
    c.insiderSignal === "strong_bullish" || c.insiderSignal === "bullish"
      ? "good"
      : c.insiderSignal === "bearish"
        ? "bad"
        : undefined;
  const sectionTooltip =
    "Open-market stock purchases reported to the SEC via Form 4 filings " +
    "(required within 2 business days of transaction).\n\n" +
    "Only counts transaction code P (open-market purchase) — excludes RSU " +
    "grants, option exercises, and gifts, which are compensation not " +
    "conviction.\n\n" +
    "Signal: someone spent personal cash buying their own company's stock.\n" +
    "Data: Finnhub (SEC EDGAR)";
  const dollarHeaderTooltip =
    "Shares × transaction price = personal dollars committed. Large amounts " +
    "signal high personal conviction — this is real money, not compensation.";
  const netTooltip =
    "Net = total open-market buy dollars minus total open-market sell dollars " +
    "across all insiders in the last 45 days.\n\n" +
    "Multiple insiders buying simultaneously is a stronger signal than one " +
    "person buying.";
  return (
    <DetailSection
      title="Insider activity (last 45 days)"
      titleTooltip={sectionTooltip}
    >
      {c.insiderTransactions.length === 0 ? (
        <div className="text-muted-foreground">No insider transactions reported.</div>
      ) : (
        <>
          <div className="mb-1 overflow-hidden rounded border border-border/30">
            <table className="w-full text-[11px]">
              <thead className="bg-white/[0.03] text-muted-foreground">
                <tr>
                  <th className="px-1.5 py-1 text-left font-medium">Name</th>
                  <th className="px-1.5 py-1 text-left font-medium">Action</th>
                  <th className="px-1.5 py-1 text-right font-medium">Shares</th>
                  <th className="px-1.5 py-1 text-right font-medium">
                    <Tipped content={dollarHeaderTooltip}>$ Value</Tipped>
                  </th>
                  <th className="px-1.5 py-1 text-right font-medium">Date</th>
                </tr>
              </thead>
              <tbody>
                {c.insiderTransactions.slice(0, 8).map((tx, i) => (
                  <tr key={i} className="border-t border-border/30">
                    <td className="truncate px-1.5 py-1 text-foreground">{tx.name || "—"}</td>
                    <td className={`px-1.5 py-1 ${insiderActionTone(tx.transactionCode)}`}>
                      {tx.action || "—"}
                    </td>
                    <td className="px-1.5 py-1 text-right font-mono">{tx.shares.toLocaleString()}</td>
                    <td className="px-1.5 py-1 text-right font-mono">
                      {tx.dollarValue > 0
                        ? `$${(tx.dollarValue / 1_000_000).toFixed(2)}M`
                        : "—"}
                    </td>
                    <td className="px-1.5 py-1 text-right text-muted-foreground">{tx.date || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <DetailRow
            label="Net (open market)"
            value={`${c.insiderSignal.replace("_", " ").toUpperCase()} · ${buyShares.toLocaleString()} sh purchased · $${(netDollars / 1_000_000).toFixed(2)}M net`}
            tone={tone}
            valueTooltip={netTooltip}
          />
        </>
      )}
    </DetailSection>
  );
}

function insiderActionTone(code: string): string {
  if (code === "P") return "text-emerald-300";
  if (code === "S") return "text-rose-300";
  return "text-muted-foreground";
}

function OptionsSection({ candidate: c }: { candidate: SwingCandidate }) {
  const sectionTooltip =
    "Unusual call options activity from Schwab real-time options chain.\n\n" +
    "Detects when today's trading volume on a specific call strike is " +
    "unusually large relative to existing open positions — suggesting " +
    "someone is opening a large new directional bet.";
  const ratioTooltip = (() => {
    if (c.callVolumeOiRatio === null) return "No call chain data returned.";
    return (
      `Volume / Open Interest ratio.\n\n` +
      `Volume = contracts traded TODAY\n` +
      `Open Interest = all existing open contracts\n\n` +
      `${c.symbol} $${c.topOptionsStrike} strike:\n` +
      `Ratio: ${c.callVolumeOiRatio.toFixed(2)}x\n\n` +
      `>0.5x = unusual\n>1.0x = very unusual\n>2.0x = highly unusual\n\n` +
      `A ratio above 1.0 means more contracts traded today than existed ` +
      `yesterday — new money entering the position.`
    );
  })();
  const strikeTooltip = (() => {
    if (c.topOptionsStrike === null) return "No top-strike data.";
    const isOTM = c.topOptionsStrike > c.currentPrice;
    return (
      `The call strike with highest volume today.\n\n` +
      `$${c.topOptionsStrike.toFixed(0)} is ${isOTM ? "OTM (above" : "ITM/ATM (at or below"} ` +
      `current price of $${c.currentPrice.toFixed(2)})${
        isOTM
          ? ` — a speculative bet that price will exceed $${c.topOptionsStrike.toFixed(0)} by expiry.`
          : "."
      }\n\n` +
      `Investors rarely buy OTM calls in size unless expecting a significant ` +
      `move. The strike level tells you where informed money thinks price ` +
      `is going.`
    );
  })();
  return (
    <DetailSection title="Options flow" titleTooltip={sectionTooltip}>
      {c.unusualOptionsActivity ? (
        <>
          <DetailRow label="Signal" value="BULLISH (unusual call activity)" tone="good" />
          <DetailRow
            label="Top strike"
            value={c.topOptionsStrike !== null ? `$${c.topOptionsStrike.toFixed(0)} (OTM)` : "—"}
            valueTooltip={strikeTooltip}
          />
          <DetailRow
            label="Vol / OI ratio"
            value={c.callVolumeOiRatio !== null ? `${c.callVolumeOiRatio.toFixed(2)}x` : "—"}
            valueTooltip={ratioTooltip}
          />
        </>
      ) : c.callVolumeOiRatio !== null ? (
        <>
          <DetailRow label="Signal" value="NEUTRAL" />
          <DetailRow
            label="Top strike"
            value={c.topOptionsStrike !== null ? `$${c.topOptionsStrike.toFixed(0)}` : "—"}
            valueTooltip={strikeTooltip}
          />
          <DetailRow
            label="Vol / OI ratio"
            value={`${c.callVolumeOiRatio.toFixed(2)}x (below 0.5x threshold)`}
            valueTooltip={ratioTooltip}
          />
        </>
      ) : (
        <div className="text-muted-foreground">
          No options data — Schwab disconnected or symbol has no listed options.
        </div>
      )}
    </DetailSection>
  );
}

function catalystTypeLabel(t: string): string {
  if (t === "product_launch") return "Product launch";
  if (t === "fda" || t === "fda_decision") return "FDA decision";
  if (t === "contract" || t === "contract_award") return "Contract award";
  if (t === "rate_decision") return "Rate decision";
  if (t === "partnership") return "Partnership";
  if (t === "regulatory") return "Regulatory";
  if (t === "management") return "Management change";
  if (t === "macro") return "Macro event";
  if (t === "squeeze") return "Short squeeze potential";
  if (t === "activist") return "Activist activity";
  if (t === "analyst_upgrade") return "Analyst upgrade";
  if (t === "restructuring") return "Restructuring";
  if (t === "other") return "Other";
  return "—";
}

function CatalystSection({ candidate: c }: { candidate: SwingCandidate }) {
  const sectionTooltip =
    "Specific upcoming catalyst sourced via Perplexity research over the " +
    "next 30-90 days.\n\n" +
    "We exclude regular quarterly earnings and vague macro language — only " +
    "real near-term events count: product launches, FDA decisions, contract " +
    "awards, partnerships, regulatory rulings, etc.\n\n" +
    "+2 score for high confidence · +1 for medium · 0 otherwise.";
  const found =
    c.catalystConfidence === "high" || c.catalystConfidence === "medium";
  if (!found) {
    return (
      <DetailSection title="Upcoming catalyst" titleTooltip={sectionTooltip}>
        <div className="text-muted-foreground">
          No specific near-term catalyst identified.
        </div>
        {c.catalystInsiderAngle && (
          <div className="mt-2 rounded border border-amber-500/30 bg-amber-500/[0.05] p-2">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-amber-300/80">
              Why insiders are buying
            </div>
            <div className="mt-0.5 italic text-foreground/90">
              {c.catalystInsiderAngle}
            </div>
            <div className="mt-1 text-[10px] text-muted-foreground">
              Confidence: LOW — no specific catalyst found, but the insider
              thesis still builds conviction.
            </div>
          </div>
        )}
        <DetailRow
          label="Confidence"
          value={c.catalystConfidence === "low" ? "LOW" : "NONE"}
        />
      </DetailSection>
    );
  }
  return (
    <DetailSection title="Upcoming catalyst" titleTooltip={sectionTooltip}>
      <DetailRow label="Type" value={catalystTypeLabel(c.catalystType)} />
      {c.catalystDescription && (
        <div className="italic text-foreground/90">
          &ldquo;{c.catalystDescription}&rdquo;
        </div>
      )}
      <DetailRow
        label="Date"
        value={c.catalystDate ? fmtCalendarDate(c.catalystDate) : "Estimated (no exact date)"}
      />
      <DetailRow
        label="Confidence"
        value={c.catalystConfidence.toUpperCase()}
        tone={c.catalystConfidence === "high" ? "good" : "warn"}
      />
    </DetailSection>
  );
}

function EarningsAndShortSection({ candidate: c }: { candidate: SwingCandidate }) {
  // Risk-flag coloring (no longer a positive signal): closer = redder.
  const earningsTone =
    c.daysToEarnings === null
      ? undefined
      : c.daysToEarnings < 30
        ? "bad"
        : c.daysToEarnings <= 60
          ? "warn"
          : "good";
  const shortTone =
    c.shortPercentFloat === null
      ? undefined
      : c.shortPercentFloat > 0.25
        ? "warn"
        : c.shortPercentFloat > 0.15
          ? "warn"
          : undefined;
  const earningsTooltip =
    c.nextEarningsDate === null
      ? "No upcoming earnings date in next 120 days. Source: Finnhub earnings calendar."
      : `Earnings during your hold period is a binary risk event.\n\n` +
        `${c.daysToEarnings} days away — a miss could trigger a sharp ` +
        `decline. Size your position accordingly or plan to exit before ` +
        `this date.\n\n` +
        `<30 days = high risk (red)\n` +
        `30–60 days = monitor (amber)\n` +
        `>60 days = low risk (green)\n\n` +
        `Source: Finnhub earnings calendar.`;
  const shortTooltip =
    c.shortPercentFloat === null
      ? "No short interest data."
      : `% of available shares currently sold short. Source: Yahoo Finance.\n\n` +
        `${(c.shortPercentFloat * 100).toFixed(1)}% of ${c.symbol} float is short.\n\n` +
        `High short + positive catalyst = squeeze: shorts must buy to cover, ` +
        `accelerating moves.\n\n` +
        `<10% = low short interest\n` +
        `10–15% = moderate\n` +
        `>15% = elevated (squeeze possible)\n` +
        `>25% = high squeeze potential`;
  const revenueTooltip =
    c.revenueGrowth === null
      ? ""
      : c.revenueGrowth > 0
        ? `Revenue growing ${(c.revenueGrowth * 100).toFixed(1)}% YoY. ` +
          `Fundamental business momentum intact.`
        : `Revenue declining ${(Math.abs(c.revenueGrowth) * 100).toFixed(1)}% YoY. ` +
          `Screener allows up to −20% before disqualifying. Monitor closely.`;
  return (
    <DetailSection title="Earnings & short interest">
      <DetailRow
        label="Next earnings"
        value={
          c.nextEarningsDate
            ? `${fmtCalendarDate(c.nextEarningsDate)} (${c.daysToEarnings ?? "—"} days)`
            : "—"
        }
        tone={earningsTone}
        valueTooltip={earningsTooltip}
      />
      <DetailRow
        label="Short float"
        value={
          c.shortPercentFloat !== null
            ? `${(c.shortPercentFloat * 100).toFixed(1)}%${c.shortPercentFloat > 0.15 ? " — squeeze possible" : ""}`
            : "—"
        }
        tone={shortTone}
        valueTooltip={shortTooltip}
      />
      {c.revenueGrowth !== null && (
        <DetailRow
          label="Revenue growth (YoY)"
          value={fmtPct(c.revenueGrowth, 1)}
          tone={c.revenueGrowth > 0.15 ? "good" : c.revenueGrowth >= 0.05 ? "warn" : "bad"}
          valueTooltip={revenueTooltip}
        />
      )}
      <DetailRow
        label="Analyst target"
        value={c.analystTarget !== null ? `${fmtMoney(c.analystTarget)} (${c.numAnalysts} analysts)` : "—"}
      />
    </DetailSection>
  );
}

// Setup score breakdown — recomputed in the UI from the candidate fields
// so each component shows the actual data behind it. Mirrors the scoring
// rules in lib/swing-screener.ts (kept in sync by hand).
type ScoreComponent = {
  label: string;
  earned: number;
  max: number;
  detail: string;
  tooltip: string;
};

function computeScoreBreakdown(c: SwingCandidate): ScoreComponent[] {
  const out: ScoreComponent[] = [];

  // ---- Insider ----
  if (c.insiderSignal === "strong_bullish") {
    const top = c.executiveBuys?.[0] ?? null;
    out.push({
      label: "Executive-grade open-market buying",
      earned: 2,
      max: 2,
      detail: top
        ? `${top.name || "Insider"} purchased $${(top.dollarValue / 1_000_000).toFixed(2)}M on ${top.date}`
        : "Open-market purchase >$100K detected",
      tooltip: top
        ? `${top.name} made an open-market purchase:\n` +
          `${top.shares.toLocaleString()} shares\n` +
          `@ $${top.price.toFixed(2)} = $${(top.dollarValue / 1_000_000).toFixed(2)}M\n` +
          `on ${top.date}\n\n` +
          `Code P = open-market purchase with personal funds (not compensation).\n` +
          `>$100K threshold confirms conviction.`
        : "Open-market purchase >$100K detected.",
    });
  } else if (c.insiderSignal === "bullish") {
    out.push({
      label: "Insider buying",
      earned: 1,
      max: 2,
      detail: "Net open-market buyers — no $100K+ executive-tier purchase",
      tooltip:
        "Multiple insiders made open-market purchases on net, but none crossed " +
        "the $100K conviction threshold.\n\n" +
        "Half-credit signal — net buying is positive but no single high-conviction trade.",
    });
  } else {
    out.push({
      label: "Insider buying",
      earned: 0,
      max: 2,
      detail:
        c.insiderSignal === "bearish"
          ? "Insiders net selling on the open market"
          : "No open-market buying — only grants / option exercises",
      tooltip:
        "No open-market purchases >$100K detected in last 45 days.\n\n" +
        "RSU grants and option exercises excluded — those are compensation, not conviction.",
    });
  }

  // ---- Upcoming catalyst (Pass 3 / Perplexity) ----
  const catalystEarned =
    c.catalystConfidence === "high"
      ? 2
      : c.catalystConfidence === "medium"
        ? 1
        : 0;
  const catalystDetail =
    c.catalystConfidence === "high" && c.catalystDescription
      ? c.catalystDescription
      : c.catalystConfidence === "medium" && c.catalystDescription
        ? c.catalystDescription
        : c.catalystConfidence === "low"
          ? "Possible catalyst found, but confidence too low to score"
          : "No specific catalyst found in next 30-90 days";
  out.push({
    label: "Upcoming catalyst",
    earned: catalystEarned,
    max: 2,
    detail: catalystDetail,
    tooltip:
      c.catalystConfidence === "high" || c.catalystConfidence === "medium"
        ? `Type: ${catalystTypeLabel(c.catalystType)}\n` +
          (c.catalystDate ? `Date: ${fmtCalendarDate(c.catalystDate)}\n` : "") +
          `Confidence: ${c.catalystConfidence.toUpperCase()}\n\n` +
          (c.catalystDescription ? `"${c.catalystDescription}"\n\n` : "") +
          `Source: Perplexity research over the last 30-90 day horizon.`
        : c.catalystConfidence === "low"
          ? `Perplexity surfaced a candidate catalyst but flagged confidence as low.\n\n` +
            (c.catalystDescription ? `"${c.catalystDescription}"\n\n` : "") +
            `No score awarded for low-confidence signals.`
          : "Perplexity did not find a specific near-term catalyst (product launches, FDA decisions, contracts, partnerships, etc.). Regular quarterly earnings are intentionally excluded from this check.",
  });

  // ---- Unusual options ----
  out.push({
    label: "Unusual call activity",
    earned: c.unusualOptionsActivity ? 2 : 0,
    max: 2,
    detail: c.unusualOptionsActivity
      ? `${(c.callVolumeOiRatio ?? 0).toFixed(2)}x vol/OI on $${c.topOptionsStrike} strike${
          c.topOptionsExpiry ? ` (exp ${fmtCalendarDate(c.topOptionsExpiry)})` : ""
        }`
      : c.callVolumeOiRatio !== null
        ? `${c.callVolumeOiRatio.toFixed(2)}x vol/OI on top strike — below 0.5x threshold`
        : "No options data (Schwab disconnected or no listed options)",
    tooltip: c.unusualOptionsActivity
      ? `Vol/OI ${(c.callVolumeOiRatio ?? 0).toFixed(2)}x on $${c.topOptionsStrike} strike (OTM` +
        `${c.topOptionsExpiry ? `, exp ${fmtCalendarDate(c.topOptionsExpiry)}` : ""}).\n` +
        `Threshold: >0.5x = unusual activity.\n` +
        `${(c.callVolumeOiRatio ?? 0).toFixed(2)}x detected ✅`
      : "No call strike with vol/OI >0.5x found. Either options activity is normal today or Schwab returned no chain data.",
  });

  // ---- Volume ----
  const volHit = c.volumeRatio > 2.0 && c.priceChange1d > 0;
  out.push({
    label: "Volume spike",
    earned: volHit ? 1 : 0,
    max: 1,
    detail: volHit
      ? `${c.volumeRatio.toFixed(2)}x avg (${formatVolume(c.todayVolume)} today vs ${formatVolume(c.avgVolume10d)} avg) with price up`
      : `${c.volumeRatio.toFixed(2)}x avg (${formatVolume(c.todayVolume)} today vs ${formatVolume(c.avgVolume10d)} avg) — no spike`,
    tooltip:
      `Today's volume: ${c.todayVolume.toLocaleString()}\n` +
      `10-day avg vol: ${c.avgVolume10d.toLocaleString()}\n` +
      `Ratio: ${c.volumeRatio.toFixed(2)}x average\n\n` +
      `Threshold: >2.0x average AND price up today.\n\n` +
      (volHit
        ? "✅ Volume spike with positive price = accumulation signal"
        : c.volumeRatio >= 2
          ? "✗ High volume but price down = distribution, not accumulation"
          : "✗ Normal volume — no unusual activity"),
  });

  // R/R is deliberately NOT a score component — see the R/R badge next to
  // Signals for the trade-geometry sanity check. Setup quality (this
  // breakdown) and trade geometry (can you place a sane order) are kept
  // separate on purpose.

  // ---- Short squeeze ----
  const squeezeHit = c.shortPercentFloat !== null && c.shortPercentFloat > 0.15;
  const shortPct =
    c.shortPercentFloat !== null ? (c.shortPercentFloat * 100).toFixed(1) : null;
  out.push({
    label: "Short squeeze potential",
    earned: squeezeHit ? 1 : 0,
    max: 1,
    detail:
      c.shortPercentFloat === null
        ? "No short data"
        : squeezeHit
          ? `${shortPct}% short float — squeeze possible if catalyst triggers`
          : `${shortPct}% short float — below 15% threshold`,
    tooltip:
      shortPct === null
        ? "No short interest data."
        : `${shortPct}% short float.\n` +
          `Threshold for point: >15%\n\n` +
          (squeezeHit
            ? "✅ Elevated short interest — squeeze possible if catalyst triggers"
            : "✗ Below 15% threshold"),
  });

  // ---- 50d MA setup ----
  const maPerfect = c.vsMA50 >= -0.02 && c.vsMA50 <= 0.02;
  out.push({
    label: "Perfect MA setup",
    earned: maPerfect ? 1 : 0,
    max: 1,
    detail: maPerfect
      ? `Within ±2% of 50d MA (${fmtPct(c.vsMA50, 1)})`
      : `${fmtPct(c.vsMA50, 1)} from 50d MA — outside ±2% sweet spot`,
    tooltip:
      `Price: ${fmtMoney(c.currentPrice)}\n` +
      `50d MA: ${fmtMoney(c.ma50)}\n` +
      `vs MA: ${fmtPct(c.vsMA50, 1)}\n\n` +
      `Threshold: within ±2% of 50d MA\n\n` +
      (maPerfect
        ? "✅ At the MA — key decision point"
        : "✗ Not at MA level"),
  });

  // ---- Insider selling penalty ---- (only shown when it applies — see
  // the -2 policy note in lib/swing-screener.ts pass2Enrich)
  if (c.redFlags.includes("INSIDER_SELLING")) {
    out.push({
      label: "Insider selling penalty",
      earned: -2,
      max: 0,
      detail: "Net insider selling on the open market — inverse of the insider-buying tier-1 signal",
      tooltip:
        "Insiders sold more than 2x what they bought on the open market.\n\n" +
        "-2 to every tab score this candidate qualifies for, floored at 0. " +
        "On a bullish-only screener, bearish insider activity works against " +
        "the setup's own thesis rather than sitting as a label with no effect.",
    });
  }

  return out;
}

function ScoreBreakdown({ candidate: c }: { candidate: SwingCandidate }) {
  const components = computeScoreBreakdown(c);
  const filled = Math.max(0, Math.min(10, c.setupScore));
  return (
    <div className="rounded border border-border/50 bg-white/[0.02] p-3">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Setup Score
        </span>
        <span className="font-mono text-base text-foreground">{c.setupScore}/10</span>
        <span className="ml-2 font-mono text-sm tracking-tighter text-muted-foreground">
          {"━".repeat(filled)}
          <span className="text-muted-foreground/40">{"░".repeat(10 - filled)}</span>
        </span>
      </div>
      <div className="grid grid-cols-1 gap-1 text-[11px] md:grid-cols-2">
        {components.map((comp, i) => {
          const negative = comp.earned < 0;
          const ok = comp.earned > 0;
          const partial = comp.earned > 0 && comp.earned < comp.max;
          const icon = negative ? "−" : ok ? (partial ? "⚠" : "✓") : "✗";
          const cls = negative
            ? "text-rose-300"
            : ok
              ? partial
                ? "text-amber-300"
                : "text-emerald-300"
              : "text-muted-foreground";
          return (
            <div key={i} className="flex items-start gap-2">
              <span className={`mt-0.5 w-3 shrink-0 ${cls}`}>{icon}</span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-foreground/90">{comp.label}</span>
                  <span className={`font-mono ${cls}`}>
                    <Tipped content={comp.tooltip}>
                      {comp.earned}/{comp.max}
                    </Tipped>
                  </span>
                </div>
                <div className="text-[10px] text-muted-foreground">
                  {comp.detail}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}


// ---------- Price chart ----------

function PriceChart({
  candidate: c,
  data,
  loading,
  error,
}: {
  candidate: SwingCandidate;
  data: ChartPoint[] | null;
  loading: boolean;
  error: string | null;
}) {
  // Error first — even if `loading` is somehow stuck (deadlocked effect,
  // network hang, etc.), the user gets an actionable message rather than
  // staring at a permanent skeleton.
  if (error) {
    return (
      <div
        className="flex items-center justify-center rounded border border-rose-500/40 bg-rose-500/10 px-2 text-center text-[11px] text-rose-300"
        style={{ height: 200 }}
      >
        Chart unavailable: {error}
      </div>
    );
  }
  if (loading || data === null) {
    return (
      <div
        className="flex items-center justify-center rounded border border-border/30 bg-white/[0.02] text-[11px] text-muted-foreground"
        style={{ height: 200 }}
      >
        {loading ? "Loading 6-month history…" : "—"}
      </div>
    );
  }
  if (data.length === 0) {
    return (
      <div
        className="flex items-center justify-center rounded border border-border/30 bg-white/[0.02] text-[11px] text-muted-foreground"
        style={{ height: 200 }}
      >
        Yahoo returned no historical data for {c.symbol}.
      </div>
    );
  }

  // X-axis tick density: ~5 evenly spaced labels across the window so the
  // axis isn't crowded on a 6-month series. We pre-pick the tick positions
  // and render only those.
  const tickStep = Math.max(1, Math.floor(data.length / 5));
  const ticks = data
    .map((d, i) => (i % tickStep === 0 ? d.date : null))
    .filter((d): d is string => d !== null);

  return (
    <div className="space-y-1">
      <div style={{ width: "100%", height: 200 }}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart
            data={data}
            margin={{ top: 8, right: 60, left: 0, bottom: 0 }}
          >
            <CartesianGrid stroke="rgba(255,255,255,0.06)" vertical={false} />
            <XAxis
              dataKey="date"
              ticks={ticks}
              tickFormatter={(v: string) =>
                new Date(v).toLocaleDateString("en-US", { month: "short" })
              }
              tick={{ fill: "rgba(255,255,255,0.5)", fontSize: 10 }}
              axisLine={{ stroke: "rgba(255,255,255,0.1)" }}
              tickLine={false}
            />
            <YAxis
              yAxisId="price"
              domain={["auto", "auto"]}
              tickFormatter={(v: number) => `$${v.toFixed(0)}`}
              tick={{ fill: "rgba(255,255,255,0.5)", fontSize: 10 }}
              axisLine={false}
              tickLine={false}
              width={45}
            />
            <YAxis
              yAxisId="volume"
              orientation="right"
              hide
              domain={[0, (max: number) => max * 5]}
            />
            <RTooltip content={<ChartTooltip />} />
            <Bar
              yAxisId="volume"
              dataKey="volume"
              fill="rgba(96,165,250,0.18)"
              isAnimationActive={false}
            />
            <Line
              yAxisId="price"
              type="monotone"
              dataKey="ma200"
              stroke="#ef4444"
              strokeWidth={1.5}
              strokeDasharray="4 2"
              dot={false}
              isAnimationActive={false}
              connectNulls
              name="200d MA"
            />
            <Line
              yAxisId="price"
              type="monotone"
              dataKey="ma50"
              stroke="#f97316"
              strokeWidth={1.5}
              strokeDasharray="4 2"
              dot={false}
              isAnimationActive={false}
              connectNulls
              name="50d MA"
            />
            <Line
              yAxisId="price"
              type="monotone"
              dataKey="close"
              stroke="#60a5fa"
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
              name="Price"
            />
            <ReferenceLine
              yAxisId="price"
              y={c.targetPrice}
              stroke="#22c55e"
              strokeDasharray="3 3"
              label={{
                value: "Target",
                position: "right",
                fill: "#22c55e",
                fontSize: 10,
              }}
            />
            <ReferenceLine
              yAxisId="price"
              y={c.entryPrice}
              stroke="rgba(255,255,255,0.35)"
              strokeDasharray="2 2"
              label={{
                value: "Entry",
                position: "right",
                fill: "rgba(255,255,255,0.65)",
                fontSize: 10,
              }}
            />
            <ReferenceLine
              yAxisId="price"
              y={c.stopPrice}
              stroke="#ef4444"
              strokeDasharray="3 3"
              label={{
                value: "Stop",
                position: "right",
                fill: "#ef4444",
                fontSize: 10,
              }}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <div className="flex flex-wrap items-center gap-3 px-1 text-[10px] text-muted-foreground">
        <LegendDot color="#60a5fa" label="Price" />
        <LegendDot color="#f97316" label="50d MA" dashed />
        <LegendDot color="#ef4444" label="200d MA" dashed />
        <LegendDot color="#22c55e" label="Target" dashed />
        <LegendDot color="rgba(255,255,255,0.6)" label="Entry" dashed />
        <LegendDot color="#ef4444" label="Stop" dashed />
      </div>
    </div>
  );
}

function LegendDot({
  color,
  label,
  dashed,
}: {
  color: string;
  label: string;
  dashed?: boolean;
}) {
  return (
    <span className="inline-flex items-center gap-1">
      <span
        className="inline-block h-[2px] w-3"
        style={{
          background: dashed
            ? `repeating-linear-gradient(to right, ${color} 0 3px, transparent 3px 6px)`
            : color,
        }}
      />
      <span>{label}</span>
    </span>
  );
}

type ChartTooltipPayload = {
  active?: boolean;
  label?: string;
  payload?: Array<{
    name?: string;
    dataKey?: string;
    value?: number;
    payload?: ChartPoint;
  }>;
};

function ChartTooltip(props: ChartTooltipPayload) {
  if (!props.active || !props.payload || props.payload.length === 0) return null;
  const row = props.payload[0]?.payload;
  if (!row) return null;
  const fmt = (v: number | null | undefined) =>
    v !== null && v !== undefined && Number.isFinite(v) ? `$${v.toFixed(2)}` : "—";
  return (
    <div className="rounded-md border border-border bg-popover px-2 py-1.5 text-[11px] text-popover-foreground shadow-md">
      <div className="font-medium text-foreground">
        {new Date(row.date).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
        })}
      </div>
      <div className="mt-0.5 space-y-0.5 font-mono">
        <div>
          <span className="text-muted-foreground">Price:</span>{" "}
          <span style={{ color: "#60a5fa" }}>{fmt(row.close)}</span>
        </div>
        <div>
          <span className="text-muted-foreground">50d MA:</span>{" "}
          <span style={{ color: "#f97316" }}>{fmt(row.ma50)}</span>
        </div>
        <div>
          <span className="text-muted-foreground">200d MA:</span>{" "}
          <span style={{ color: "#ef4444" }}>{fmt(row.ma200)}</span>
        </div>
      </div>
    </div>
  );
}

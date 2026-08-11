"use client";

import { Fragment, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
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
import { minutesAgo, isChainStale } from "@/lib/dump-capture-timing";

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
  // The named components tabScores[tab] sums to, and the prose built
  // from them — both optional, since rows saved before this redesign
  // have neither. See lib/swing-screener.ts ScoreComponent/buildNarrative.
  tabScoreComponents?: Partial<Record<SetupTab, ScoreComponent[]>>;
  tabNarrative?: Partial<Record<SetupTab, string>>;
  tabStats?: TabStats | null;
  // Kept separate from tabStats so a confluence row shown under either
  // tab gets that tab's own stats. Optional for pre-redesign rows.
  capitulationStats?: TabStats | null;
  pullbackStats?: TabStats | null;
  // 14-day ATR — the volatility basis for entry/target/stop. Optional/
  // null for rows saved before the real-levels redesign or when Yahoo
  // didn't return enough daily history.
  atr14?: number | null;
  // 20-day Average Daily Range, as a % of price. Display + filter only —
  // never read by any scorer/qualifier. Optional for rows saved before
  // this field existed.
  adr20Pct?: number | null;
  // Yahoo sector, cached in stock_profiles. Display only. Optional for
  // rows saved before this field existed.
  sector?: string | null;
  // RS Pullback tab only — null/undefined for every other tab's
  // candidates. See lib/swing-screener.ts computeRsPullbackCandidates.
  extensionAdrDays?: number | null;
  rs20?: number | null;
  rs60?: number | null;
  higherLowVsSpy?: boolean | null;
  rsPullbackList?: "ready" | "leading_extended" | "in_zone_lagging" | "near_miss" | null;
  // True if this candidate's sector/earnings check failed (rate limit,
  // API error) rather than returning a real answer — fail-open still
  // includes it, but it hasn't actually been confirmed clean.
  dataQualityDegraded?: boolean;
  dataQualityIssues?: string[];
  // RS Pullback row-detail fields — the underlying values behind
  // extensionAdrDays/rs20/rs60. See lib/swing-screener.ts SwingCandidate
  // for the full explanation of each.
  sma20?: number | null;
  sma50AtEntry?: number | null;
  sma50TwentySessionsAgo?: number | null;
  sma50RisingPct?: number | null;
  stockReturn20?: number | null;
  stockReturn60?: number | null;
  spyReturn20?: number | null;
  spyReturn60?: number | null;
  // ---- Near-miss watch tier only — set iff rsPullbackList === "near_miss".
  // See lib/swing-screener.ts RsPullbackGateStatus. ----
  nearMissGate?: "sma50_rising" | "rs20" | "rs60" | "adr_floor" | null;
  nearMissValue?: number | null;
  nearMissThreshold?: number | null;
  nearMissGap?: number | null;
  nearMissValue5SessionsAgo?: number | null;
  nearMissTrend?: "improving" | "deteriorating" | "flat" | null;
  // Client-only, transient — never sent to or read from the server, never
  // persisted (see refreshRsPullbackPrices). True when this candidate's
  // currentPrice/entryPrice/extensionAdrDays/vsMA50/rr/rsPullbackList were
  // overwritten by a price-only refresh rather than the last full run —
  // SMA50/ATR14/RS20/RS60/target/stop are still the full run's stale
  // values, so this row can never show Enter regardless of R:R.
  priceRefreshed?: boolean;
};

// Mirror of lib/swing-screener.ts ScoreComponent — the score IS the sum
// of these, so this is what both the badge and the breakdown render.
type ScoreComponent = {
  key: string;
  label: string;
  value: string;
  detail: string;
  points: number;
  maxPoints: number;
  direction: "positive" | "negative" | "neutral";
};

type TabStats = {
  redDayCount: number;
  move5dPct: number;
  rsi14: number | null;
  sma20: number | null;
  return3m: number | null;
  return1y: number | null;
};

type SetupTab = "capitulation" | "pullback" | "insider" | "options_flow" | "rs_pullback";

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
  {
    key: "rs_pullback",
    label: "RS Pullback",
    blurb:
      "Trend (above a rising 50d/above the 200d) + volatility floor (ADR% >= min) + relative strength vs SPY, split into three lists by extension from the 50d in ADR-days: Ready (in the entry zone), Leading/extended (strong RS but too far from entry), and In-zone/lagging (a control group). No 0-10 score — pass/fail plus a list, not a ranking.",
  },
];

const TAB_LABEL: Record<SetupTab, string> = {
  capitulation: "Capitulation",
  pullback: "Pullback",
  insider: "Insider",
  options_flow: "Options Flow",
  rs_pullback: "RS Pullback",
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

type UniverseDescriptor = {
  includeIndex: boolean;
  themeIds: string[];
  allThemes: boolean;
  themeNames: string[];
  resolvedCount: number;
  label: string;
};

type CachedResult = {
  candidates: SwingCandidate[];
  screened: number;
  pass1Survivors: number;
  pass2Results: number;
  durationMs: number;
  errors: string[];
  screenedAt: string | null;
  universe?: UniverseDescriptor | null;
};

// Universe & Themes, Phase B — the selector's own state (what's checked),
// distinct from UniverseDescriptor (the resolved, persisted record of what
// a run actually used). Multi-select: index and any number of themes (or
// "all themes") combine, deduplicated at resolve time.
type UniverseSelection = {
  includeIndex: boolean;
  themeIds: string[];
  allThemes: boolean;
};

const DEFAULT_UNIVERSE_SELECTION: UniverseSelection = {
  includeIndex: true,
  themeIds: [],
  allThemes: false,
};
const LS_UNIVERSE_SELECTION = "swing-screen-universe-selection";

type ActiveTheme = { id: string; name: string; memberCount: number };

type ResolvedUniverse = {
  symbols: string[];
  count: number;
  themeNames: string[];
  label: string;
};

// RS Pullback's pregate/enrichment funnel counts for one run — persisted
// alongside the rs_pullback row (see /save) so a zero-candidate run still
// explains why: nothing pregated, vs. pregated-but-excluded, vs.
// evaluated-and-disqualified. A subset of the live progress banner's own
// state (that one also tracks chunksDone/chunksTotal, which are
// UI-progress-only and not meaningful to persist).
type RsPullbackRunDiagnostics = {
  pregatedCount: number;
  needsEnrichmentCount: number;
  excludedBySectorPrefilter: number;
  excludedBySma50RisingPrefilter: number;
  excludedBySma50RisingEnrichment: number;
  insufficientData: number;
  degradedCount: number;
  // Diagnostic only — names dropped below their 200MA before any bars
  // fetch. Not near-miss-classified (see lib/swing-screener.ts
  // pregateRsPullbackSymbols): we don't know whether these would also
  // pass the other four gates without enriching a class of symbols that
  // never reaches enrichment today, which the near-miss spec explicitly
  // says to avoid rather than slow the run down.
  excludedByAbove200d: number;
};

// Column keys are dynamic per tab (see TAB_COLUMNS) plus a fixed set of
// common columns (symbol/company/price/chg/score/signals) — no longer a
// closed union, since each tab defines its own metric columns.
type SortKey = string;

type SortDir = "asc" | "desc";
type SortState = { key: SortKey; dir: SortDir };

const DEFAULT_SORT: SortState = { key: "setupScore", dir: "desc" };

// Minimum-ADR%% filter — persisted the same way screener-view.tsx
// persists its own controls (localStorage, restored on mount). Default
// 3.0%: below that, a 1.5x-ATR stop and a 3R target both sit inside a
// typical day's noise for the underlying, so the setup's geometry can't
// really work regardless of score.
const LS_MIN_ADR_PCT = "swing-screen-min-adr-pct";
const DEFAULT_MIN_ADR_PCT = 3.0;

// RS Pullback thresholds — mirrors lib/swing-screener.ts's
// RsPullbackThresholds/DEFAULT_RS_PULLBACK_THRESHOLDS. Kept as a plain
// object (not imported — this file already hand-mirrors SwingCandidate
// the same way) so the settings panel can edit it directly and persist
// via localStorage, same convention as minAdrPct above.
type RsPullbackThresholds = {
  minAdrPct: number;
  // Boundary for BOTH Ready (inside) and Leading-extended (outside) — no
  // separate "extended" threshold exists above this one anymore.
  entryZoneAdrDays: number;
  sma50RisingMinPct: number;
  sma50RisingLookbackSessions: number;
  ma50BelowTolerancePct: number;
};

const DEFAULT_RS_PULLBACK_THRESHOLDS: RsPullbackThresholds = {
  minAdrPct: 3.0,
  entryZoneAdrDays: 1.0,
  sma50RisingMinPct: 3.0,
  sma50RisingLookbackSessions: 20,
  ma50BelowTolerancePct: 3.0,
};

const LS_RS_PULLBACK_THRESHOLDS = "swing-screen-rs-pullback-thresholds";

// Purely client-side, DISPLAY-ONLY color bands for the two RS Pullback
// metrics that actually vary row to row and determine whether a name is
// buyable (Extension, R:R) — unlike RsPullbackThresholds above, these
// never round-trip to the server and never affect what qualifies,
// what's pregated, or which of the three lists a candidate lands in.
// Provisional, hence editable — see RsPullbackSettingsPanel.
type RsPullbackColorBands = {
  // Extension (ADR-days), lower is better WITHIN a floor: below
  // extensionFloor, price is essentially at the 50-day, leaving no room
  // for a stop above the level that defines the trend — that's red, not
  // green, even though it's a small number.
  extensionFloor: number; // below this: red
  extensionGreenMax: number; // [floor, this]: green — ideal entry zone
  extensionYellowMax: number; // (greenMax, this]: yellow
  extensionOrangeMax: number; // (yellowMax, this]: orange; above: red
  // R:R, higher is better — no floor, just four bands top to bottom.
  rrGreenMin: number; // >= this: green
  rrYellowMin: number; // >= this: yellow
  rrOrangeMin: number; // >= this: orange; below: red
};

const DEFAULT_RS_PULLBACK_COLOR_BANDS: RsPullbackColorBands = {
  extensionFloor: 0.3,
  extensionGreenMax: 1.0,
  extensionYellowMax: 1.5,
  extensionOrangeMax: 2.0,
  rrGreenMin: 2.0,
  rrYellowMin: 1.5,
  rrOrangeMin: 1.0,
};

const LS_RS_PULLBACK_COLOR_BANDS = "swing-screen-rs-pullback-color-bands";

// Purely client-side, DISPLAY-ONLY guards around the target derivation
// (computeStructuralLevels in lib/swing-screener.ts) — that function is
// unbounded (nearer of analyst consensus / 52-week high / 3xATR
// projection, no floor or ceiling on distance), which produces R:R
// values that don't describe a tradeable setup: a target 13 ADR-days
// away isn't a multi-week swing objective, and a target $0.10 above
// entry (price already sitting at its 52-week high) isn't a real target
// either. Same convention as RsPullbackColorBands above — never touches
// the target/stop calculation, gating, pregate, or which list a
// candidate lands in; only whether R:R prints and whether Enter shows.
type RsPullbackExitRules = {
  // R:R only shows when the target sits within this window of entry, in
  // ADR-days — same units as the Extension column, not percent.
  targetMinAdrDays: number;
  targetMaxAdrDays: number;
  // Below this R:R (or when the target's outside the window above), the
  // row keeps Track but loses Enter — a pre-committed floor.
  rrFloor: number;
  // Enter also requires |extensionAdrDays| <= this — independent of, and
  // more lenient by default than, the live entryZoneAdrDays gate (1.0)
  // that decides Ready vs Leading-extended bucket membership. Without
  // this, canEnterRsPullback only checked target window + R:R, so a
  // "Leading, extended" row 20%+ above its 50MA (e.g. 4.76-4.99
  // ADR-days) could still show Enter purely on a passing R:R — display
  // only, never changes which list a candidate lands in.
  maxEntryExtensionAdrDays: number;
};

const DEFAULT_RS_PULLBACK_EXIT_RULES: RsPullbackExitRules = {
  targetMinAdrDays: 1.5,
  targetMaxAdrDays: 4.0,
  rrFloor: 2.0,
  maxEntryExtensionAdrDays: 1.5,
};

const LS_RS_PULLBACK_EXIT_RULES = "swing-screen-rs-pullback-exit-rules";

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

// RS Pullback-specific 4-step color bands for Extension and R:R —
// deliberately separate from fmtRr above (that one backs RrBadge, used
// by the other tabs on a different 3-tier scale that stays untouched).
// Both take the current RsPullbackColorBands so editing the thresholds
// in RsPullbackSettingsPanel changes the rendered color, not just the
// number.
function extensionBandCls(ext: number | null | undefined, bands: RsPullbackColorBands): string {
  if (ext === null || ext === undefined || !Number.isFinite(ext)) return "text-muted-foreground";
  if (ext < bands.extensionFloor || ext > bands.extensionOrangeMax) return "text-rose-300";
  if (ext <= bands.extensionGreenMax) return "text-emerald-300";
  if (ext <= bands.extensionYellowMax) return "text-amber-300";
  return "text-orange-300";
}

function rrBandCls(rr: number | null | undefined, bands: RsPullbackColorBands): string {
  if (rr === null || rr === undefined || !Number.isFinite(rr)) return "text-muted-foreground";
  if (rr >= bands.rrGreenMin) return "text-emerald-300";
  if (rr >= bands.rrYellowMin) return "text-amber-300";
  if (rr >= bands.rrOrangeMin) return "text-orange-300";
  return "text-rose-300";
}

// Renders the live band boundaries as a caption string — doubles as
// "surface the thresholds in the UI" without requiring the settings
// panel to be open, and updates automatically when they're edited.
function extensionBandCaption(bands: RsPullbackColorBands): string {
  return `${bands.extensionFloor.toFixed(1)}–${bands.extensionGreenMax.toFixed(1)} green · –${bands.extensionYellowMax.toFixed(1)} yellow · –${bands.extensionOrangeMax.toFixed(1)} orange · outside red`;
}

function rrBandCaption(bands: RsPullbackColorBands): string {
  return `≥${bands.rrGreenMin.toFixed(1)} green · ≥${bands.rrYellowMin.toFixed(1)} yellow · ≥${bands.rrOrangeMin.toFixed(1)} orange · below red`;
}

// ---- RS Pullback exit rules: target-window guard around the unbounded
// target derivation (see RsPullbackExitRules above) ----

type TargetWindowState =
  | { kind: "within"; adrDays: number }
  | { kind: "beyond"; adrDays: number }
  | { kind: "at_resistance"; adrDays: number }
  | { kind: "unknown" };

// Distance from entry to target, in ADR-days — same unit definition as
// the Extension column (percent move / ADR%), just measured from entry
// to target instead of from the 50MA to price.
function computeTargetAdrDays(c: SwingCandidate): number | null {
  if (
    c.entryPrice === null ||
    c.entryPrice === undefined ||
    !Number.isFinite(c.entryPrice) ||
    c.entryPrice <= 0 ||
    c.targetPrice === null ||
    c.targetPrice === undefined ||
    !Number.isFinite(c.targetPrice) ||
    c.adr20Pct === null ||
    c.adr20Pct === undefined ||
    !Number.isFinite(c.adr20Pct) ||
    c.adr20Pct === 0
  ) {
    return null;
  }
  return (((c.targetPrice - c.entryPrice) / c.entryPrice) * 100) / c.adr20Pct;
}

function classifyTargetWindow(c: SwingCandidate, rules: RsPullbackExitRules): TargetWindowState {
  const adrDays = computeTargetAdrDays(c);
  if (adrDays === null) return { kind: "unknown" };
  if (adrDays > rules.targetMaxAdrDays) return { kind: "beyond", adrDays };
  if (adrDays < rules.targetMinAdrDays) return { kind: "at_resistance", adrDays };
  return { kind: "within", adrDays };
}

// Replaces the R:R ratio for a row outside the window — "do not print a
// ratio" for these, per spec.
function targetWindowMessage(state: TargetWindowState): string {
  if (state.kind === "beyond") {
    return `target beyond swing horizon (${state.adrDays.toFixed(1)} ADR-days)`;
  }
  if (state.kind === "at_resistance") return "no target - at resistance";
  return "";
}

function rrHelperText(rules: RsPullbackExitRules): string {
  return `R:R only shows when the target sits ${rules.targetMinAdrDays.toFixed(1)}–${rules.targetMaxAdrDays.toFixed(1)} ADR-days from entry — outside that window the projection is a distant or already-exhausted level, not a validated trade. Enter requires R:R ≥ ${rules.rrFloor.toFixed(1)}:1 AND |Extension| ≤ ${rules.maxEntryExtensionAdrDays.toFixed(1)} ADR-days AND not In zone/lagging (a control-group bucket) — missing any of those, or when R:R is suppressed, Track stays but Enter doesn't.`;
}

function targetHelperText(rules: RsPullbackExitRules): string {
  return `Nearer of analyst consensus / 52-week high / 3×ATR projection — no floor or ceiling on distance from entry. R:R only shows when this lands ${rules.targetMinAdrDays.toFixed(1)}–${rules.targetMaxAdrDays.toFixed(1)} ADR-days out.`;
}

// Whether this row is allowed to show an Enter button — display only,
// never changes gating, bucketing, or which list a candidate lands in
// (see RsPullbackExitRules above). Four independent requirements, all
// must hold:
//   1. In zone/lagging is a control-group bucket by definition (sits in
//      the entry zone but fails RS) — never enterable regardless of
//      target/R:R/extension.
//   2. |extensionAdrDays| within maxEntryExtensionAdrDays — a "Leading,
//      extended" row far above its 50MA is not a pullback entry no
//      matter how good its R:R looks.
//   3. Target inside the window AND R:R clears the floor (pre-existing).
//   4. Not price-refreshed (see priceRefreshed on SwingCandidate) — a
//      refresh only updates price-dependent fields; SMA50/ATR14/target/
//      stop are still the last full run's values, so nothing refresh-
//      derived can ever authorize an entry. Split out as
//      canEnterIgnoringRefresh below so callers can tell "would show
//      Enter if not for the refresh flag" apart from "never would have
//      anyway" — that's what decides whether a row needs the "moved on
//      refresh" explanation or just stays plain Track like always.
function canEnterIgnoringRefresh(c: SwingCandidate, rules: RsPullbackExitRules): boolean {
  if (c.rsPullbackList === "in_zone_lagging") return false;
  if (
    c.extensionAdrDays === null ||
    c.extensionAdrDays === undefined ||
    !Number.isFinite(c.extensionAdrDays) ||
    Math.abs(c.extensionAdrDays) > rules.maxEntryExtensionAdrDays
  ) {
    return false;
  }
  const window = classifyTargetWindow(c, rules);
  if (window.kind !== "within") return false;
  return c.rr !== null && c.rr !== undefined && Number.isFinite(c.rr) && c.rr >= rules.rrFloor;
}

function canEnterRsPullback(c: SwingCandidate, rules: RsPullbackExitRules): boolean {
  if (c.priceRefreshed) return false;
  return canEnterIgnoringRefresh(c, rules);
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
  // RS Pullback doesn't use the standard column system — it has its own
  // three-section renderer (RsPullbackResults) rather than a single
  // flat sorted table. Empty on purpose.
  rs_pullback: [],
};

// Mobile stays a fixed 5-col strip (Symbol/Price/Chg%/Score/Actions) —
// same across tabs. Desktop column count varies by tab (3-4 metric
// columns), so each tab gets its own literal grid-cols class: Tailwind's
// scanner needs the full class text present in source, not assembled
// from a runtime template string.
const ROW_GRID_MOBILE =
  "grid-cols-[minmax(60px,1fr)_70px_60px_60px_minmax(80px,1fr)]";
// Each tab's literal grid string gains two fixed columns (ADR%, Sector)
// right after Chg% — same position in every tab, adjacent to whichever
// column shows vs 50MA for that tab.
const ROW_GRID_DESKTOP: Record<SetupTab, string> = {
  capitulation:
    "md:grid-cols-[minmax(60px,80px)_minmax(120px,1.5fr)_80px_70px_60px_90px_70px_60px_70px_70px_70px_minmax(120px,1fr)_190px]",
  pullback:
    "md:grid-cols-[minmax(60px,80px)_minmax(120px,1.5fr)_80px_70px_60px_90px_70px_70px_70px_80px_70px_minmax(120px,1fr)_190px]",
  insider:
    "md:grid-cols-[minmax(60px,80px)_minmax(120px,1.5fr)_80px_70px_60px_90px_70px_80px_60px_80px_70px_70px_minmax(120px,1fr)_190px]",
  options_flow:
    "md:grid-cols-[minmax(60px,80px)_minmax(120px,1.5fr)_80px_70px_60px_90px_70px_70px_90px_70px_90px_70px_minmax(120px,1fr)_190px]",
  // Unused — RS Pullback never renders through ResultsTable/CandidateRow.
  rs_pullback: "",
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

// Time-only, for the RS Pullback price-refresh banner's "prices as of
// HH:MM, gates from run at HH:MM" — fmtRelDate's full date+time is more
// than that comparison needs.
function fmtShortTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

// How old the underlying full run (the gate values a price refresh
// never touches) can get before the banner flags it — same mechanism as
// CHAIN_STALENESS_THRESHOLD_MINUTES on the CSP side (lib/dump-capture-
// timing.ts's isChainStale, reused here), just a longer window: RS
// Pullback's gates are daily-bar-derived and don't move intraday the way
// an options chain does, so 60 minutes (vs. the chain's 30) is about
// "you've been looking at this a while, maybe re-run" rather than "this
// number is now wrong."
const RS_PULLBACK_RUN_STALE_THRESHOLD_MINUTES = 60;

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
  adr20pct: { value: (c) => c.adr20Pct ?? null, defaultDir: "desc" },
  sector: { value: (c) => c.sector ?? null, defaultDir: "asc" },
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

type RunPhase = "idle" | "backfill" | "pass1" | "pass2" | "rs_pullback" | "pass3" | "saving";

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
  rsPullback: {
    pregatedCount: number;
    needsEnrichment: string[];
    excludedBySectorPrefilter: number;
    excludedBySma50RisingPrefilter: number;
    excludedByAbove200d: number;
    prefilterNearMiss: SwingCandidate[];
  };
};

// Universe & Themes, Phase B — resolves a selector's choice to the
// deduplicated symbol list, via /api/swings/universe/resolve. Called both
// for the selector's live "N symbols" preview and, again, at the start of
// a real run (so the run always reflects current theme membership rather
// than whatever the preview last fetched).
async function resolveUniverse(selection: UniverseSelection): Promise<ResolvedUniverse> {
  const res = await fetch("/api/swings/universe/resolve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    body: JSON.stringify(selection),
  });
  const json = (await res.json()) as {
    symbols?: string[];
    count?: number;
    themeNames?: string[];
    label?: string;
    error?: string;
  };
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  return {
    symbols: json.symbols ?? [],
    count: json.count ?? 0,
    themeNames: json.themeNames ?? [],
    label: json.label ?? "",
  };
}

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
  // Escape hatch for the quote-sweep/Finnhub/ATR caches — bypasses all
  // of them for this run (but still writes fresh results back so the
  // next normal run benefits). Schwab options data is never cached
  // either way, so this toggle has no effect on it. One switch for the
  // whole run, deliberately — no per-field refresh buttons, since a
  // freshly-refreshed field sitting next to stale trade geometry is a
  // worse, misleading state than just re-running everything.
  const [forceFresh, setForceFresh] = useState(false);
  // Which tab(s) "Run Screen" recomputes — RS Pullback and the four
  // legacy tabs have different enrichment costs and different Finnhub
  // exposure, so running only what's needed cuts throttling and
  // turnaround time. Not persisted — defaults back to "all" every visit.
  const [runTarget, setRunTarget] = useState<"all" | "legacy" | "rs_pullback">("all");
  // Minimum ADR%% filter — restored from localStorage on mount (same
  // persistence convention screener-view.tsx uses for its own controls),
  // defaulting to 3.0 for a first-ever visit. Lazy initializer so SSR/first
  // paint doesn't show the default and then jump.
  const [minAdrPct, setMinAdrPct] = useState<number>(() => {
    if (typeof window === "undefined") return DEFAULT_MIN_ADR_PCT;
    const raw = window.localStorage.getItem(LS_MIN_ADR_PCT);
    const n = raw !== null ? Number(raw) : NaN;
    return Number.isFinite(n) && n >= 0 ? n : DEFAULT_MIN_ADR_PCT;
  });
  useEffect(() => {
    window.localStorage.setItem(LS_MIN_ADR_PCT, String(minAdrPct));
  }, [minAdrPct]);
  const [rsPullbackThresholds, setRsPullbackThresholds] = useState<RsPullbackThresholds>(() => {
    if (typeof window === "undefined") return DEFAULT_RS_PULLBACK_THRESHOLDS;
    try {
      const raw = window.localStorage.getItem(LS_RS_PULLBACK_THRESHOLDS);
      if (!raw) return DEFAULT_RS_PULLBACK_THRESHOLDS;
      const parsed = JSON.parse(raw) as Partial<RsPullbackThresholds>;
      return { ...DEFAULT_RS_PULLBACK_THRESHOLDS, ...parsed };
    } catch {
      return DEFAULT_RS_PULLBACK_THRESHOLDS;
    }
  });
  useEffect(() => {
    window.localStorage.setItem(LS_RS_PULLBACK_THRESHOLDS, JSON.stringify(rsPullbackThresholds));
  }, [rsPullbackThresholds]);
  // Display-only Extension/R:R color bands — same persistence
  // convention as rsPullbackThresholds above, but this one never enters
  // the screen request body (see the two fetch calls below); it only
  // ever reaches RsPullbackRow as a prop for coloring.
  const [rsPullbackColorBands, setRsPullbackColorBands] = useState<RsPullbackColorBands>(() => {
    if (typeof window === "undefined") return DEFAULT_RS_PULLBACK_COLOR_BANDS;
    try {
      const raw = window.localStorage.getItem(LS_RS_PULLBACK_COLOR_BANDS);
      if (!raw) return DEFAULT_RS_PULLBACK_COLOR_BANDS;
      const parsed = JSON.parse(raw) as Partial<RsPullbackColorBands>;
      return { ...DEFAULT_RS_PULLBACK_COLOR_BANDS, ...parsed };
    } catch {
      return DEFAULT_RS_PULLBACK_COLOR_BANDS;
    }
  });
  useEffect(() => {
    window.localStorage.setItem(LS_RS_PULLBACK_COLOR_BANDS, JSON.stringify(rsPullbackColorBands));
  }, [rsPullbackColorBands]);
  // Display-only target-window / R:R-floor exit rules — same persistence
  // convention as rsPullbackColorBands above; never enters the screen
  // request body, only reaches RsPullbackRow/RsPullbackNearMissRow as a
  // prop for whether R:R prints and whether Enter shows.
  const [rsPullbackExitRules, setRsPullbackExitRules] = useState<RsPullbackExitRules>(() => {
    if (typeof window === "undefined") return DEFAULT_RS_PULLBACK_EXIT_RULES;
    try {
      const raw = window.localStorage.getItem(LS_RS_PULLBACK_EXIT_RULES);
      if (!raw) return DEFAULT_RS_PULLBACK_EXIT_RULES;
      const parsed = JSON.parse(raw) as Partial<RsPullbackExitRules>;
      return { ...DEFAULT_RS_PULLBACK_EXIT_RULES, ...parsed };
    } catch {
      return DEFAULT_RS_PULLBACK_EXIT_RULES;
    }
  });
  useEffect(() => {
    window.localStorage.setItem(LS_RS_PULLBACK_EXIT_RULES, JSON.stringify(rsPullbackExitRules));
  }, [rsPullbackExitRules]);
  // Universe & Themes, Phase B — which universe the screener runs
  // against. Persisted the same way minAdrPct/rsPullbackThresholds are;
  // defaults to the index universe only, matching pre-Phase-B behavior
  // for a first-ever visit or a cleared localStorage.
  const [universeSelection, setUniverseSelection] = useState<UniverseSelection>(() => {
    if (typeof window === "undefined") return DEFAULT_UNIVERSE_SELECTION;
    try {
      const raw = window.localStorage.getItem(LS_UNIVERSE_SELECTION);
      if (!raw) return DEFAULT_UNIVERSE_SELECTION;
      const parsed = JSON.parse(raw) as Partial<UniverseSelection>;
      return {
        includeIndex: typeof parsed.includeIndex === "boolean" ? parsed.includeIndex : true,
        themeIds: Array.isArray(parsed.themeIds)
          ? parsed.themeIds.filter((s): s is string => typeof s === "string")
          : [],
        allThemes: parsed.allThemes === true,
      };
    } catch {
      return DEFAULT_UNIVERSE_SELECTION;
    }
  });
  useEffect(() => {
    window.localStorage.setItem(LS_UNIVERSE_SELECTION, JSON.stringify(universeSelection));
  }, [universeSelection]);
  // Active themes to offer in the selector — refetched on mount only;
  // archiving/adding a theme mid-session just needs a page reload to show
  // up here, same freshness contract the rest of this view uses for its
  // other once-per-mount fetches (regime, cached result).
  const [activeThemes, setActiveThemes] = useState<ActiveTheme[]>([]);
  useEffect(() => {
    fetch("/api/swings/universe/themes", { cache: "no-store" })
      .then((r) => r.json())
      .then(
        (j: {
          themes?: Array<{ id: string; name: string; is_active: boolean; memberCount: number }>;
        }) => {
          setActiveThemes(
            (j.themes ?? [])
              .filter((t) => t.is_active)
              .map((t) => ({ id: t.id, name: t.name, memberCount: t.memberCount })),
          );
        },
      )
      .catch(() => {});
  }, []);
  const [resolvedUniverse, setResolvedUniverse] = useState<ResolvedUniverse | null>(null);
  const [resolvingUniverse, setResolvingUniverse] = useState(false);
  const [resolveError, setResolveError] = useState<string | null>(null);
  const universeThemeIdsKey = universeSelection.themeIds.join(",");
  useEffect(() => {
    let cancelled = false;
    setResolvingUniverse(true);
    setResolveError(null);
    resolveUniverse(universeSelection)
      .then((r) => {
        if (!cancelled) setResolvedUniverse(r);
      })
      .catch((e) => {
        if (!cancelled) setResolveError(e instanceof Error ? e.message : "Failed to resolve universe");
      })
      .finally(() => {
        if (!cancelled) setResolvingUniverse(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [universeSelection.includeIndex, universeSelection.allThemes, universeThemeIdsKey]);
  // Bar-backfill diagnostics from the most recent run's pre-flight phase
  // — transient (not persisted), same treatment as rsPullbackDiagnostics.
  const [backfillDiagnostics, setBackfillDiagnostics] = useState<{
    alreadyCached: number;
    fetched: number;
    insufficientHistory: string[];
    fetchFailed: string[];
  } | null>(null);
  const [rsPullbackSettingsOpen, setRsPullbackSettingsOpen] = useState(false);
  const [rsPullbackDiagnostics, setRsPullbackDiagnostics] = useState<{
    pregatedCount: number;
    needsEnrichmentCount: number;
    excludedBySectorPrefilter: number;
    excludedBySma50RisingPrefilter: number;
    excludedBySma50RisingEnrichment: number;
    insufficientData: number;
    degradedCount: number;
    excludedByAbove200d: number;
    chunksDone: number;
    chunksTotal: number;
  } | null>(null);
  // Regime banner — independent of the scan pipeline, fetched once on
  // mount. Display-only; feeds market_regime on the journal's entry form,
  // never gates anything here.
  const [regime, setRegime] = useState<{ label: string } | null>(null);
  useEffect(() => {
    fetch("/api/swings/screen/regime", { cache: "no-store" })
      .then((r) => r.json())
      .then((j: { label?: string }) => {
        if (j.label) setRegime({ label: j.label });
      })
      .catch(() => {});
  }, []);
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

  // "all" = current full-pipeline behavior. "legacy" recomputes only the
  // four original tabs (skips RS Pullback entirely — no chunked
  // enrichment, no pass 3 change) and keeps whatever RS Pullback data is
  // already on screen. "rs_pullback" recomputes only RS Pullback (skips
  // pass 2 and pass 3 — catalysts don't apply to that tab anyway) and
  // keeps the existing legacy-tab data. Pass 1 always runs regardless —
  // both sides' survivor/prefilter data comes from the same call, so
  // neither target can skip it. The two tabs' candidates are always
  // structurally separate objects (never merged into one multi-tab
  // record), so splitting "legacy portion" / "rs_pullback portion" of
  // data.candidates by setupTabs is exact, not a heuristic.
  async function runScreen(target: "all" | "legacy" | "rs_pullback" = "all") {
    setRunError(null);
    setRunWarning(null);
    setPass1Count(null);
    const started = Date.now();
    const existingLegacyPortion = (data?.candidates ?? []).filter(
      (c) => !(c.setupTabs ?? []).includes("rs_pullback"),
    );
    const existingRsPullbackPortion = (data?.candidates ?? []).filter((c) =>
      (c.setupTabs ?? []).includes("rs_pullback"),
    );
    try {
      // Universe & Themes, Phase B — resolve the selected universe fresh
      // (not the selector's possibly-stale preview) so the run always
      // reflects current theme membership, then backfill daily bars for
      // anything selected but not yet sufficiently cached. Chunked,
      // sequential, and always run to completion BEFORE pass1/pass2/RS
      // Pullback start — never concurrently with them, same discipline
      // that keeps pass2 and RS Pullback's own enrichment sequential.
      setPhase("backfill");
      setBackfillDiagnostics(null);
      const resolved = await resolveUniverse(universeSelection);
      setResolvedUniverse(resolved);
      const universeSymbols = resolved.symbols;
      if (universeSymbols.length === 0) {
        throw new Error(
          "Selected universe resolved to 0 symbols — check at least one universe option.",
        );
      }
      const universeDescriptor: UniverseDescriptor = {
        includeIndex: universeSelection.includeIndex,
        themeIds: universeSelection.themeIds,
        allThemes: universeSelection.allThemes,
        themeNames: resolved.themeNames,
        resolvedCount: resolved.count,
        label: resolved.label,
      };

      const BACKFILL_CHUNK_SIZE = 100;
      let backfillQueue = [...universeSymbols];
      let backfillAlreadyCached = 0;
      let backfillFetched = 0;
      const backfillInsufficient: string[] = [];
      const backfillFailed: string[] = [];
      let backfillChunkFailed = false;
      while (backfillQueue.length > 0) {
        const chunk = backfillQueue.slice(0, BACKFILL_CHUNK_SIZE);
        backfillQueue = backfillQueue.slice(BACKFILL_CHUNK_SIZE);
        try {
          const res = await fetchPassJson<{
            alreadyCached?: string[];
            fetched?: string[];
            insufficientHistory?: string[];
            fetchFailed?: string[];
            deadlineSkipped?: string[];
          }>("Bar backfill", "/api/swings/screen/backfill-bars", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ symbols: chunk, forceFresh }),
          });
          backfillAlreadyCached += res.alreadyCached?.length ?? 0;
          backfillFetched += res.fetched?.length ?? 0;
          backfillInsufficient.push(...(res.insufficientHistory ?? []));
          backfillFailed.push(...(res.fetchFailed ?? []));
          if (res.deadlineSkipped && res.deadlineSkipped.length > 0) {
            backfillQueue = [...backfillQueue, ...res.deadlineSkipped];
          }
        } catch (e) {
          console.warn("[swing-screen] bar backfill chunk failed:", e);
          backfillChunkFailed = true;
          break;
        }
      }
      if (backfillChunkFailed) {
        setRunWarning(
          (prev) =>
            prev ??
            "Bar backfill failed partway through — some newly-added symbols may show as insufficient data rather than being fully evaluated.",
        );
      }
      setBackfillDiagnostics({
        alreadyCached: backfillAlreadyCached,
        fetched: backfillFetched,
        insufficientHistory: backfillInsufficient,
        fetchFailed: backfillFailed,
      });

      // Pass 1 — Yahoo technical filter + tab qualification on the
      // resolved universe (~20-40s for the ~580-symbol default). A
      // failure here aborts the run. forceFresh bypasses the
      // quote-sweep/Finnhub/ATR caches (but still writes fresh results
      // back) — Schwab options data is never cached either way.
      setPhase("pass1");
      const p1 = await fetchPassJson<Pass1Wire>(
        "Pass 1 (technical filter)",
        "/api/swings/screen/pass1",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ symbols: universeSymbols, forceFresh, rsPullbackThresholds }),
        },
      );
      setPass1Count(p1.survivors.length);

      let legacyCandidates: SwingCandidate[] = existingLegacyPortion;
      if (target === "all" || target === "legacy") {
        // Pass 2 — Finnhub insider + earnings + Schwab options on
        // survivors. Fatal — no candidates exist for the four legacy
        // tabs without it. Deliberately NOT run in parallel with RS
        // Pullback's enrichment below: both hit Finnhub, and running
        // them concurrently doubled the effective request rate against
        // its rate limit — the 2026-08 run that tried this saw sustained
        // 429s and silently lost legacy-tab candidates to degraded
        // (empty) insider/earnings data. Sequencing costs wall-clock
        // time but is what keeps every result actually representing
        // real data.
        setPhase("pass2");
        const p2 = await fetchPassJson<{ candidates?: SwingCandidate[] }>(
          "Pass 2 (insider/options enrichment)",
          "/api/swings/screen/pass2",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...p1, forceFresh }),
          },
        );
        const enriched = p2.candidates ?? [];

        // Pass 3 — Perplexity catalyst discovery. NON-FATAL: if it
        // fails, the run continues with pass-2 candidates (tabs intact,
        // catalysts empty) and the banner explains the degradation.
        setPhase("pass3");
        // Carry forward catalysts from the prior run when it's < 24h
        // old — Perplexity enrichment is expensive and a catalyst found
        // this morning is still the catalyst this afternoon. forceFresh
        // skips this entirely (empty knownCatalysts) so every candidate
        // gets a fresh Perplexity pull, subject to the same per-run cap.
        const knownCatalysts: Record<string, unknown> = {};
        if (
          !forceFresh &&
          data?.screenedAt &&
          Date.now() - new Date(data.screenedAt).getTime() < 24 * 3600_000
        ) {
          for (const prev of existingLegacyPortion) {
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
          legacyCandidates = (p3.candidates ?? enriched).map(normalizeCandidate);
        } catch (e) {
          legacyCandidates = enriched.map(normalizeCandidate);
          setRunWarning(
            `${e instanceof Error ? e.message : "Pass 3 failed"}. Showing the screen without catalyst enrichment — all four tabs are still populated.`,
          );
        }
      }

      let rsPullbackCandidates: SwingCandidate[] = existingRsPullbackPortion;
      // Set below whenever RS Pullback actually runs this target — carried
      // into the save call so a zero-candidate run still records why:
      // nothing pregated, vs. pregated-but-excluded, vs.
      // evaluated-and-disqualified. Left undefined for a "legacy"-only
      // run, where save's mode gating skips the rs_pullback row entirely
      // and this would be stale from a prior run otherwise.
      let rsPullbackDiagnosticsForSave: RsPullbackRunDiagnostics | undefined;
      if (target === "all" || target === "rs_pullback") {
        // RS Pullback enrichment — chunked, sequential calls over
        // pass1's rsPullback.needsEnrichment (already narrowed by the
        // free cache-only pre-filter in pass1Filter). Every symbol in
        // that list gets a chunk call; a chunk that reports
        // deadlineSkipped symbols gets those re-queued into the NEXT
        // chunk rather than dropped, so coverage is a mechanical
        // guarantee, not a best-effort. NON-FATAL as a whole (matches
        // pass 3's treatment) — a chunk failure is logged and surfaced
        // as a warning, not an aborted run.
        setPhase("rs_pullback");
        const needsEnrichment = p1.rsPullback?.needsEnrichment ?? [];
        const RS_PULLBACK_CHUNK_SIZE = 100;
        let freshRsPullbackCandidates: SwingCandidate[] = [];
        let excludedBySma50RisingEnrichment = 0;
        let insufficientData = 0;
        let degradedCount = 0;
        let rsPullbackChunkFailed = false;
        let queue = [...needsEnrichment];
        let chunksDone = 0;
        // chunksTotal is an estimate for the progress banner — it grows
        // if a chunk re-queues deadlineSkipped symbols, so "chunk 3 of
        // 3" can become "chunk 3 of 4" rather than silently going over.
        let chunksTotalEstimate = Math.ceil(queue.length / RS_PULLBACK_CHUNK_SIZE);
        setRsPullbackDiagnostics({
          pregatedCount: p1.rsPullback?.pregatedCount ?? 0,
          needsEnrichmentCount: needsEnrichment.length,
          excludedBySectorPrefilter: p1.rsPullback?.excludedBySectorPrefilter ?? 0,
          excludedBySma50RisingPrefilter: p1.rsPullback?.excludedBySma50RisingPrefilter ?? 0,
          excludedBySma50RisingEnrichment: 0,
          insufficientData: 0,
          degradedCount: 0,
          excludedByAbove200d: p1.rsPullback?.excludedByAbove200d ?? 0,
          chunksDone: 0,
          chunksTotal: chunksTotalEstimate,
        });
        while (queue.length > 0) {
          const chunk = queue.slice(0, RS_PULLBACK_CHUNK_SIZE);
          queue = queue.slice(RS_PULLBACK_CHUNK_SIZE);
          try {
            const res = await fetchPassJson<{
              candidates?: SwingCandidate[];
              excludedBySma50Rising?: number;
              insufficientData?: number;
              degradedCount?: number;
              deadlineSkipped?: string[];
            }>(
              `RS Pullback enrichment (chunk ${chunksDone + 1})`,
              "/api/swings/screen/pass2-rs-pullback",
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ ...p1, symbols: chunk, forceFresh, rsPullbackThresholds }),
              },
            );
            freshRsPullbackCandidates = [...freshRsPullbackCandidates, ...(res.candidates ?? [])];
            excludedBySma50RisingEnrichment += res.excludedBySma50Rising ?? 0;
            insufficientData += res.insufficientData ?? 0;
            degradedCount += res.degradedCount ?? 0;
            if (res.deadlineSkipped && res.deadlineSkipped.length > 0) {
              queue = [...queue, ...res.deadlineSkipped];
              chunksTotalEstimate = chunksDone + 1 + Math.ceil(queue.length / RS_PULLBACK_CHUNK_SIZE);
            }
          } catch (e) {
            console.warn(`[swing-screen] RS Pullback chunk ${chunksDone + 1} failed:`, e);
            rsPullbackChunkFailed = true;
            // Don't re-queue on a hard failure (network/500) — retrying
            // the same chunk immediately would likely just fail again;
            // the warning below tells the user this run's RS Pullback
            // coverage is incomplete rather than silently under-reporting
            // it.
          }
          chunksDone += 1;
          setRsPullbackDiagnostics({
            pregatedCount: p1.rsPullback?.pregatedCount ?? 0,
            needsEnrichmentCount: needsEnrichment.length,
            excludedBySectorPrefilter: p1.rsPullback?.excludedBySectorPrefilter ?? 0,
            excludedBySma50RisingPrefilter: p1.rsPullback?.excludedBySma50RisingPrefilter ?? 0,
            excludedBySma50RisingEnrichment,
            insufficientData,
            degradedCount,
            excludedByAbove200d: p1.rsPullback?.excludedByAbove200d ?? 0,
            chunksDone,
            chunksTotal: chunksTotalEstimate,
          });
        }
        if (rsPullbackChunkFailed) {
          setRunWarning(
            (prev) =>
              prev ??
              "RS Pullback enrichment failed partway through — its lists may be incomplete for this run. The other four tabs are unaffected.",
          );
        }
        // Prefilter-tier near-miss candidates (see pass1Filter's
        // rsPullback.prefilterNearMiss) are already fully built — computed
        // synchronously, cache-only, during pass 1 — so they're folded in
        // directly rather than routed through another enrichment chunk.
        rsPullbackCandidates = [
          ...(p1.rsPullback?.prefilterNearMiss ?? []),
          ...freshRsPullbackCandidates,
        ].map(normalizeCandidate);
        rsPullbackDiagnosticsForSave = {
          pregatedCount: p1.rsPullback?.pregatedCount ?? 0,
          needsEnrichmentCount: needsEnrichment.length,
          excludedBySectorPrefilter: p1.rsPullback?.excludedBySectorPrefilter ?? 0,
          excludedBySma50RisingPrefilter: p1.rsPullback?.excludedBySma50RisingPrefilter ?? 0,
          excludedBySma50RisingEnrichment,
          insufficientData,
          degradedCount,
          excludedByAbove200d: p1.rsPullback?.excludedByAbove200d ?? 0,
        };
      }

      const candidates = [...legacyCandidates, ...rsPullbackCandidates];

      const result: CachedResult = {
        candidates,
        screened: p1.screened,
        pass1Survivors: p1.survivors.length,
        pass2Results: candidates.length,
        durationMs: Date.now() - started,
        errors: p1.errors ?? [],
        screenedAt: new Date().toISOString(),
        universe: universeDescriptor,
      };

      // Save — fast (<1s). NON-FATAL: failure keeps the visible
      // result, it just won't survive a reload. mode scopes the write to
      // what was actually recomputed this run — see the save route's own
      // comment for why a partial run must not touch the other side's
      // persisted data.
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
              mode: target,
              universe: universeDescriptor,
              rsPullbackDiagnostics: rsPullbackDiagnosticsForSave,
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
      rs_pullback: 0,
    };
    for (const c of data?.candidates ?? []) {
      for (const t of candidateTabs(c)) {
        // Near-miss watch rows are track-only, not qualifying — excluded
        // from the tab badge so it keeps reading as a qualifying count,
        // not a scope/gating change (near-miss is purely additive).
        if (t === "rs_pullback" && c.rsPullbackList === "near_miss") continue;
        counts[t] += 1;
      }
    }
    return counts;
  }, [data]);

  // ADR% filter is display/filter only — never touches score, tabs, or
  // qualification. A candidate with adr20Pct === null (daily_bars_cache
  // miss, e.g. a too-recent IPO) fails the filter rather than bypassing
  // it — "unknown" shouldn't get a pass a known-too-low name wouldn't.
  const sortedCandidates = useMemo(
    () =>
      sortCandidates(
        (data?.candidates ?? []).filter(
          (c) =>
            candidateTabs(c).includes(activeTab) &&
            c.adr20Pct !== null &&
            c.adr20Pct !== undefined &&
            c.adr20Pct >= minAdrPct,
        ),
        sort,
        activeTab,
      ),
    [data, sort, activeTab, minAdrPct],
  );

  // RS Pullback bypasses the generic minAdrPct control/sortedCandidates
  // pipeline entirely — it has its own dedicated ADR threshold as part of
  // rsPullbackThresholds, and mixing the two would mean two different
  // ADR minimums silently fighting each other. viewCandidates is either
  // the live run's data or a past run selected from history (see
  // RsPullbackHistoryPicker) — null means "live".
  const [rsPullbackHistoryView, setRsPullbackHistoryView] = useState<SwingCandidate[] | null>(
    null,
  );

  // ---- Price-only refresh (see refreshRsPullbackPrices below) ----
  // Transient overlay, never written to data/candidates or any save
  // endpoint — a symbol's entry here means "show this row with a fresh
  // price instead of the last full run's," nothing more. Cleared
  // whenever a real full run completes (candidates change) or the user
  // switches to a history view, since a refresh only makes sense against
  // the live run it was taken from.
  const [rsPullbackPriceRefresh, setRsPullbackPriceRefresh] = useState<{
    pricesAsOf: string;
    bySymbol: Map<
      string,
      { currentPrice: number; extensionAdrDays: number | null; vsMA50: number; rr: number | null; rsPullbackList: "ready" | "leading_extended" | "in_zone_lagging" }
    >;
  } | null>(null);
  const [refreshingPrices, setRefreshingPrices] = useState(false);
  const [refreshPricesError, setRefreshPricesError] = useState<string | null>(null);

  const rsPullbackLists = useMemo(() => {
    const source = rsPullbackHistoryView ?? data?.candidates ?? [];
    let all = source.filter((c) => (c.setupTabs ?? []).includes("rs_pullback"));
    if (!rsPullbackHistoryView && rsPullbackPriceRefresh) {
      all = all.map((c) => {
        const r = rsPullbackPriceRefresh.bySymbol.get(c.symbol);
        if (!r) return c;
        return {
          ...c,
          currentPrice: r.currentPrice,
          entryPrice: r.currentPrice,
          extensionAdrDays: r.extensionAdrDays,
          vsMA50: r.vsMA50,
          rr: r.rr,
          rsPullbackList: r.rsPullbackList,
          priceRefreshed: true,
        };
      });
    }
    const ready = all.filter((c) => c.rsPullbackList === "ready");
    const leadingExtended = all
      .filter((c) => c.rsPullbackList === "leading_extended")
      .sort((a, b) => (a.extensionAdrDays ?? Infinity) - (b.extensionAdrDays ?? Infinity));
    const inZoneLagging = all.filter((c) => c.rsPullbackList === "in_zone_lagging");
    const nearMiss = all
      .filter((c) => c.rsPullbackList === "near_miss")
      .sort((a, b) => (a.nearMissGap ?? Infinity) - (b.nearMissGap ?? Infinity));
    return { ready, leadingExtended, inZoneLagging, nearMiss };
  }, [rsPullbackHistoryView, data, rsPullbackPriceRefresh]);

  // A real full run (new candidates) makes any in-flight refresh stale
  // by definition — the "last full run" the refresh was computed against
  // no longer exists. Same for switching into a history view.
  useEffect(() => {
    setRsPullbackPriceRefresh(null);
  }, [data?.screenedAt]);
  useEffect(() => {
    if (rsPullbackHistoryView) setRsPullbackPriceRefresh(null);
  }, [rsPullbackHistoryView]);

  // Sequential, chunked price-only fetch (see
  // app/api/swings/screen/rs-pullback/refresh-prices/route.ts — one
  // Yahoo quote() per symbol, no bars, no DB write) over the LIVE run's
  // ready/leading-extended/in-zone-lagging symbols (near-miss rows have
  // no extension-based bucket to move between, so they're left out of
  // the fetch). Recomputes exactly what price affects — extension
  // (against the cached sma50AtEntry), R:R and target distance (against
  // the cached, unmoved targetPrice/stopPrice), and bucket membership —
  // everything else (SMA50 itself, ATR14, RS20/RS60, higher-low, gate
  // pass/fail) carries forward untouched because this never re-reads or
  // recomputes those fields at all. Never calls /save — see
  // rsPullbackPriceRefresh's own comment for why this stays transient.
  const REFRESH_CHUNK_SIZE = 40;
  async function refreshRsPullbackPrices() {
    if (!data || rsPullbackHistoryView) return;
    const live = data.candidates.filter((c) => (c.setupTabs ?? []).includes("rs_pullback"));
    const refreshable = live.filter(
      (c) => c.rsPullbackList === "ready" || c.rsPullbackList === "leading_extended" || c.rsPullbackList === "in_zone_lagging",
    );
    if (refreshable.length === 0) return;
    setRefreshingPrices(true);
    setRefreshPricesError(null);
    try {
      const priceBySymbol = new Map<string, number | null>();
      for (let i = 0; i < refreshable.length; i += REFRESH_CHUNK_SIZE) {
        const chunk = refreshable.slice(i, i + REFRESH_CHUNK_SIZE);
        const params = new URLSearchParams({ symbols: chunk.map((c) => c.symbol).join(",") });
        const res = await fetch(`/api/swings/screen/rs-pullback/refresh-prices?${params.toString()}`, {
          cache: "no-store",
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
        for (const [symbol, price] of Object.entries(json.prices as Record<string, number | null>)) {
          priceBySymbol.set(symbol, price);
        }
      }

      const bySymbol = new Map<
        string,
        { currentPrice: number; extensionAdrDays: number | null; vsMA50: number; rr: number | null; rsPullbackList: "ready" | "leading_extended" | "in_zone_lagging" }
      >();
      for (const c of refreshable) {
        const freshPrice = priceBySymbol.get(c.symbol);
        if (freshPrice === null || freshPrice === undefined || !Number.isFinite(freshPrice) || freshPrice <= 0) {
          continue; // couldn't get a fresh price — leave this row as the last full run had it
        }
        const sma50 = c.sma50AtEntry;
        const adr = c.adr20Pct;
        const extensionAdrDays =
          sma50 !== null && sma50 !== undefined && sma50 > 0 && adr !== null && adr !== undefined && adr !== 0
            ? (((freshPrice - sma50) / sma50) * 100) / adr
            : null;
        const vsMA50 = sma50 !== null && sma50 !== undefined && sma50 > 0 ? (freshPrice - sma50) / sma50 : c.vsMA50;
        const risk = freshPrice - c.stopPrice;
        const reward = c.targetPrice - freshPrice;
        const rr = risk > 0 ? reward / risk : null;

        // Bucket membership: only the ready<->leading_extended boundary
        // can move on a price refresh (both require passing RS, frozen
        // from the last full run — see rs20/rs60 above). In zone/lagging
        // rows never had passing RS to begin with, so there's no bucket
        // for "extended AND still failing RS" in the full-run model;
        // a lagging row's own bucket stays put on refresh (only its
        // displayed extension/R:R update), matching the one motivating
        // case this feature exists for: a name moving INTO the entry
        // zone, not lagging rows leaving it.
        let rsPullbackList: "ready" | "leading_extended" | "in_zone_lagging" = c.rsPullbackList as
          | "ready"
          | "leading_extended"
          | "in_zone_lagging";
        if (c.rsPullbackList !== "in_zone_lagging") {
          const inEntryZone =
            extensionAdrDays !== null && Math.abs(extensionAdrDays) <= rsPullbackThresholds.entryZoneAdrDays;
          rsPullbackList = inEntryZone ? "ready" : "leading_extended";
        }

        bySymbol.set(c.symbol, { currentPrice: freshPrice, extensionAdrDays, vsMA50, rr, rsPullbackList });
      }

      setRsPullbackPriceRefresh({ pricesAsOf: new Date().toISOString(), bySymbol });
    } catch (e) {
      setRefreshPricesError(e instanceof Error ? e.message : "Price refresh failed");
    } finally {
      setRefreshingPrices(false);
    }
  }

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
      {regime && (
        <div className="rounded-md border border-border/60 bg-background/40 px-3 py-1.5 text-sm text-muted-foreground">
          Regime: <span className="text-foreground">{regime.label}</span>
        </div>
      )}
      <UniverseSelectorBar
        selection={universeSelection}
        onChange={setUniverseSelection}
        activeThemes={activeThemes}
        resolved={resolvedUniverse}
        resolving={resolvingUniverse}
        resolveError={resolveError}
        disabled={running}
      />
      {backfillDiagnostics &&
        (backfillDiagnostics.fetched > 0 ||
          backfillDiagnostics.insufficientHistory.length > 0 ||
          backfillDiagnostics.fetchFailed.length > 0) && (
          <div className="rounded-md border border-border/60 bg-background/40 px-3 py-1.5 text-sm text-muted-foreground">
            Bars: <span className="text-foreground">{backfillDiagnostics.alreadyCached}</span> already
            cached · <span className="text-foreground">{backfillDiagnostics.fetched}</span> backfilled
            {backfillDiagnostics.insufficientHistory.length > 0 && (
              <>
                {" · "}
                <span className="text-amber-300">
                  {backfillDiagnostics.insufficientHistory.length}
                </span>{" "}
                could not be evaluated (insufficient history):{" "}
                <span
                  title={backfillDiagnostics.insufficientHistory.join(", ")}
                  className="text-foreground"
                >
                  {backfillDiagnostics.insufficientHistory.slice(0, 6).join(", ")}
                  {backfillDiagnostics.insufficientHistory.length > 6 ? "…" : ""}
                </span>
              </>
            )}
            {backfillDiagnostics.fetchFailed.length > 0 && (
              <>
                {" · "}
                <span className="text-rose-300">{backfillDiagnostics.fetchFailed.length}</span> fetch
                failed:{" "}
                <span title={backfillDiagnostics.fetchFailed.join(", ")} className="text-foreground">
                  {backfillDiagnostics.fetchFailed.slice(0, 6).join(", ")}
                  {backfillDiagnostics.fetchFailed.length > 6 ? "…" : ""}
                </span>
              </>
            )}
          </div>
        )}
      <ControlsBar
        data={data}
        loading={loading}
        running={running}
        onRun={() => runScreen(runTarget)}
        runTarget={runTarget}
        onRunTargetChange={setRunTarget}
        forceFresh={forceFresh}
        onForceFreshChange={setForceFresh}
        minAdrPct={minAdrPct}
        onMinAdrPctChange={setMinAdrPct}
        activeTab={activeTab}
      />

      {running && (
        <RunningBanner
          phase={phase}
          pass1Count={pass1Count}
          rsPullbackDiagnostics={rsPullbackDiagnostics}
          resolvedUniverse={resolvedUniverse}
        />
      )}
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
          {activeTab === "rs_pullback" ? (
            <RsPullbackTabContent
              lists={rsPullbackLists}
              diagnostics={rsPullbackDiagnostics}
              thresholds={rsPullbackThresholds}
              onThresholdsChange={setRsPullbackThresholds}
              colorBands={rsPullbackColorBands}
              onColorBandsChange={setRsPullbackColorBands}
              exitRules={rsPullbackExitRules}
              onExitRulesChange={setRsPullbackExitRules}
              settingsOpen={rsPullbackSettingsOpen}
              onSettingsOpenChange={setRsPullbackSettingsOpen}
              viewingHistory={rsPullbackHistoryView !== null}
              onSelectRun={setRsPullbackHistoryView}
              onEnterTrade={(symbol) => {
                setImportSymbol(symbol);
                setImportOpen(true);
              }}
              onTrack={(c) => handleTrack(c, "rs_pullback")}
              trackedSymbols={trackedSymbols}
              trackingSymbol={trackingSymbol}
              screenedAt={data.screenedAt}
              priceRefresh={rsPullbackPriceRefresh}
              refreshingPrices={refreshingPrices}
              refreshPricesError={refreshPricesError}
              onRefreshPrices={refreshRsPullbackPrices}
            />
          ) : sortedCandidates.length === 0 ? (
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

// Universe & Themes, Phase B — multi-select: the index universe, any
// number of active themes, and/or "All themes" combine (union, deduped
// server-side). Checking "All themes" disables the individual theme
// checkboxes since they'd be redundant, but doesn't clear them — a user
// unchecking "All themes" gets back whatever specific themes were picked
// before, rather than losing that choice.
function UniverseSelectorBar({
  selection,
  onChange,
  activeThemes,
  resolved,
  resolving,
  resolveError,
  disabled,
}: {
  selection: UniverseSelection;
  onChange: (s: UniverseSelection) => void;
  activeThemes: ActiveTheme[];
  resolved: ResolvedUniverse | null;
  resolving: boolean;
  resolveError: string | null;
  disabled: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md border border-border bg-background/40 p-3 text-sm">
      <span className="text-muted-foreground">Universe:</span>
      <label className="flex items-center gap-1.5 text-muted-foreground">
        <input
          type="checkbox"
          checked={selection.includeIndex}
          disabled={disabled}
          onChange={(e) => onChange({ ...selection, includeIndex: e.target.checked })}
        />
        S&amp;P 500 + Nasdaq 100
      </label>
      <label className="flex items-center gap-1.5 text-muted-foreground">
        <input
          type="checkbox"
          checked={selection.allThemes}
          disabled={disabled}
          onChange={(e) => onChange({ ...selection, allThemes: e.target.checked })}
        />
        All themes
      </label>
      {activeThemes.map((t) => (
        <label key={t.id} className="flex items-center gap-1.5 text-muted-foreground">
          <input
            type="checkbox"
            checked={selection.allThemes || selection.themeIds.includes(t.id)}
            disabled={disabled || selection.allThemes}
            onChange={(e) =>
              onChange({
                ...selection,
                themeIds: e.target.checked
                  ? [...selection.themeIds, t.id]
                  : selection.themeIds.filter((id) => id !== t.id),
              })
            }
          />
          {t.name} <span className="text-[10px]">({t.memberCount})</span>
        </label>
      ))}
      {activeThemes.length === 0 && (
        <Link href="/swings/universe" className="text-xs text-muted-foreground underline">
          No themes yet — create one
        </Link>
      )}
      <span className="ml-auto text-muted-foreground">
        {resolving ? (
          "Resolving…"
        ) : resolveError ? (
          <span className="text-rose-300">{resolveError}</span>
        ) : resolved ? (
          <span title={resolved.symbols.slice(0, 30).join(", ")}>
            <span className="font-mono text-foreground">{resolved.count}</span> symbols
          </span>
        ) : (
          "—"
        )}
      </span>
    </div>
  );
}

function ControlsBar({
  data,
  loading,
  running,
  onRun,
  runTarget,
  onRunTargetChange,
  forceFresh,
  onForceFreshChange,
  minAdrPct,
  onMinAdrPctChange,
  activeTab,
}: {
  data: CachedResult | null;
  loading: boolean;
  running: boolean;
  onRun: () => void;
  runTarget: "all" | "legacy" | "rs_pullback";
  onRunTargetChange: (v: "all" | "legacy" | "rs_pullback") => void;
  forceFresh: boolean;
  onForceFreshChange: (v: boolean) => void;
  minAdrPct: number;
  onMinAdrPctChange: (v: number) => void;
  activeTab: SetupTab;
}) {
  const runLabel =
    runTarget === "legacy" ? "Run Legacy Tabs" : runTarget === "rs_pullback" ? "Run RS Pullback" : "Run Screen";
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
        {data?.universe?.label && (
          <div className="text-sm text-muted-foreground">
            Universe: <span className="text-foreground">{data.universe.label}</span>
          </div>
        )}
      </div>
      <div className="flex items-center gap-3">
        <label
          className="flex items-center gap-1.5 text-sm text-muted-foreground"
          title="Runs only the selected tab(s) — the four legacy tabs (Finnhub insider/earnings + Schwab options) and RS Pullback (Finnhub earnings only) have different costs and different Finnhub exposure, so running only what's needed cuts throttling and turnaround time."
        >
          Run:
          <select
            value={runTarget}
            onChange={(e) => onRunTargetChange(e.target.value as "all" | "legacy" | "rs_pullback")}
            disabled={running}
            className="rounded border border-border bg-background px-2 py-1 text-sm"
          >
            <option value="all">All tabs</option>
            <option value="legacy">Legacy tabs only</option>
            <option value="rs_pullback">RS Pullback only</option>
          </select>
        </label>
        {activeTab === "rs_pullback" ? (
          // RS Pullback bypasses this generic filter entirely — its ADR%
          // floor is a hard gate in rsPullbackThresholds.minAdrPct, edited
          // via "Edit thresholds" below, not this control. Showing both
          // under the same "Min ADR%" label produced two different numbers
          // claiming to be the same gate (see the near-miss row fix this
          // note accompanies) — hidden here rather than synced, since
          // syncing would make this input silently start controlling a
          // gate threshold it was never meant to.
          <span
            className="text-sm text-muted-foreground"
            title="This tab's ADR% floor is set in the RS Pullback tab's own 'Edit thresholds' panel, not here — this control only filters the four legacy tabs."
          >
            Min ADR% set per-tab below
          </span>
        ) : (
          <label
            className="flex items-center gap-1.5 text-sm text-muted-foreground"
            title="Hides candidates whose 20-day Average Daily Range is below this — a 3R target needs enough daily movement to be reachable in a multi-week hold. Display/filter only; doesn't change any tab's score."
          >
            Min ADR%
            <input
              type="number"
              step="0.5"
              min="0"
              value={minAdrPct}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (Number.isFinite(n) && n >= 0) onMinAdrPctChange(n);
              }}
              className="w-16 rounded border border-border bg-background px-1.5 py-1 text-right text-sm"
            />
          </label>
        )}
        <label
          className="flex cursor-pointer items-center gap-1.5 text-sm text-muted-foreground"
          title={
            "Bypasses the quote-sweep, insider/earnings-date, and ATR caches for this run — " +
            "everything is pulled live regardless of how fresh the cache is. Catalyst research " +
            "also skips its normal 24h reuse. Options chain data is always live either way. " +
            "Fresh results still get written back to the caches for the next normal run."
          }
        >
          <input
            type="checkbox"
            checked={forceFresh}
            onChange={(e) => onForceFreshChange(e.target.checked)}
            disabled={running}
            className="h-3.5 w-3.5 accent-amber-400"
          />
          Force fresh
        </label>
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
          {running ? "Running…" : forceFresh ? `${runLabel} (fresh)` : runLabel}
        </button>
      </div>
    </div>
  );
}

function RunningBanner({
  phase,
  pass1Count,
  rsPullbackDiagnostics,
  resolvedUniverse,
}: {
  phase: RunPhase;
  pass1Count: number | null;
  rsPullbackDiagnostics: { chunksDone: number; chunksTotal: number; needsEnrichmentCount: number } | null;
  resolvedUniverse: ResolvedUniverse | null;
}) {
  const universeLabel = resolvedUniverse
    ? `${resolvedUniverse.count} stocks (${resolvedUniverse.label})`
    : "the selected universe";
  const { title, detail } = (() => {
    if (phase === "backfill") {
      return {
        title: `Backfilling daily bars — ${universeLabel}`,
        detail:
          "Checking cached bar history for every selected symbol and fetching whatever's missing before screening starts. Sequential, chunked — always completes before Pass 1.",
      };
    }
    if (phase === "pass1") {
      return {
        title: "Pass 1 — technical filter",
        detail: `Scanning ${universeLabel} for setups (price/MA/52w range/R-R). ~15-25 seconds.`,
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
    if (phase === "rs_pullback") {
      const d = rsPullbackDiagnostics;
      const chunkText = d ? `chunk ${Math.min(d.chunksDone + 1, d.chunksTotal)} of ${d.chunksTotal}` : "starting";
      return {
        title: `RS Pullback — enriching ${d?.needsEnrichmentCount ?? "—"} survivors (${chunkText})`,
        detail:
          "Sequential chunked calls (bars + earnings + sector per symbol) so every pre-filtered survivor gets evaluated without racing Pass 2 for the same Finnhub rate limit. ~10-20 seconds per chunk.",
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
      <SortHeader
        label="ADR%"
        sortKey="adr20pct"
        sort={sort}
        onSort={onSort}
        align="right"
        className="hidden md:block"
        tooltip="20-day Average Daily Range, as a % of price — how much this name typically moves in a day. Display + filter only, not part of any tab's score."
      />
      <SortHeader
        label="Sector"
        sortKey="sector"
        sort={sort}
        onSort={onSort}
        className="hidden md:block"
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

// ---------- RS Pullback (fifth tab) ----------
//
// Structurally different from the other four tabs' single sorted table:
// three named lists instead of one ranking, no score badge. Built as its
// own render path rather than shoehorned into ResultsTable/CandidateRow.

function fmtSigned(n: number | null | undefined, digits = 1): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return `${n >= 0 ? "+" : ""}${n.toFixed(digits)}`;
}

function RsPullbackSettingsPanel({
  thresholds,
  onChange,
  colorBands,
  onColorBandsChange,
  exitRules,
  onExitRulesChange,
}: {
  thresholds: RsPullbackThresholds;
  onChange: (t: RsPullbackThresholds) => void;
  colorBands: RsPullbackColorBands;
  onColorBandsChange: (b: RsPullbackColorBands) => void;
  exitRules: RsPullbackExitRules;
  onExitRulesChange: (r: RsPullbackExitRules) => void;
}) {
  function field(key: keyof RsPullbackThresholds, label: string, step = 0.5) {
    return (
      <label className="grid gap-1 text-xs">
        <span className="text-muted-foreground">{label}</span>
        <input
          type="number"
          step={step}
          value={thresholds[key]}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (Number.isFinite(n)) onChange({ ...thresholds, [key]: n });
          }}
          className="w-24 rounded border border-border bg-background px-2 py-1 text-sm"
        />
      </label>
    );
  }
  function colorField(key: keyof RsPullbackColorBands, label: string, step = 0.1) {
    return (
      <label className="grid gap-1 text-xs">
        <span className="text-muted-foreground">{label}</span>
        <input
          type="number"
          step={step}
          value={colorBands[key]}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (Number.isFinite(n)) onColorBandsChange({ ...colorBands, [key]: n });
          }}
          className="w-24 rounded border border-border bg-background px-2 py-1 text-sm"
        />
      </label>
    );
  }
  function exitRuleField(key: keyof RsPullbackExitRules, label: string, step = 0.1) {
    return (
      <label className="grid gap-1 text-xs">
        <span className="text-muted-foreground">{label}</span>
        <input
          type="number"
          step={step}
          value={exitRules[key]}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (Number.isFinite(n)) onExitRulesChange({ ...exitRules, [key]: n });
          }}
          className="w-24 rounded border border-border bg-background px-2 py-1 text-sm"
        />
      </label>
    );
  }
  return (
    <div className="space-y-3 rounded-md border border-border bg-background/40 p-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-5">
        {field("minAdrPct", "Min ADR%")}
        {field("entryZoneAdrDays", "Entry zone (ADR-days)")}
        {field("sma50RisingMinPct", "50MA rising min %")}
        {field("sma50RisingLookbackSessions", "50MA rising lookback (sessions)", 1)}
        {field("ma50BelowTolerancePct", "Max % below 50MA")}
      </div>
      <div className="border-t border-border/60 pt-3">
        <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Exit rules — guards around the target derivation, display only. Does not change the
          target/stop calculation, gating, or which list a name lands in.
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {exitRuleField("targetMinAdrDays", "Target window min (ADR-days)")}
          {exitRuleField("targetMaxAdrDays", "Target window max (ADR-days)")}
          {exitRuleField("rrFloor", "R:R floor for Enter")}
          {exitRuleField("maxEntryExtensionAdrDays", "Max extension for Enter (ADR-days)")}
        </div>
      </div>
      <div className="border-t border-border/60 pt-3">
        <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Display color bands — Extension &amp; R:R only, provisional, does not affect gating
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 md:grid-cols-7">
          {colorField("extensionFloor", "Ext floor (red below)")}
          {colorField("extensionGreenMax", "Ext green max")}
          {colorField("extensionYellowMax", "Ext yellow max")}
          {colorField("extensionOrangeMax", "Ext orange max (red above)")}
          {colorField("rrOrangeMin", "R:R orange min")}
          {colorField("rrYellowMin", "R:R yellow min")}
          {colorField("rrGreenMin", "R:R green min")}
        </div>
      </div>
    </div>
  );
}

function RsPullbackHistoryPicker({
  onSelect,
}: {
  onSelect: (candidates: SwingCandidate[] | null) => void;
}) {
  const [runs, setRuns] = useState<Array<{
    screenedAt: string;
    candidates: SwingCandidate[];
    universe: UniverseDescriptor | null;
    rsPullbackDiagnostics: RsPullbackRunDiagnostics | null;
  }> | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string>("live");

  async function load() {
    setLoading(true);
    try {
      const res = await fetch("/api/swings/screen/rs-pullback/history", { cache: "no-store" });
      const json = (await res.json()) as {
        runs?: Array<{
          screenedAt: string;
          candidates: SwingCandidate[];
          universe: UniverseDescriptor | null;
          rsPullbackDiagnostics: RsPullbackRunDiagnostics | null;
        }>;
      };
      setRuns(json.runs ?? []);
    } catch {
      setRuns([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
      Run:
      <select
        value={selected}
        disabled={loading}
        onChange={(e) => {
          const v = e.target.value;
          setSelected(v);
          if (v === "live") {
            onSelect(null);
            return;
          }
          const run = runs?.find((r) => r.screenedAt === v);
          onSelect(run?.candidates ?? []);
        }}
        className="rounded border border-border bg-background px-2 py-1 text-sm"
      >
        <option value="live">Live (current run)</option>
        {(runs ?? []).map((r) => (
          <option key={r.screenedAt} value={r.screenedAt}>
            {fmtRelDate(r.screenedAt)}
            {r.universe?.label ? ` — ${r.universe.label}` : ""}
            {` (${r.candidates.length})`}
          </option>
        ))}
      </select>
    </label>
  );
}

function RsPullbackTabContent({
  lists,
  diagnostics,
  thresholds,
  onThresholdsChange,
  colorBands,
  onColorBandsChange,
  exitRules,
  onExitRulesChange,
  settingsOpen,
  onSettingsOpenChange,
  viewingHistory,
  onSelectRun,
  onEnterTrade,
  onTrack,
  trackedSymbols,
  trackingSymbol,
  screenedAt,
  priceRefresh,
  refreshingPrices,
  refreshPricesError,
  onRefreshPrices,
}: {
  lists: {
    ready: SwingCandidate[];
    leadingExtended: SwingCandidate[];
    inZoneLagging: SwingCandidate[];
    nearMiss: SwingCandidate[];
  };
  diagnostics: {
    pregatedCount: number;
    needsEnrichmentCount: number;
    excludedBySectorPrefilter: number;
    excludedBySma50RisingPrefilter: number;
    excludedBySma50RisingEnrichment: number;
    insufficientData: number;
    degradedCount: number;
    excludedByAbove200d: number;
    chunksDone: number;
    chunksTotal: number;
  } | null;
  thresholds: RsPullbackThresholds;
  onThresholdsChange: (t: RsPullbackThresholds) => void;
  colorBands: RsPullbackColorBands;
  onColorBandsChange: (b: RsPullbackColorBands) => void;
  exitRules: RsPullbackExitRules;
  onExitRulesChange: (r: RsPullbackExitRules) => void;
  settingsOpen: boolean;
  onSettingsOpenChange: (v: boolean) => void;
  viewingHistory: boolean;
  onSelectRun: (candidates: SwingCandidate[] | null) => void;
  onEnterTrade: (symbol: string) => void;
  onTrack: (c: SwingCandidate) => void;
  trackedSymbols: Set<string>;
  trackingSymbol: string | null;
  // Price-only refresh (see refreshRsPullbackPrices) — screenedAt is the
  // underlying full run's timestamp (gates), priceRefresh is the
  // transient price overlay, if any (prices). Both null/undefined means
  // "nothing to show yet" for the respective half of the banner.
  screenedAt: string | null;
  priceRefresh: { pricesAsOf: string } | null;
  refreshingPrices: boolean;
  refreshPricesError: string | null;
  onRefreshPrices: () => void;
}) {
  const total = lists.ready.length + lists.leadingExtended.length + lists.inZoneLagging.length;
  const runAge = minutesAgo(screenedAt ? new Date(screenedAt) : null, Date.now());
  const runStale = isChainStale(
    screenedAt ? new Date(screenedAt) : null,
    Date.now(),
    RS_PULLBACK_RUN_STALE_THRESHOLD_MINUTES,
  );
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
          <span>{total} qualifying</span>
          {diagnostics && (
            <>
              <span>
                · {diagnostics.pregatedCount} pre-gated → {diagnostics.needsEnrichmentCount} needed real
                enrichment ({diagnostics.excludedBySectorPrefilter} sector + {diagnostics.excludedBySma50RisingPrefilter}{" "}
                50MA-rising excluded for free from cache)
              </span>
              <span>
                · {diagnostics.excludedBySma50RisingEnrichment} more excluded by 50MA-rising on fresh
                bars
              </span>
              {diagnostics.insufficientData > 0 && (
                <span className="text-amber-300">
                  · {diagnostics.insufficientData} could not be evaluated (no usable data)
                </span>
              )}
              {diagnostics.degradedCount > 0 && (
                <span className="text-amber-300">
                  · {diagnostics.degradedCount} enriched with incomplete data (sector/earnings check
                  failed)
                </span>
              )}
              {diagnostics.excludedByAbove200d > 0 && (
                <span title="Dropped before any bars fetch — can't confirm these would also pass 50MA-rising/RS20/RS60/ADR% without enriching a class of symbols that never reaches enrichment today, so they aren't near-miss rows.">
                  · {diagnostics.excludedByAbove200d} more sit at/below their 200MA (other gates
                  unverified — not shown in Watch, near miss)
                </span>
              )}
            </>
          )}
        </div>
        <div className="flex items-center gap-3">
          <RsPullbackHistoryPicker onSelect={onSelectRun} />
          {!viewingHistory && (
            <button
              type="button"
              onClick={onRefreshPrices}
              disabled={refreshingPrices || total === 0}
              title="Fetch current prices only for symbols already in this run — no bars, no re-enrichment, no new gate evaluation. Recomputes extension/target-distance/R:R/bucket from those fresh prices against the last full run's SMA50/ATR14/target/stop, which stay frozen. Rows that move never show Enter — re-run RS Pullback to authorize entry."
              className="flex items-center gap-1 text-xs text-muted-foreground underline decoration-dotted hover:text-foreground disabled:opacity-50"
            >
              {refreshingPrices ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <RefreshCw className="h-3 w-3" />
              )}
              {refreshingPrices ? "Refreshing prices…" : "Refresh prices"}
            </button>
          )}
          <button
            type="button"
            onClick={() => onSettingsOpenChange(!settingsOpen)}
            className="text-xs text-muted-foreground underline decoration-dotted hover:text-foreground"
          >
            {settingsOpen ? "Hide thresholds" : "Edit thresholds"}
          </button>
        </div>
      </div>

      {!viewingHistory && screenedAt && (
        <div
          className={`flex flex-wrap items-center gap-2 rounded border px-2 py-1.5 text-xs ${
            runStale
              ? "border-amber-500/40 bg-amber-500/10 text-amber-200"
              : "border-border bg-background/40 text-muted-foreground"
          }`}
        >
          {priceRefresh ? (
            <span>
              Prices as of <span className="font-medium text-foreground">{fmtShortTime(priceRefresh.pricesAsOf)}</span> · Gates
              from run at <span className="font-medium text-foreground">{fmtShortTime(screenedAt)}</span>
              {runAge !== null && ` (${runAge} min ago)`}
            </span>
          ) : (
            <span>
              Gates from run at <span className="font-medium text-foreground">{fmtShortTime(screenedAt)}</span>
              {runAge !== null && ` (${runAge} min ago)`} — showing that run&apos;s prices; use Refresh prices for current ones
            </span>
          )}
          {runStale && <span>— this run is getting old, consider re-running RS Pullback</span>}
          {refreshPricesError && <span className="text-rose-300">Refresh failed: {refreshPricesError}</span>}
        </div>
      )}

      {settingsOpen && (
        <RsPullbackSettingsPanel
          thresholds={thresholds}
          onChange={onThresholdsChange}
          colorBands={colorBands}
          onColorBandsChange={onColorBandsChange}
          exitRules={exitRules}
          onExitRulesChange={onExitRulesChange}
        />
      )}

      {viewingHistory && (
        <div className="rounded border border-sky-500/40 bg-sky-500/5 px-3 py-1.5 text-xs text-sky-200">
          Viewing a past run — read-only snapshot, not live prices.
        </div>
      )}

      <RsPullbackListSection
        title="Ready"
        subtitle="Passes RS (both windows) and sits in the entry zone."
        candidates={lists.ready}
        emptyText="No names currently pass RS with a tight-enough entry zone."
        onEnterTrade={onEnterTrade}
        onTrack={onTrack}
        trackedSymbols={trackedSymbols}
        trackingSymbol={trackingSymbol}
        colorBands={colorBands}
        exitRules={exitRules}
      />
      <RsPullbackListSection
        title="Leading, extended"
        subtitle="Passes RS but too far above its 50MA to enter yet — sorted closest-to-entry first."
        candidates={lists.leadingExtended}
        emptyText="No names are currently leading-but-extended."
        onEnterTrade={onEnterTrade}
        onTrack={onTrack}
        trackedSymbols={trackedSymbols}
        trackingSymbol={trackingSymbol}
        colorBands={colorBands}
        exitRules={exitRules}
      />
      <RsPullbackListSection
        title="In zone, lagging"
        subtitle="Sits in the entry zone but fails relative strength — a control group, not a buy list."
        candidates={lists.inZoneLagging}
        emptyText="Nothing in the entry zone is currently lagging SPY."
        onEnterTrade={onEnterTrade}
        onTrack={onTrack}
        trackedSymbols={trackedSymbols}
        trackingSymbol={trackingSymbol}
        colorBands={colorBands}
        exitRules={exitRules}
      />
      <RsPullbackNearMissSection
        candidates={lists.nearMiss}
        onTrack={onTrack}
        trackedSymbols={trackedSymbols}
        trackingSymbol={trackingSymbol}
        colorBands={colorBands}
        exitRules={exitRules}
      />
    </div>
  );
}

// Column keys the three RS Pullback lists can sort on. "extensionAbs" is
// synthetic (not a real field) — it's the default so all three lists open
// sorted closest-to-entry first; clicking the "Ext" header switches to
// the signed value like any other column.
type RsPullbackSortKey =
  | "symbol"
  | "sector"
  | "price"
  | "vsMA50"
  | "adr"
  | "extension"
  | "extensionAbs"
  | "rs20"
  | "rs60"
  | "rr";

const RS_PULLBACK_SORT_VALUE: Record<
  RsPullbackSortKey,
  { get: (c: SwingCandidate) => number | string | null; defaultDir: "asc" | "desc" }
> = {
  symbol: { get: (c) => c.symbol, defaultDir: "asc" },
  sector: { get: (c) => c.sector ?? "", defaultDir: "asc" },
  price: { get: (c) => c.currentPrice, defaultDir: "desc" },
  vsMA50: { get: (c) => c.vsMA50, defaultDir: "asc" },
  adr: { get: (c) => c.adr20Pct ?? null, defaultDir: "desc" },
  extension: { get: (c) => c.extensionAdrDays ?? null, defaultDir: "asc" },
  extensionAbs: { get: (c) => (c.extensionAdrDays !== null && c.extensionAdrDays !== undefined ? Math.abs(c.extensionAdrDays) : null), defaultDir: "asc" },
  rs20: { get: (c) => c.rs20 ?? null, defaultDir: "desc" },
  rs60: { get: (c) => c.rs60 ?? null, defaultDir: "desc" },
  rr: { get: (c) => c.rr, defaultDir: "desc" },
};

function sortRsPullbackCandidates(
  candidates: SwingCandidate[],
  sort: { key: RsPullbackSortKey; dir: "asc" | "desc" },
): SwingCandidate[] {
  const desc = RS_PULLBACK_SORT_VALUE[sort.key];
  return [...candidates].sort((a, b) => {
    const av = desc.get(a);
    const bv = desc.get(b);
    const primary = compareSortValues(av, bv, sort.dir);
    if (primary !== 0) return primary;
    return a.symbol.localeCompare(b.symbol);
  });
}

function RsPullbackSortTh({
  label,
  sortKey,
  sort,
  onSort,
  align = "right",
  titleOverride,
}: {
  label: string;
  sortKey: RsPullbackSortKey;
  sort: { key: RsPullbackSortKey; dir: "asc" | "desc" };
  onSort: (k: RsPullbackSortKey) => void;
  align?: "left" | "right" | "center";
  // Column-specific helper text (e.g. R:R's exit-rule rule) — shown on
  // hover the same way a plain <th title=...> would, without disturbing
  // every other caller of this shared sortable header.
  titleOverride?: string;
}) {
  const isActive = sort.key === sortKey;
  const justify = align === "right" ? "justify-end" : align === "center" ? "justify-center" : "justify-start";
  return (
    <th className={`px-2 py-1.5 text-${align}`} title={titleOverride}>
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={`flex w-full items-center gap-1 ${justify} ${isActive ? "text-foreground" : "hover:text-foreground"}`}
      >
        {label}
        {isActive && <span className="text-[9px]">{sort.dir === "asc" ? "▲" : "▼"}</span>}
      </button>
    </th>
  );
}

function RsPullbackListSection({
  title,
  subtitle,
  candidates,
  emptyText,
  onEnterTrade,
  onTrack,
  trackedSymbols,
  trackingSymbol,
  colorBands,
  exitRules,
}: {
  title: string;
  subtitle: string;
  candidates: SwingCandidate[];
  emptyText: string;
  onEnterTrade: (symbol: string) => void;
  onTrack: (c: SwingCandidate) => void;
  trackedSymbols: Set<string>;
  trackingSymbol: string | null;
  colorBands: RsPullbackColorBands;
  exitRules: RsPullbackExitRules;
}) {
  const [sort, setSort] = useState<{ key: RsPullbackSortKey; dir: "asc" | "desc" }>({
    key: "extensionAbs",
    dir: "asc",
  });
  function onSort(key: RsPullbackSortKey) {
    setSort((cur) => {
      if (cur.key !== key) return { key, dir: RS_PULLBACK_SORT_VALUE[key].defaultDir };
      return { key, dir: cur.dir === "asc" ? "desc" : "asc" };
    });
  }
  const sorted = useMemo(() => sortRsPullbackCandidates(candidates, sort), [candidates, sort]);

  return (
    <div className="space-y-2">
      <div>
        <div className="flex items-baseline gap-2">
          <h3 className="text-sm font-semibold text-foreground">{title}</h3>
          <span className="text-xs text-muted-foreground">({candidates.length})</span>
        </div>
        <div className="text-xs text-muted-foreground">{subtitle}</div>
      </div>
      {candidates.length === 0 ? (
        <div className="rounded border border-border/60 bg-background/30 px-3 py-2 text-xs text-muted-foreground">
          {emptyText}
        </div>
      ) : (
        <div className="overflow-x-auto rounded border border-border">
          <table className="w-full min-w-[900px] text-sm">
            <thead className="border-b border-border/60 text-left text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              <tr>
                <RsPullbackSortTh label="Symbol" sortKey="symbol" sort={sort} onSort={onSort} align="left" />
                <RsPullbackSortTh label="Sector" sortKey="sector" sort={sort} onSort={onSort} align="left" />
                <RsPullbackSortTh label="Price" sortKey="price" sort={sort} onSort={onSort} />
                <RsPullbackSortTh label="vs 50MA" sortKey="vsMA50" sort={sort} onSort={onSort} />
                <RsPullbackSortTh label="ADR%" sortKey="adr" sort={sort} onSort={onSort} />
                <RsPullbackSortTh label="Ext (ADR-days)" sortKey="extension" sort={sort} onSort={onSort} />
                <RsPullbackSortTh label="RS20" sortKey="rs20" sort={sort} onSort={onSort} />
                <RsPullbackSortTh label="RS60" sortKey="rs60" sort={sort} onSort={onSort} />
                <th className="px-2 py-1.5 text-center">Higher low</th>
                <th className="px-2 py-1.5 text-right">Entry</th>
                <th className="px-2 py-1.5 text-right" title={targetHelperText(exitRules)}>
                  Target
                </th>
                <th className="px-2 py-1.5 text-right">Stop</th>
                <RsPullbackSortTh label="R:R" sortKey="rr" sort={sort} onSort={onSort} titleOverride={rrHelperText(exitRules)} />
                <th className="px-2 py-1.5 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((c) => (
                <RsPullbackRow
                  key={c.symbol}
                  candidate={c}
                  onEnterTrade={() => onEnterTrade(c.symbol)}
                  onTrack={() => onTrack(c)}
                  tracked={trackedSymbols.has(c.symbol)}
                  tracking={trackingSymbol === c.symbol}
                  colorBands={colorBands}
                  exitRules={exitRules}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function DetailStat({
  label,
  value,
  sub,
  helper,
  valueCls,
}: {
  // Usually a plain string, but a few RS Pullback gate stats embed a
  // GateMark inline (e.g. "RS20 = diff ✓") — hence ReactNode.
  label: ReactNode;
  value: string;
  // Computation/formula breakdown — "how this number was derived."
  sub?: string;
  // "Why the system wants this" — one short teaching line, distinct from
  // sub above. Every stat in the RS Pullback expanded panel gets one.
  helper?: string;
  valueCls?: string;
}) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`font-mono text-sm ${valueCls ?? "text-foreground"}`}>{value}</div>
      {sub && <div className="text-[10px] text-muted-foreground">{sub}</div>}
      {helper && (
        <div className="mt-0.5 text-[10px] leading-snug text-muted-foreground/70">{helper}</div>
      )}
    </div>
  );
}

// Neutral pass/fail marker for hard gates — deliberately NOT colored.
// 50MA rising, RS20, and RS60 are gates: a candidate only reaches this
// panel having already cleared 50MA-rising (a universal pregate, see the
// excludedBySma50Rising* diagnostics), and only "Ready"/"Leading,
// extended" rows have cleared both RS windows — "In zone, lagging" rows
// explicitly fail at least one (that's the whole reason they're in that
// list, not a buy list). So this can genuinely render either glyph;
// coloring it green/red would still carry no MORE information than the
// glyph itself once it's per-window like this, and the constraint is
// explicit: don't color the gates.
function GateMark({ pass, label }: { pass: boolean; label: string }) {
  return (
    <span
      className="ml-1 inline-flex items-center text-[10px] text-muted-foreground"
      title={`${label}: ${pass ? "passed" : "failed"}`}
    >
      {pass ? "✓" : "✗"}
    </span>
  );
}

// Shared by RsPullbackRow and RsPullbackNearMissRow — same chart-fetch
// behavior for both, so a near-miss row's expanded panel is identical to
// a qualifying row's, not a lookalike reimplementation.
function useRsPullbackChart(
  symbol: string,
  expanded: boolean,
): { chartData: ChartPoint[] | null; chartLoading: boolean; chartError: string | null } {
  const [chartData, setChartData] = useState<ChartPoint[] | null>(null);
  const [chartLoading, setChartLoading] = useState(false);
  const [chartError, setChartError] = useState<string | null>(null);
  const fetchedSymbolRef = useRef<string | null>(null);

  useEffect(() => {
    if (!expanded) return;
    if (fetchedSymbolRef.current === symbol) return;
    fetchedSymbolRef.current = symbol;
    let cancelled = false;
    setChartLoading(true);
    setChartError(null);
    setChartData(null);
    (async () => {
      try {
        const res = await fetch(`/api/swings/screen/chart?symbol=${encodeURIComponent(symbol)}`, {
          cache: "no-store",
        });
        const json = (await res.json().catch(() => ({}))) as { data?: ChartPoint[]; error?: string };
        if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
        if (!cancelled) setChartData(json.data ?? []);
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Chart load failed";
        if (!cancelled) setChartError(msg);
        fetchedSymbolRef.current = null;
      } finally {
        setChartLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [expanded, symbol]);

  return { chartData, chartLoading, chartError };
}

function RsPullbackRow({
  candidate: c,
  onEnterTrade,
  onTrack,
  tracked,
  tracking,
  colorBands,
  exitRules,
}: {
  candidate: SwingCandidate;
  onEnterTrade: () => void;
  onTrack: () => void;
  tracked: boolean;
  tracking: boolean;
  colorBands: RsPullbackColorBands;
  exitRules: RsPullbackExitRules;
}) {
  const [expanded, setExpanded] = useState(false);
  const { chartData, chartLoading, chartError } = useRsPullbackChart(c.symbol, expanded);

  // rr.text stays from fmtRr (just formatting, "X.X:1") — the color
  // comes from rrBandCls/colorBands instead of fmtRr's own 3-tier cls,
  // which is a different scale used only by RrBadge on the other tabs.
  const rr = fmtRr(c.rr);
  const rrCls = rrBandCls(c.rr, colorBands);
  const extCls = extensionBandCls(c.extensionAdrDays, colorBands);
  const rs20Pass = (c.rs20 ?? 0) > 0;
  const rs60Pass = (c.rs60 ?? 0) > 0;
  // Target-window guard (see RsPullbackExitRules) — display only, never
  // touches the target/stop calculation or which list this row is in.
  const targetWindow = classifyTargetWindow(c, exitRules);
  const rrSuppressed = targetWindow.kind === "beyond" || targetWindow.kind === "at_resistance";
  const canEnter = canEnterRsPullback(c, exitRules);
  // Only meaningful when priceRefreshed — would this row show Enter if
  // not for the refresh flag? Decides whether the row needs the "moved
  // on refresh" explanation (it would otherwise show Enter) or can just
  // stay a plain Track like it always has (it wouldn't have shown Enter
  // either way, refreshed or not).
  const wouldEnterIfNotRefreshed = c.priceRefreshed && canEnterIgnoringRefresh(c, exitRules);

  return (
    <>
      <tr
        className="cursor-pointer border-b border-border/40 last:border-0 hover:bg-white/[0.02]"
        onClick={() => setExpanded((v) => !v)}
      >
        <td className="px-2 py-1.5 font-mono font-medium text-foreground">
          <span className="inline-flex items-center gap-1">
            <ChevronRight
              className={`h-3 w-3 shrink-0 text-muted-foreground transition-transform ${expanded ? "rotate-90" : ""}`}
            />
            {c.symbol}
            {c.priceRefreshed && (
              <span
                title="Price-only refresh — currentPrice/extension/target-distance/R:R/bucket are fresh, but SMA50/ATR14/target/stop are still from the last full run. Track only; re-run RS Pullback to authorize entry."
                className="cursor-help text-sky-400"
              >
                <RefreshCw className="h-2.5 w-2.5" />
              </span>
            )}
            {c.dataQualityDegraded && (
              <span
                title={`Enriched with incomplete data: ${(c.dataQualityIssues ?? []).join(", ") || "unknown issue"} — this candidate's sector or earnings check failed rather than returning a real answer.`}
                className="cursor-help text-amber-400"
              >
                ⚠
              </span>
            )}
          </span>
        </td>
        <td className="px-2 py-1.5 text-xs text-muted-foreground">{c.sector ?? "—"}</td>
        <td className="px-2 py-1.5 text-right font-mono">{fmtMoney(c.currentPrice)}</td>
        <td className={`px-2 py-1.5 text-right ${c.vsMA50 < 0 ? "text-rose-300" : "text-foreground"}`}>
          {fmtPct(c.vsMA50, 1)}
        </td>
        <td className="px-2 py-1.5 text-right">
          {c.adr20Pct !== null && c.adr20Pct !== undefined ? `${c.adr20Pct.toFixed(1)}%` : "—"}
        </td>
        <td className={`px-2 py-1.5 text-right font-mono font-semibold ${extCls}`}>
          {fmtSigned(c.extensionAdrDays, 2)}
        </td>
        <td className="px-2 py-1.5 text-right font-mono text-muted-foreground">
          {fmtSigned(c.rs20, 1)}
          <GateMark pass={rs20Pass} label="RS20 (beat SPY, 20 sessions)" />
        </td>
        <td className="px-2 py-1.5 text-right font-mono text-muted-foreground">
          {fmtSigned(c.rs60, 1)}
          <GateMark pass={rs60Pass} label="RS60 (beat SPY, 60 sessions)" />
        </td>
        <td className="px-2 py-1.5 text-center text-xs text-muted-foreground">
          {c.higherLowVsSpy === null || c.higherLowVsSpy === undefined ? "—" : c.higherLowVsSpy ? "Yes" : "No"}
        </td>
        <td className="px-2 py-1.5 text-right">{fmtMoney(c.entryPrice)}</td>
        <td className="px-2 py-1.5 text-right text-emerald-300" title={targetHelperText(exitRules)}>
          {fmtMoney(c.targetPrice)}
        </td>
        <td className="px-2 py-1.5 text-right text-rose-300">{fmtMoney(c.stopPrice)}</td>
        <td
          className={
            rrSuppressed
              ? "px-2 py-1.5 text-right text-[10px] font-normal text-amber-300/80"
              : `px-2 py-1.5 text-right font-semibold ${rrCls}`
          }
          title={rrHelperText(exitRules)}
        >
          {rrSuppressed ? targetWindowMessage(targetWindow) : rr.text}
        </td>
        <td className="px-2 py-1.5" onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center justify-end gap-1">
            {wouldEnterIfNotRefreshed && (
              <span className="text-[10px] text-sky-300" title="Extension/target/R:R are from a price refresh, not a full run — SMA50/ATR14/target/stop haven't been re-checked at this price. Re-run RS Pullback to authorize entry.">
                moved on refresh - re-run to enter
              </span>
            )}
            {canEnter && (
              <button
                type="button"
                onClick={onEnterTrade}
                className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-white/5 hover:text-foreground"
              >
                Enter
              </button>
            )}
            <button
              type="button"
              onClick={onTrack}
              disabled={tracked || tracking}
              className={`rounded border px-1.5 py-0.5 text-[10px] font-medium ${
                tracked
                  ? "cursor-default border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                  : "border-border text-muted-foreground hover:bg-white/5 hover:text-foreground"
              }`}
            >
              {tracked ? "Tracked" : "Track"}
            </button>
          </div>
        </td>
      </tr>
      {expanded && (
        <RsPullbackExpandedPanel
          c={c}
          colorBands={colorBands}
          exitRules={exitRules}
          chartData={chartData}
          chartLoading={chartLoading}
          chartError={chartError}
          colSpan={14}
        />
      )}
    </>
  );
}

// Shared by RsPullbackRow and RsPullbackNearMissRow — literally the same
// component, not a lookalike, so a near-miss row's expanded detail is
// identical to a qualifying row's, per spec ("the expanded panel and
// helper text should render the same as elsewhere"). colSpan differs
// between the two callers' column counts.
function RsPullbackExpandedPanel({
  c,
  colorBands,
  exitRules,
  chartData,
  chartLoading,
  chartError,
  colSpan,
}: {
  c: SwingCandidate;
  colorBands: RsPullbackColorBands;
  exitRules: RsPullbackExitRules;
  chartData: ChartPoint[] | null;
  chartLoading: boolean;
  chartError: string | null;
  colSpan: number;
}) {
  const rr = fmtRr(c.rr);
  const rrCls = rrBandCls(c.rr, colorBands);
  const extCls = extensionBandCls(c.extensionAdrDays, colorBands);
  const rs20Pass = (c.rs20 ?? 0) > 0;
  const rs60Pass = (c.rs60 ?? 0) > 0;
  const targetWindow = classifyTargetWindow(c, exitRules);
  const rrSuppressed = targetWindow.kind === "beyond" || targetWindow.kind === "at_resistance";
  // Was hardcoded true — valid only while every row reaching this panel
  // had already cleared 50MA-rising as a universal pregate. A near-miss
  // row can fail exactly this gate, so it's derived instead: true unless
  // THIS row is the near-miss row failing THIS gate.
  const sma50RisingPass = c.rsPullbackList !== "near_miss" || c.nearMissGate !== "sma50_rising";
  const riskPerShare = c.entryPrice - c.stopPrice;
  const rewardPerShare = c.targetPrice - c.entryPrice;
  const atrMultiple = c.atr14 && c.atr14 > 0 ? riskPerShare / c.atr14 : null;

  return (
    <tr className="border-b border-border/40 bg-background/40 last:border-0">
      <td colSpan={colSpan} className="px-3 py-3">
        <div className="grid gap-4 lg:grid-cols-[1fr_260px]">
          <div className="space-y-3">
            <div>
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Trend (underlying values behind the gates)
              </div>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <DetailStat
                  label="SMA20 (bars)"
                  value={fmtMoney(c.sma20 ?? null)}
                  helper="Short-term trend reference only — not part of any gate here."
                />
                <DetailStat
                  label="SMA50 (bars, used in calc)"
                  value={fmtMoney(c.sma50AtEntry ?? null)}
                  sub="Not the same as ma50 below — this is the number extensionAdrDays and the rising check both use."
                  helper="The line this setup pulls back to. Extension and the rising check are both measured off this number."
                />
                <DetailStat
                  label="SMA200 (Yahoo quote)"
                  value={fmtMoney(c.ma200)}
                  sub="Bars window doesn't reach 200 sessions back."
                  helper="Long-term trend context only — not part of any RS Pullback gate."
                />
                <DetailStat
                  label="ATR14 (bars)"
                  value={fmtMoney(c.atr14 ?? null)}
                  helper="Average daily dollar range — sizes the stop wide enough for this stock's normal noise instead of a flat percentage."
                />
                <DetailStat
                  label="Extension (ADR-days)"
                  value={fmtSigned(c.extensionAdrDays, 2)}
                  valueCls={extCls}
                  sub={extensionBandCaption(colorBands)}
                  helper="How far above the 50-day in units of this stock's own daily range. Buying a pullback means buying near the average, not far above it — and below the floor there's no room left for a stop above the trend line."
                />
              </div>
            </div>
            <div>
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                50MA slope (20-session rising check)
              </div>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                <DetailStat
                  label="SMA50, 20 sessions ago"
                  value={fmtMoney(c.sma50TwentySessionsAgo ?? null)}
                  helper="The baseline the rising check compares against."
                />
                <DetailStat
                  label="SMA50, today"
                  value={fmtMoney(c.sma50AtEntry ?? null)}
                  helper="Compared to 20 sessions ago to confirm the average is actually climbing."
                />
                <DetailStat
                  label={
                    <span className="inline-flex items-center">
                      Rising %
                      <GateMark pass={sma50RisingPass} label="50MA rising" />
                    </span>
                  }
                  value={fmtSigned(c.sma50RisingPct, 2) + "%"}
                  sub={
                    c.sma50AtEntry != null && c.sma50TwentySessionsAgo != null
                      ? `(${c.sma50AtEntry.toFixed(2)} − ${c.sma50TwentySessionsAgo.toFixed(2)}) / ${c.sma50TwentySessionsAgo.toFixed(2)} × 100`
                      : undefined
                  }
                  helper="The average itself must be rising, not just price above it. A bounce inside a downtrend has price above a falling 50-day. Hard gate — colored only when this is the row's near-miss reason."
                />
              </div>
            </div>
            <div>
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Relative strength (raw returns behind RS20 / RS60)
              </div>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <DetailStat
                  label={`${c.symbol} 20d return`}
                  value={fmtSigned(c.stockReturn20, 2) + "%"}
                  helper="This stock's own 20-session return — only meaningful compared to SPY's below."
                />
                <DetailStat
                  label="SPY 20d return"
                  value={fmtSigned(c.spyReturn20, 2) + "%"}
                  helper="The benchmark this stock has to beat to count as relative strength."
                />
                <DetailStat
                  label={
                    <span className="inline-flex items-center">
                      RS20 = diff
                      <GateMark pass={rs20Pass} label="RS20 (beat SPY, 20 sessions)" />
                    </span>
                  }
                  value={fmtSigned(c.rs20, 2)}
                  sub={
                    c.stockReturn20 != null && c.spyReturn20 != null
                      ? `${c.stockReturn20.toFixed(2)}% − ${c.spyReturn20.toFixed(2)}%`
                      : undefined
                  }
                  helper="Beating SPY over both windows means leadership that has persisted, not one hot month. Hard gate — not colored; the mark shows whether this window passed."
                />
                <DetailStat
                  label="Higher low vs SPY (30d)"
                  value={c.higherLowVsSpy === null || c.higherLowVsSpy === undefined ? "—" : c.higherLowVsSpy ? "Yes" : "No"}
                  helper="On days SPY fell, did this stock's pullback lows keep rising? Holding up on down days is harder to fake than outperforming on up days — shown for context, it never gates list membership."
                />
                <DetailStat
                  label={`${c.symbol} 60d return`}
                  value={fmtSigned(c.stockReturn60, 2) + "%"}
                  helper="This stock's own 60-session return — the longer window RS60 is built from."
                />
                <DetailStat
                  label="SPY 60d return"
                  value={fmtSigned(c.spyReturn60, 2) + "%"}
                  helper="The benchmark for the 60-session window."
                />
                <DetailStat
                  label={
                    <span className="inline-flex items-center">
                      RS60 = diff
                      <GateMark pass={rs60Pass} label="RS60 (beat SPY, 60 sessions)" />
                    </span>
                  }
                  value={fmtSigned(c.rs60, 2)}
                  sub={
                    c.stockReturn60 != null && c.spyReturn60 != null
                      ? `${c.stockReturn60.toFixed(2)}% − ${c.spyReturn60.toFixed(2)}%`
                      : undefined
                  }
                  helper="Beating SPY over the quarter too — paired with RS20, confirms the outperformance isn't a one-month blip. Hard gate — not colored."
                />
              </div>
            </div>
            <div>
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Trade levels
              </div>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <DetailStat
                  label="Entry"
                  value={fmtMoney(c.entryPrice)}
                  helper="Where the order would go in — today's reference price for the plan below."
                />
                <DetailStat
                  label="Target"
                  value={fmtMoney(c.targetPrice)}
                  sub={
                    targetWindow.kind !== "unknown"
                      ? `${targetWindow.adrDays.toFixed(1)} ADR-days from entry — reward ${fmtMoney(rewardPerShare)}/sh`
                      : `reward ${fmtMoney(rewardPerShare)}/sh`
                  }
                  helper={targetHelperText(exitRules)}
                />
                <DetailStat
                  label="Stop"
                  value={fmtMoney(c.stopPrice)}
                  sub={`risk ${fmtMoney(riskPerShare)}/sh${atrMultiple !== null ? ` (${atrMultiple.toFixed(2)}× ATR14)` : ""}`}
                  helper="Where the trade closes for a loss — defines the risk half of R:R, and the level that failing means the pullback thesis was wrong."
                />
                <DetailStat
                  label="R:R"
                  value={rrSuppressed ? targetWindowMessage(targetWindow) : rr.text}
                  valueCls={rrSuppressed ? "text-amber-300/80 text-xs font-normal" : rrCls}
                  sub={rrSuppressed ? undefined : rrBandCaption(colorBands)}
                  helper={rrHelperText(exitRules)}
                />
                <DetailStat
                  label="Earnings"
                  value={c.nextEarningsDate ?? "unknown"}
                  sub={c.daysToEarnings !== null ? `${c.daysToEarnings}d away` : undefined}
                  helper="An earnings date inside the hold period adds event risk this setup isn't designed to price in."
                />
              </div>
            </div>
          </div>
          <div>
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              6-month chart
            </div>
            <PriceChart candidate={c} data={chartData} loading={chartLoading} error={chartError} />
          </div>
        </div>
      </td>
    </tr>
  );
}

const NEAR_MISS_GATE_LABEL: Record<
  NonNullable<SwingCandidate["nearMissGate"]>,
  string
> = {
  sma50_rising: "50MA rising",
  rs20: "RS20",
  rs60: "RS60",
  adr_floor: "ADR% floor",
};

// sma50_rising/adr_floor pass at value >= threshold; rs20/rs60 pass at
// value > 0 (strict) — see lib/swing-screener.ts evaluateRsPullback.
function nearMissOperator(gate: NonNullable<SwingCandidate["nearMissGate"]>): string {
  return gate === "rs20" || gate === "rs60" ? ">" : "≥";
}

function nearMissUnit(gate: NonNullable<SwingCandidate["nearMissGate"]>): string {
  return gate === "sma50_rising" || gate === "adr_floor" ? "%" : "";
}

// A near-miss row is, by definition, failing — gap is always > 0. At 1
// decimal a real gap as small as 0.036 rounds to "0.0", which reads as
// "value equals threshold, but classified as failing" (the exact bug
// this accompanies). 2 decimals covers every gap seen in practice; the
// loop is a guarantee, not a guess — it escalates precision until a
// nonzero digit actually shows, so "0.0" (or "0.00") can never be
// printed next to a row this function is only ever called for.
function fmtGap(gap: number | null | undefined): string {
  if (gap === null || gap === undefined || !Number.isFinite(gap)) return "—";
  for (let digits = 2; digits <= 6; digits += 1) {
    const s = gap.toFixed(digits);
    if (Number(s) > 0) return s;
  }
  return gap.toFixed(6);
}

function nearMissTrendGlyph(trend: SwingCandidate["nearMissTrend"]): string {
  if (trend === "improving") return "▲ improving";
  if (trend === "deteriorating") return "▼ deteriorating";
  if (trend === "flat") return "flat";
  return "n/a";
}

function nearMissTrendCls(trend: SwingCandidate["nearMissTrend"]): string {
  if (trend === "improving") return "text-emerald-300";
  if (trend === "deteriorating") return "text-rose-300";
  return "text-muted-foreground";
}

// Near-miss watch tier — same expand/collapse + chart + expanded-panel
// treatment as RsPullbackRow (see useRsPullbackChart/RsPullbackExpandedPanel),
// but a different collapsed row: which gate failed, the gap to passing in
// that gate's own units, and 5-session direction of travel — no Enter
// button, since these are track-only per spec.
function RsPullbackNearMissRow({
  candidate: c,
  onTrack,
  tracked,
  tracking,
  colorBands,
  exitRules,
}: {
  candidate: SwingCandidate;
  onTrack: () => void;
  tracked: boolean;
  tracking: boolean;
  colorBands: RsPullbackColorBands;
  exitRules: RsPullbackExitRules;
}) {
  const [expanded, setExpanded] = useState(false);
  const { chartData, chartLoading, chartError } = useRsPullbackChart(c.symbol, expanded);

  const gate = c.nearMissGate ?? null;
  const gateLabel = gate ? NEAR_MISS_GATE_LABEL[gate] : "—";
  const unit = gate ? nearMissUnit(gate) : "";
  const op = gate ? nearMissOperator(gate) : "";
  const rrCls = rrBandCls(c.rr, colorBands);
  const extCls = extensionBandCls(c.extensionAdrDays, colorBands);
  const rr = fmtRr(c.rr);
  const targetWindow = classifyTargetWindow(c, exitRules);
  const rrSuppressed = targetWindow.kind === "beyond" || targetWindow.kind === "at_resistance";

  return (
    <>
      <tr
        className="cursor-pointer border-b border-border/40 last:border-0 hover:bg-white/[0.02]"
        onClick={() => setExpanded((v) => !v)}
      >
        <td className="px-2 py-1.5 font-mono font-medium text-foreground">
          <span className="inline-flex items-center gap-1">
            <ChevronRight
              className={`h-3 w-3 shrink-0 text-muted-foreground transition-transform ${expanded ? "rotate-90" : ""}`}
            />
            {c.symbol}
            {c.dataQualityDegraded && (
              <span
                title={`Built at the cache-only prefilter stage: ${(c.dataQualityIssues ?? []).join(", ") || "unknown issue"} — no live sector/earnings check for this track-only row.`}
                className="cursor-help text-amber-400"
              >
                ⚠
              </span>
            )}
          </span>
        </td>
        <td className="px-2 py-1.5 text-xs text-muted-foreground">{c.sector ?? "—"}</td>
        <td className="px-2 py-1.5 text-right font-mono">{fmtMoney(c.currentPrice)}</td>
        <td className="px-2 py-1.5 text-left text-xs text-muted-foreground">{gateLabel}</td>
        <td className="px-2 py-1.5 text-right font-mono text-rose-300">
          {fmtSigned(c.nearMissValue, 2)}
          {unit}
          <div className="text-[10px] font-sans text-muted-foreground">
            needs {op} {c.nearMissThreshold?.toFixed(2)}
            {unit}, gap {fmtGap(c.nearMissGap)} pts
          </div>
        </td>
        <td className="px-2 py-1.5 text-right font-mono text-muted-foreground">
          {c.nearMissValue5SessionsAgo !== null && c.nearMissValue5SessionsAgo !== undefined
            ? `${fmtSigned(c.nearMissValue5SessionsAgo, 2)}${unit}`
            : "n/a"}
        </td>
        <td className={`px-2 py-1.5 text-center text-xs ${nearMissTrendCls(c.nearMissTrend)}`}>
          {nearMissTrendGlyph(c.nearMissTrend)}
        </td>
        <td className={`px-2 py-1.5 text-right font-mono ${extCls}`}>
          {fmtSigned(c.extensionAdrDays, 2)}
        </td>
        <td
          className={
            rrSuppressed
              ? "px-2 py-1.5 text-right text-[10px] font-normal text-amber-300/80"
              : `px-2 py-1.5 text-right font-semibold ${rrCls}`
          }
          title={rrHelperText(exitRules)}
        >
          {rrSuppressed ? targetWindowMessage(targetWindow) : rr.text}
        </td>
        <td className="px-2 py-1.5" onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center justify-end gap-1">
            <button
              type="button"
              onClick={onTrack}
              disabled={tracked || tracking}
              className={`rounded border px-1.5 py-0.5 text-[10px] font-medium ${
                tracked
                  ? "cursor-default border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                  : "border-border text-muted-foreground hover:bg-white/5 hover:text-foreground"
              }`}
            >
              {tracked ? "Tracked" : "Track"}
            </button>
          </div>
        </td>
      </tr>
      {expanded && (
        <RsPullbackExpandedPanel
          c={c}
          colorBands={colorBands}
          exitRules={exitRules}
          chartData={chartData}
          chartLoading={chartLoading}
          chartError={chartError}
          colSpan={10}
        />
      )}
    </>
  );
}

function RsPullbackNearMissSection({
  candidates,
  onTrack,
  trackedSymbols,
  trackingSymbol,
  colorBands,
  exitRules,
}: {
  candidates: SwingCandidate[];
  onTrack: (c: SwingCandidate) => void;
  trackedSymbols: Set<string>;
  trackingSymbol: string | null;
  colorBands: RsPullbackColorBands;
  exitRules: RsPullbackExitRules;
}) {
  // Already sorted ascending by gap in the rsPullbackLists useMemo — no
  // interactive re-sort here, per spec ("sort the list by smallest gap
  // first"), unlike the other three lists' click-to-sort headers.
  return (
    <div className="space-y-2">
      <div>
        <div className="flex items-baseline gap-2">
          <h3 className="text-sm font-semibold text-foreground">Watch, near miss</h3>
          <span className="text-xs text-muted-foreground">({candidates.length})</span>
        </div>
        <div className="text-xs text-muted-foreground">
          Fails exactly one gate — sorted closest-to-passing first. Track only, not actionable.
        </div>
      </div>
      {candidates.length === 0 ? (
        <div className="rounded border border-border/60 bg-background/30 px-3 py-2 text-xs text-muted-foreground">
          Nothing is currently one gate away from qualifying.
        </div>
      ) : (
        <div className="overflow-x-auto rounded border border-border">
          <table className="w-full min-w-[860px] text-sm">
            <thead className="border-b border-border/60 text-left text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-2 py-1.5 text-left">Symbol</th>
                <th className="px-2 py-1.5 text-left">Sector</th>
                <th className="px-2 py-1.5 text-right">Price</th>
                <th className="px-2 py-1.5 text-left">Failed gate</th>
                <th className="px-2 py-1.5 text-right">Value (gap)</th>
                <th className="px-2 py-1.5 text-right">5 sessions ago</th>
                <th className="px-2 py-1.5 text-center">Trend</th>
                <th className="px-2 py-1.5 text-right">Ext (ADR-days)</th>
                <th className="px-2 py-1.5 text-right" title={rrHelperText(exitRules)}>
                  R:R
                </th>
                <th className="px-2 py-1.5 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {candidates.map((c) => (
                <RsPullbackNearMissRow
                  key={c.symbol}
                  candidate={c}
                  onTrack={() => onTrack(c)}
                  tracked={trackedSymbols.has(c.symbol)}
                  tracking={trackingSymbol === c.symbol}
                  colorBands={colorBands}
                  exitRules={exitRules}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
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
        {/* ADR% — hidden mobile, display + filter only, not a score input */}
        <div className="hidden text-right font-mono text-foreground md:block">
          {c.adr20Pct !== null && c.adr20Pct !== undefined ? `${c.adr20Pct.toFixed(1)}%` : "—"}
        </div>
        {/* Sector — hidden mobile */}
        <div className="hidden truncate text-left text-[11px] text-muted-foreground md:block">
          {c.sector ?? "—"}
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
          activeTab={activeTab}
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
  activeTab,
  chartData,
  chartLoading,
  chartError,
}: {
  candidate: SwingCandidate;
  activeTab: SetupTab;
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
              value={`${fmtMoney(c.stopPrice)} (${fmtPct(stopPct, 1)})`}
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

      <NarrativeCard candidate={c} activeTab={activeTab} />
      <ScoreBreakdown candidate={c} activeTab={activeTab} />
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
    "across all insiders in the last 90 days.\n\n" +
    "Multiple insiders buying simultaneously is a stronger signal than one " +
    "person buying.";
  return (
    <DetailSection
      title="Insider activity (last 90 days)"
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

// Analyst-style plain-language read — rendered verbatim from
// c.tabNarrative[activeTab], built server-side (lib/swing-screener.ts
// buildNarrative) from the exact same components ScoreBreakdown below
// renders, so the prose and the numbers can't disagree. Sections are
// blank-line-separated "LABEL: text" blocks (STRENGTH/CAUTION/
// CONFIRMATION/TRADE GEOMETRY/BOTTOM LINE), mirroring the CSP
// screener's STRENGTH/CAUTION/NEWS/HISTORY/BOTTOM LINE format.
function NarrativeCard({
  candidate: c,
  activeTab,
}: {
  candidate: SwingCandidate;
  activeTab: SetupTab;
}) {
  const text = c.tabNarrative?.[activeTab];
  if (!text) {
    return (
      <div className="rounded border border-border/50 bg-white/[0.02] p-3 text-[11px] text-muted-foreground">
        No narrative available — this row was saved before the analyst-read redesign.
      </div>
    );
  }
  const blocks = text.split("\n\n");
  return (
    <div className="space-y-2 rounded border border-border/50 bg-white/[0.02] p-3 text-[12px] leading-relaxed">
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        Analyst read
      </div>
      {blocks.map((block, i) => {
        const m = block.match(/^([A-Z /]+):\s*([\s\S]*)$/);
        if (!m) {
          return (
            <p key={i} className="text-foreground/90">
              {block}
            </p>
          );
        }
        const [, label, body] = m;
        const cls =
          label === "STRENGTH"
            ? "text-emerald-300"
            : label === "CAUTION"
              ? "text-amber-300"
              : label === "BOTTOM LINE"
                ? "text-foreground"
                : "text-sky-300";
        return (
          <p key={i}>
            <span className={`font-semibold ${cls}`}>{label}: </span>
            <span className="text-foreground/90">{body}</span>
          </p>
        );
      })}
    </div>
  );
}

// Setup score breakdown — renders c.tabScoreComponents[activeTab]
// verbatim (computed server-side, see lib/swing-screener.ts
// ScoreComponent/finalizeScore). The badge, this breakdown, and the
// narrative above all come from the same list, so they always sum and
// agree with each other by construction, not by convention.
function ScoreBreakdown({
  candidate: c,
  activeTab,
}: {
  candidate: SwingCandidate;
  activeTab: SetupTab;
}) {
  const score = c.tabScores?.[activeTab] ?? c.setupScore;
  const components = c.tabScoreComponents?.[activeTab];
  const filled = Math.max(0, Math.min(10, score));
  if (!components) {
    return (
      <div className="rounded border border-border/50 bg-white/[0.02] p-3 text-[11px] text-muted-foreground">
        No score breakdown available — this row was saved before the analyst-read redesign.
      </div>
    );
  }
  return (
    <div className="rounded border border-border/50 bg-white/[0.02] p-3">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          {TAB_LABEL[activeTab]} score
        </span>
        <span className="font-mono text-base text-foreground">{score}/10</span>
        <span className="ml-2 font-mono text-sm tracking-tighter text-muted-foreground">
          {"━".repeat(filled)}
          <span className="text-muted-foreground/40">{"░".repeat(10 - filled)}</span>
        </span>
      </div>
      <div className="grid grid-cols-1 gap-1 text-[11px] md:grid-cols-2">
        {components.map((comp, i) => {
          const negative = comp.points < 0;
          const ok = comp.points > 0;
          const partial = comp.points > 0 && comp.maxPoints > 0 && comp.points < comp.maxPoints;
          const icon = negative ? "−" : ok ? (partial ? "⚠" : "✓") : "✗";
          const cls = negative
            ? "text-rose-300"
            : ok
              ? partial
                ? "text-amber-300"
                : "text-emerald-300"
              : "text-muted-foreground";
          return (
            <div key={comp.key ?? i} className="flex items-start gap-2">
              <span className={`mt-0.5 w-3 shrink-0 ${cls}`}>{icon}</span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-foreground/90">{comp.label}</span>
                  <span className={`font-mono ${cls}`}>
                    <Tipped content={`${comp.value}\n\n${comp.detail}`}>
                      {comp.points >= 0 ? "+" : ""}
                      {comp.points}
                      {comp.maxPoints > 0 ? `/${comp.maxPoints}` : ""}
                    </Tipped>
                  </span>
                </div>
                <div className="text-[10px] text-muted-foreground">{comp.value}</div>
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

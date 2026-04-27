"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  CalendarClock,
  ChevronDown,
  ChevronRight,
  Loader2,
  RefreshCw,
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
        className="max-w-sm whitespace-pre-line text-xs leading-relaxed"
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
  unusualOptionsActivity: boolean;
  callVolumeOiRatio: number | null;
  optionsSignal: "bullish" | "neutral" | "bearish";
  topOptionsStrike: number | null;
  topOptionsExpiry: string | null;
  tier1Signals: string[];
  tier2Signals: string[];
  redFlags: string[];
  signalCount: number;
  setupScore: number;
};

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

type SortKey =
  | "setupScore"
  | "rr"
  | "pctFromHigh"
  | "vsMA50"
  | "signalCount"
  | "currentPrice"
  | "priceChange1d";

type SortDir = "asc" | "desc";
type SortState = { key: SortKey; dir: SortDir };

const DEFAULT_SORT: SortState = { key: "setupScore", dir: "desc" };

// 10-column desktop grid + 5-column mobile grid. Mobile-only cells
// get `hidden md:block`/`hidden md:flex` to drop out of the grid.
const ROW_GRID =
  "grid w-full items-center gap-2 px-3 grid-cols-[minmax(60px,1fr)_70px_60px_60px_minmax(80px,1fr)] md:grid-cols-[minmax(60px,80px)_minmax(120px,1.5fr)_80px_70px_80px_80px_70px_70px_minmax(120px,1fr)_130px]";

function fmtMoney(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return `$${n.toFixed(digits)}`;
}

function fmtPct(n: number | null | undefined, digits = 1): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${(n * 100).toFixed(digits)}%`;
}

function fmtRr(rr: number | null): { text: string; cls: string } {
  if (rr === null || !Number.isFinite(rr)) {
    return { text: "—", cls: "text-muted-foreground" };
  }
  const cls =
    rr >= 3 ? "text-emerald-300" : rr >= 2 ? "text-amber-300" : "text-rose-300";
  return { text: `${rr.toFixed(1)}:1`, cls };
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

function compareCandidates(
  a: SwingCandidate,
  b: SwingCandidate,
  sort: SortState,
): number {
  const dir = sort.dir === "asc" ? 1 : -1;
  switch (sort.key) {
    case "setupScore":
      return dir * (a.setupScore - b.setupScore);
    case "rr":
      return dir * ((a.rr ?? -Infinity) - (b.rr ?? -Infinity));
    case "pctFromHigh":
      return dir * (a.pctFromHigh - b.pctFromHigh);
    case "vsMA50":
      return dir * (a.vsMA50 - b.vsMA50);
    case "signalCount":
      return dir * (a.signalCount - b.signalCount);
    case "currentPrice":
      return dir * (a.currentPrice - b.currentPrice);
    case "priceChange1d":
      return dir * (a.priceChange1d - b.priceChange1d);
  }
}

function sortCandidates(
  list: SwingCandidate[],
  sort: SortState,
): SwingCandidate[] {
  return [...list].sort((a, b) => {
    const primary = compareCandidates(a, b, sort);
    if (primary !== 0) return primary;
    // Stable-ish tiebreaker so re-sorts don't churn order on ties.
    return a.symbol.localeCompare(b.symbol);
  });
}

type RunPhase = "idle" | "pass1" | "pass2" | "saving";

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
  const [sort, setSort] = useState<SortState>(DEFAULT_SORT);
  const [importOpen, setImportOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const running = phase !== "idle";

  async function loadCached() {
    try {
      const res = await fetch("/api/swings/screen", { cache: "no-store" });
      const json = (await res.json()) as CachedResult & { error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setData(json);
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
    setPass1Count(null);
    const started = Date.now();
    try {
      // Pass 1 — Yahoo technical filter on the full universe (~15-25s).
      setPhase("pass1");
      const r1 = await fetch("/api/swings/screen/pass1", {
        method: "POST",
        cache: "no-store",
      });
      const p1 = (await r1.json()) as Pass1Wire & { error?: string };
      if (!r1.ok) throw new Error(p1.error ?? `Pass 1 failed: HTTP ${r1.status}`);
      setPass1Count(p1.survivors.length);

      // Pass 2 — Finnhub insider + earnings + Schwab options on survivors
      // (~25-45s). The full pass1 wire payload is the body — pass2 needs
      // quotes/trades/tier2 to build the candidates.
      setPhase("pass2");
      const r2 = await fetch("/api/swings/screen/pass2", {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(p1),
      });
      const p2 = (await r2.json()) as {
        candidates?: SwingCandidate[];
        durationMs?: number;
        error?: string;
      };
      if (!r2.ok) throw new Error(p2.error ?? `Pass 2 failed: HTTP ${r2.status}`);
      const candidates = p2.candidates ?? [];

      const result: CachedResult = {
        candidates,
        screened: p1.screened,
        pass1Survivors: p1.survivors.length,
        pass2Results: candidates.length,
        durationMs: Date.now() - started,
        errors: p1.errors ?? [],
        screenedAt: new Date().toISOString(),
      };

      // Save — fast (<1s). Failure here doesn't lose the visible result;
      // the user just won't see it on next refresh.
      setPhase("saving");
      const rs = await fetch("/api/swings/screen/save", {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          candidates: result.candidates,
          screened: result.screened,
          pass1Survivors: result.pass1Survivors,
          pass2Results: result.pass2Results,
          durationMs: result.durationMs,
        }),
      });
      if (!rs.ok) {
        const j = (await rs.json().catch(() => ({}))) as { error?: string };
        console.warn("[swing-screen] save failed:", j.error ?? rs.status);
      }

      setData(result);
    } catch (e) {
      setRunError(e instanceof Error ? e.message : "Screen failed");
    } finally {
      setPhase("idle");
      setPass1Count(null);
    }
  }

  const sortedCandidates = useMemo(
    () => sortCandidates(data?.candidates ?? [], sort),
    [data, sort],
  );

  function handleHeaderClick(key: SortKey) {
    setSort((cur) => {
      if (cur.key !== key) {
        // Default per-column dir: setupScore/rr/signalCount/chg high-first,
        // pctFromHigh/vsMA50 low-first (most beaten-down first).
        const desc =
          key === "setupScore" ||
          key === "rr" ||
          key === "signalCount" ||
          key === "priceChange1d" ||
          key === "currentPrice";
        return { key, dir: desc ? "desc" : "asc" };
      }
      return { key, dir: cur.dir === "asc" ? "desc" : "asc" };
    });
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
        <div className="rounded border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-300">
          {runError}
        </div>
      )}
      {toast && (
        <div className="rounded border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm text-emerald-300">
          {toast}
        </div>
      )}

      {loading ? (
        <div className="rounded border border-border bg-background/40 p-6 text-sm text-muted-foreground">
          Loading cached screen…
        </div>
      ) : !data || data.screenedAt === null ? (
        <EmptyStateNoScan />
      ) : sortedCandidates.length === 0 ? (
        <EmptyStateNoResults data={data} />
      ) : (
        <ResultsTable
          candidates={sortedCandidates}
          sort={sort}
          onSort={handleHeaderClick}
          onEnterTrade={() => setImportOpen(true)}
        />
      )}

      <ImportStockScreenshotModal
        open={importOpen}
        onOpenChange={setImportOpen}
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
        <div className="text-xs text-muted-foreground">
          Last screened:{" "}
          <span className="text-foreground">{fmtRelDate(data?.screenedAt ?? null)}</span>
        </div>
        {data && data.screenedAt !== null && (
          <div className="text-xs text-muted-foreground">
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
        className="inline-flex items-center gap-2 rounded-md border border-border bg-emerald-500/10 px-3 py-1.5 text-sm font-medium text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-50"
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
          "Pulling Finnhub insider transactions + earnings dates and Schwab options flow. ~25-45 seconds.",
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
    <div className="flex items-start gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-200">
      <RefreshCw className="mt-0.5 h-4 w-4 animate-spin shrink-0" />
      <div className="space-y-1">
        <div className="font-medium">{title}</div>
        {detail && <div className="text-xs text-amber-200/80">{detail}</div>}
      </div>
    </div>
  );
}

function EmptyStateNoScan() {
  return (
    <div className="rounded-md border border-dashed border-border bg-background/40 p-10 text-center">
      <div className="text-lg font-medium">No screens run yet</div>
      <p className="mx-auto mt-2 max-w-xl text-sm text-muted-foreground">
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
      <p className="mx-auto mt-2 max-w-xl text-sm text-muted-foreground">
        Market conditions don&rsquo;t favor swing setups right now. Try again
        tomorrow.
      </p>
      <p className="mx-auto mt-3 text-xs text-muted-foreground">
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
  onSort,
  onEnterTrade,
}: {
  candidates: SwingCandidate[];
  sort: SortState;
  onSort: (key: SortKey) => void;
  onEnterTrade: () => void;
}) {
  return (
    <div className="space-y-1">
      <TableHeader sort={sort} onSort={onSort} />
      <div className="space-y-1">
        {candidates.map((c) => (
          <CandidateRow
            key={c.symbol}
            candidate={c}
            onEnterTrade={onEnterTrade}
          />
        ))}
      </div>
    </div>
  );
}

function TableHeader({
  sort,
  onSort,
}: {
  sort: SortState;
  onSort: (key: SortKey) => void;
}) {
  return (
    <div
      className={`${ROW_GRID} border-b border-border/60 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground`}
    >
      <SortHeader label="Symbol" />
      <SortHeader label="Company" className="hidden md:block" />
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
        label="From High"
        sortKey="pctFromHigh"
        sort={sort}
        onSort={onSort}
        align="right"
        className="hidden md:block"
        tooltip={
          "How far below the 52-week high.\n" +
          "Formula: (Price − 52w High) / 52w High\n\n" +
          "Best swing setups: −20% to −60%.\n" +
          "Too little = no room to recover.\n" +
          "Too much = may be fundamentally broken."
        }
      />
      <SortHeader
        label="vs 50MA"
        sortKey="vsMA50"
        sort={sort}
        onSort={onSort}
        align="right"
        className="hidden md:block"
        tooltip={
          "% difference from the 50-day moving average.\n" +
          "Formula: (Price − 50d MA) / 50d MA\n\n" +
          "Below 0% = price in downtrend.\n" +
          "Above 0% = price in uptrend.\n" +
          "Near 0% = potential momentum shift."
        }
      />
      <SortHeader
        label="R/R"
        sortKey="rr"
        sort={sort}
        onSort={onSort}
        align="right"
        className="hidden md:block"
        tooltip={
          "Risk/Reward ratio.\n" +
          "Formula: (Target − Entry) / (Entry − Stop)\n\n" +
          "Minimum useful threshold: 2.0:1\n" +
          "At 2:1 you need to be right 34% of the time to be profitable long-term.\n" +
          "At 5:1 you only need to be right 17%."
        }
      />
      <SortHeader
        label="Score"
        sortKey="setupScore"
        sort={sort}
        onSort={onSort}
        align="center"
        tooltip={
          "Setup score out of 10.\n\n" +
          "+2 open-market insider purchase >$100K\n" +
          "+2 earnings 14–45 days + stock >15% below target\n" +
          "+1 unusual options activity (vol/OI >0.5x)\n" +
          "+1 volume spike (>2× average, price up)\n" +
          "+1 R/R ≥ 3.0:1\n" +
          "+1 short float >15%\n" +
          "+1 within 2% of 50d MA\n\n" +
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
  onEnterTrade,
}: {
  candidate: SwingCandidate;
  onEnterTrade: () => void;
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
  const rr = fmtRr(c.rr);
  const fromHighCls =
    c.pctFromHigh < -0.3
      ? "text-rose-300"
      : c.pctFromHigh < -0.15
        ? "text-amber-300"
        : "text-foreground";
  const vsMaCls =
    Math.abs(c.vsMA50) <= 0.02
      ? "text-emerald-300"
      : c.vsMA50 < 0
        ? "text-rose-300"
        : "text-foreground";

  return (
    <div className="overflow-hidden rounded-md border border-border bg-background/30">
      <div className={`${ROW_GRID} pt-2 text-xs`}>
        {/* 1. Symbol */}
        <div className="truncate text-left font-mono text-sm font-semibold text-foreground">
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
        {/* 5. From High */}
        <div className={`hidden text-right md:block ${fromHighCls}`}>
          {fmtPct(c.pctFromHigh, 0)}
        </div>
        {/* 6. vs 50MA */}
        <div className={`hidden text-right md:block ${vsMaCls}`}>
          {fmtPct(c.vsMA50, 1)}
        </div>
        {/* 7. R/R */}
        <div className={`hidden text-right md:block ${rr.cls}`}>{rr.text}</div>
        {/* 8. Score */}
        <div className="flex justify-center">
          <ScoreBadge score={c.setupScore} />
        </div>
        {/* 9. Signals */}
        <div className="hidden flex-wrap justify-start gap-1 md:flex">
          <SignalBadges tier1={c.tier1Signals} insiderSignal={c.insiderSignal} />
        </div>
        {/* 10. Actions */}
        <div
          className="flex items-center justify-end gap-1"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            onClick={onEnterTrade}
            className="inline-flex items-center gap-1 rounded border border-border bg-white/5 px-1.5 py-0.5 text-[10px] font-medium text-foreground hover:bg-white/10"
            title="Import broker screenshot to log this trade"
          >
            <Upload className="h-3 w-3" />
            Enter
          </button>
        </div>
      </div>
      <Line2
        candidate={c}
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
}: {
  tier1: string[];
  insiderSignal: SwingCandidate["insiderSignal"];
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
      {tier1.includes("EARNINGS_CATALYST") && (
        <span
          className="inline-flex items-center gap-1 rounded border border-blue-500/40 bg-blue-500/10 px-1 py-0.5 text-[9px] font-medium text-blue-300"
          title="Earnings catalyst within 14-45 days with upside to target"
        >
          <CalendarClock className="h-3 w-3" />
          EARNINGS
        </span>
      )}
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

function tier1Label(sig: string): string {
  if (sig === "INSIDER_BUYING") return "INSIDER BUYING";
  if (sig === "UNUSUAL_OPTIONS") return "UNUSUAL OPTIONS";
  if (sig === "EARNINGS_CATALYST") return "EARNINGS CATALYST";
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

function Line2({
  candidate: c,
  expanded,
  onToggle,
}: {
  candidate: SwingCandidate;
  expanded: boolean;
  onToggle: () => void;
}) {
  const tier1Text = c.tier1Signals.map(tier1Label).join(" · ");
  const tradeTooltip =
    `Entry:  ${fmtMoney(c.entryPrice)} (current price)\n` +
    `Target: ${fmtMoney(c.targetPrice)}\n` +
    `  = lower of analyst mean (${fmtMoney(c.analystTarget)})\n` +
    `    and 60% recovery to 52w high\n` +
    `Stop:   ${fmtMoney(c.stopPrice)}\n` +
    `  = 3% below 52w low (${fmtMoney(c.week52Low)})\n\n` +
    `R/R = (${fmtMoney(c.targetPrice)} − ${fmtMoney(c.entryPrice)}) / ` +
    `(${fmtMoney(c.entryPrice)} − ${fmtMoney(c.stopPrice)}) = ${(c.rr ?? 0).toFixed(2)}:1`;
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
      className="flex cursor-pointer items-start gap-2 px-3 pb-2 pt-1 text-sm text-muted-foreground hover:bg-white/[0.02]"
    >
      <span className="flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground/70">
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5" />
        )}
      </span>
      <div className="min-w-0 flex-1 line-clamp-2">
        <span className="text-foreground/90">📡 {tier1Text || "No tier-1 signals"}</span>
        {c.tier2Signals.length > 0 && (
          <>
            <span className="px-1.5 text-muted-foreground/60">·</span>
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
          </>
        )}
        <span className="px-1.5 text-muted-foreground/60">|</span>
        <Tipped content={tradeTooltip}>
          Entry {fmtMoney(c.entryPrice)} → Target {fmtMoney(c.targetPrice)} →
          Stop {fmtMoney(c.stopPrice)}
        </Tipped>
        {c.redFlags.length > 0 && (
          <>
            <span className="px-1.5 text-muted-foreground/60">|</span>
            <AlertTriangle className="mr-1 inline h-3 w-3 align-text-bottom text-amber-400" />
            <span>{c.redFlags.join(" · ")}</span>
          </>
        )}
      </div>
    </div>
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
    <div className="space-y-3 border-t border-border/60 bg-background/40 px-3 py-3 text-xs">
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

function EarningsAndShortSection({ candidate: c }: { candidate: SwingCandidate }) {
  const earningsTone =
    c.daysToEarnings === null
      ? undefined
      : c.daysToEarnings < 14
        ? "bad"
        : c.daysToEarnings < 30
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
      : `Source: Finnhub earnings calendar.\n\n${c.daysToEarnings} days away.\n\n` +
        `Screener targets 14–45 days — close enough to be a near-term ` +
        `catalyst, far enough to enter before the crowd.\n\n` +
        `<7 days = too close (disqualified)\n` +
        `7–14 days = risky (earnings imminent)\n` +
        `14–45 days = ideal window ✅\n` +
        `>45 days = catalyst too far out`;
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

  // ---- Earnings ----
  const earningsHit =
    c.daysToEarnings !== null && c.daysToEarnings >= 14 && c.daysToEarnings <= 45;
  const upsidePct =
    c.analystTarget !== null && c.currentPrice > 0
      ? (c.analystTarget - c.currentPrice) / c.currentPrice
      : null;
  const upsideText =
    upsidePct !== null
      ? `${(Math.abs(upsidePct) * 100).toFixed(0)}% ${upsidePct >= 0 ? "below" : "above"} analyst target`
      : "no analyst target";
  out.push({
    label: "Earnings catalyst window",
    earned: earningsHit ? 2 : 0,
    max: 2,
    detail:
      c.daysToEarnings === null
        ? "No upcoming earnings date"
        : earningsHit
          ? `${c.daysToEarnings} days to earnings (${fmtCalendarDate(c.nextEarningsDate)}) · ${upsideText}`
          : `Earnings ${c.daysToEarnings} days away — outside 14-45 day window`,
    tooltip: earningsHit
      ? `Earnings in ${c.daysToEarnings} days (${fmtCalendarDate(c.nextEarningsDate)}).\n` +
        `Analyst target: ${fmtMoney(c.analystTarget)}\n` +
        `Current price: ${fmtMoney(c.currentPrice)}\n` +
        `Gap to target: ${upsideText}\n\n` +
        `Stock is in the 14-45 day window with analyst upside — catalyst for ` +
        `repricing if they beat.`
      : c.daysToEarnings === null
        ? "No earnings date found in next 120 days."
        : c.daysToEarnings < 14
          ? `Earnings in ${c.daysToEarnings} days — too close (>14 days required).`
          : `Earnings in ${c.daysToEarnings} days — too far out (<45 days required).`,
  });

  // ---- Unusual options ----
  out.push({
    label: "Unusual call activity",
    earned: c.unusualOptionsActivity ? 1 : 0,
    max: 1,
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

  // ---- R/R bonus ----
  const rrHit = (c.rr ?? 0) >= 3.0;
  const levels = `entry ${fmtMoney(c.entryPrice)} → target ${fmtMoney(c.targetPrice)} → stop ${fmtMoney(c.stopPrice)}`;
  const rewardPct = c.entryPrice > 0 ? ((c.targetPrice - c.entryPrice) / c.entryPrice) * 100 : 0;
  const riskPct = c.entryPrice > 0 ? ((c.entryPrice - c.stopPrice) / c.entryPrice) * 100 : 0;
  out.push({
    label: "R/R bonus (≥3:1)",
    earned: rrHit ? 1 : 0,
    max: 1,
    detail: rrHit
      ? `${(c.rr ?? 0).toFixed(2)}:1 ratio · ${levels}`
      : `${(c.rr ?? 0).toFixed(2)}:1 ratio · ${levels} — meets 2:1 minimum, below 3:1 ideal`,
    tooltip:
      `Entry:  ${fmtMoney(c.entryPrice)}\n` +
      `Target: ${fmtMoney(c.targetPrice)} (+${rewardPct.toFixed(1)}%)\n` +
      `Stop:   ${fmtMoney(c.stopPrice)}  (−${riskPct.toFixed(1)}%)\n` +
      `R/R = ${(c.rr ?? 0).toFixed(2)}:1\n\n` +
      `Threshold for point: ≥3.0:1\n` +
      (rrHit ? "✅ Qualifies" : "✗ Below 3.0 — still a valid setup at 2:1+"),
  });

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
        <span className="font-mono text-sm text-foreground">{c.setupScore}/10</span>
        <span className="ml-2 font-mono text-xs tracking-tighter text-muted-foreground">
          {"━".repeat(filled)}
          <span className="text-muted-foreground/40">{"░".repeat(10 - filled)}</span>
        </span>
      </div>
      <div className="grid grid-cols-1 gap-1 text-[11px] md:grid-cols-2">
        {components.map((comp, i) => {
          const ok = comp.earned > 0;
          const partial = comp.earned > 0 && comp.earned < comp.max;
          const icon = ok ? (partial ? "⚠" : "✓") : "✗";
          const cls = ok
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

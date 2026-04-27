"use client";

import { useEffect, useMemo, useState } from "react";
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
      />
      <SortHeader
        label="vs 50MA"
        sortKey="vsMA50"
        sort={sort}
        onSort={onSort}
        align="right"
        className="hidden md:block"
      />
      <SortHeader
        label="R/R"
        sortKey="rr"
        sort={sort}
        onSort={onSort}
        align="right"
        className="hidden md:block"
      />
      <SortHeader
        label="Score"
        sortKey="setupScore"
        sort={sort}
        onSort={onSort}
        align="center"
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
}: {
  label: string;
  sortKey?: SortKey;
  sort?: SortState;
  onSort?: (k: SortKey) => void;
  className?: string;
  align?: "left" | "right" | "center";
}) {
  const justify =
    align === "right"
      ? "justify-end"
      : align === "center"
        ? "justify-center"
        : "justify-start";
  if (!sortKey || !sort || !onSort) {
    return (
      <div className={`flex items-center gap-1 ${justify} ${className}`}>
        <span>{label}</span>
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
      <span>{label}</span>
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
      {expanded && <ExpandedDetail candidate={c} />}
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
  const tier2Text = c.tier2Signals.map(tier2Label).join(" · ");
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
        {tier2Text && (
          <>
            <span className="px-1.5 text-muted-foreground/60">·</span>
            <span>{tier2Text}</span>
          </>
        )}
        <span className="px-1.5 text-muted-foreground/60">|</span>
        <span>
          Entry {fmtMoney(c.entryPrice)} → Target {fmtMoney(c.targetPrice)} →
          Stop {fmtMoney(c.stopPrice)}
        </span>
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

function ExpandedDetail({ candidate: c }: { candidate: SwingCandidate }) {
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
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded border border-border/50 bg-white/[0.02] p-2">
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </div>
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}

function DetailRow({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "good" | "warn" | "bad";
}) {
  const cls =
    tone === "good"
      ? "text-emerald-300"
      : tone === "warn"
        ? "text-amber-300"
        : tone === "bad"
          ? "text-rose-300"
          : "text-foreground";
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span className={`font-mono ${cls}`}>{value}</span>
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
  return (
    <DetailSection title="Insider activity (last 45 days)">
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
                  <th className="px-1.5 py-1 text-right font-medium">$ Value</th>
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
  return (
    <DetailSection title="Options flow">
      {c.unusualOptionsActivity ? (
        <>
          <DetailRow label="Signal" value="BULLISH (unusual call activity)" tone="good" />
          <DetailRow
            label="Top strike"
            value={c.topOptionsStrike !== null ? `$${c.topOptionsStrike.toFixed(0)} (OTM)` : "—"}
          />
          <DetailRow
            label="Vol / OI ratio"
            value={c.callVolumeOiRatio !== null ? `${c.callVolumeOiRatio.toFixed(2)}x` : "—"}
          />
        </>
      ) : c.callVolumeOiRatio !== null ? (
        <>
          <DetailRow label="Signal" value="NEUTRAL" />
          <DetailRow
            label="Top strike"
            value={c.topOptionsStrike !== null ? `$${c.topOptionsStrike.toFixed(0)}` : "—"}
          />
          <DetailRow
            label="Vol / OI ratio"
            value={`${c.callVolumeOiRatio.toFixed(2)}x (below 0.5x threshold)`}
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
      />
      <DetailRow
        label="Short float"
        value={
          c.shortPercentFloat !== null
            ? `${(c.shortPercentFloat * 100).toFixed(1)}%${c.shortPercentFloat > 0.15 ? " — squeeze possible" : ""}`
            : "—"
        }
        tone={shortTone}
      />
      {c.revenueGrowth !== null && (
        <DetailRow
          label="Revenue growth (YoY)"
          value={fmtPct(c.revenueGrowth, 1)}
          tone={c.revenueGrowth > 0.15 ? "good" : c.revenueGrowth >= 0.05 ? "warn" : "bad"}
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
};

function computeScoreBreakdown(c: SwingCandidate): ScoreComponent[] {
  const out: ScoreComponent[] = [];

  // Insider buying — engine considers only open-market purchases (code P)
  // for the bullish signal, so the detail line cites a real purchase when
  // available. Falls back to a count of P transactions when the named
  // top-buy is missing (e.g. cached payload).
  if (c.insiderSignal === "strong_bullish") {
    const top = c.executiveBuys?.[0] ?? null;
    out.push({
      label: "Executive-grade open-market buying",
      earned: 2,
      max: 2,
      detail: top
        ? `${top.name || "Insider"} purchased $${(top.dollarValue / 1_000_000).toFixed(2)}M on ${top.date}`
        : "Open-market purchase >$100K detected",
    });
  } else if (c.insiderSignal === "bullish") {
    out.push({
      label: "Insider buying",
      earned: 1,
      max: 2,
      detail: "Net open-market buyers — no $100K+ executive-tier purchase",
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
    });
  }

  // Earnings catalyst — quote the % below analyst target so the user sees
  // why this earnings is interesting (or isn't).
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
  });

  // Options — include expiry so user can see which contract.
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
  });

  // Volume — show today's vs 10d average in raw shares so the magnitude
  // reads true.
  const volHit = c.volumeRatio > 2.0 && c.priceChange1d > 0;
  out.push({
    label: "Volume spike",
    earned: volHit ? 1 : 0,
    max: 1,
    detail: volHit
      ? `${c.volumeRatio.toFixed(2)}x avg (${formatVolume(c.todayVolume)} today vs ${formatVolume(c.avgVolume10d)} avg) with price up`
      : `${c.volumeRatio.toFixed(2)}x avg (${formatVolume(c.todayVolume)} today vs ${formatVolume(c.avgVolume10d)} avg) — no spike`,
  });

  // R/R bonus — quote the entry/target/stop levels behind the ratio.
  const rrHit = (c.rr ?? 0) >= 3.0;
  const levels = `entry ${fmtMoney(c.entryPrice)} → target ${fmtMoney(c.targetPrice)} → stop ${fmtMoney(c.stopPrice)}`;
  out.push({
    label: "R/R bonus (≥3:1)",
    earned: rrHit ? 1 : 0,
    max: 1,
    detail: rrHit
      ? `${(c.rr ?? 0).toFixed(2)}:1 ratio · ${levels}`
      : `${(c.rr ?? 0).toFixed(2)}:1 ratio · ${levels} — meets 2:1 minimum, below 3:1 ideal`,
  });

  const squeezeHit = c.shortPercentFloat !== null && c.shortPercentFloat > 0.15;
  out.push({
    label: "Short squeeze potential",
    earned: squeezeHit ? 1 : 0,
    max: 1,
    detail:
      c.shortPercentFloat === null
        ? "No short data"
        : squeezeHit
          ? `${(c.shortPercentFloat * 100).toFixed(1)}% short float — squeeze possible if catalyst triggers`
          : `${(c.shortPercentFloat * 100).toFixed(1)}% short float — below 15% threshold`,
  });

  const maPerfect = c.vsMA50 >= -0.02 && c.vsMA50 <= 0.02;
  out.push({
    label: "Perfect MA setup",
    earned: maPerfect ? 1 : 0,
    max: 1,
    detail: maPerfect
      ? `Within ±2% of 50d MA (${fmtPct(c.vsMA50, 1)})`
      : `${fmtPct(c.vsMA50, 1)} from 50d MA — outside ±2% sweet spot`,
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
                    {comp.earned}/{comp.max}
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


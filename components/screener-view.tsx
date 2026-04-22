"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Play,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Loader2,
  RefreshCcw,
  Sparkles,
  Star,
  ArrowUp,
  ArrowDown,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { ScreenerResult } from "@/lib/screener";
import { LogTradeDialog } from "@/components/log-trade-dialog";

type Props = { connected: boolean };

type RunStatus = "idle" | "screening" | "applying" | "analyzing" | "error";

type ScreenStats = {
  finnhub: number;
  afterEtfAndBlacklist: number;
  afterPriceFilter: number;
  afterChainFilter: number;
  final: number;
  droppedByEtf: string[];
  droppedByBlacklist: string[];
  droppedByPrice: string[];
  droppedByChain: string[];
};

type SortKey =
  | "symbol"
  | "price"
  | "dte"
  | "crush"
  | "opportunity"
  | "strike"
  | "premium"
  | "delta"
  | "spread"
  | "stage2";

function recColor(rec: ScreenerResult["recommendation"]) {
  switch (rec) {
    case "Strong - Take the trade":
      return "bg-emerald-500/15 text-emerald-300 border-emerald-500/40";
    case "Marginal - Size smaller":
      return "bg-amber-500/15 text-amber-300 border-amber-500/40";
    case "Needs analysis":
      return "bg-sky-500/15 text-sky-300 border-sky-500/40";
    case "Skip":
      return "bg-muted text-muted-foreground";
    default:
      return "bg-slate-700/30 text-slate-300";
  }
}

function gradeColor(grade: string | null | undefined) {
  if (!grade) return "text-muted-foreground";
  if (grade === "A") return "text-emerald-300";
  if (grade === "B") return "text-sky-300";
  if (grade === "C") return "text-amber-300";
  return "text-rose-300";
}

function fmtPrice(n: number | null | undefined) {
  if (n === null || n === undefined || !Number.isFinite(n) || n === 0) return "--";
  return `$${n.toFixed(2)}`;
}

function fmtNum(n: number | null | undefined, digits = 2) {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return n.toFixed(digits);
}

function gradeOrder(g: string | null | undefined): number {
  if (g === "A") return 0;
  if (g === "B") return 1;
  if (g === "C") return 2;
  if (g === "F") return 3;
  return 4;
}

// localStorage keys for screener persistence.
const LS = {
  results: "screener_results",
  timestamp: "screener_timestamp",
  stats: "screener_stats",
  prices: "screener_prices",
} as const;
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // auto-clear after 24h

function clearStoredScreen() {
  try {
    if (typeof window === "undefined") return;
    for (const k of Object.values(LS)) window.localStorage.removeItem(k);
  } catch {
    // ignore — quota / privacy mode
  }
}

function saveStoredScreen(
  results: ScreenerResult[],
  timestamp: Date,
  prices: Record<string, number>,
  stats: ScreenStats | null,
) {
  try {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(LS.results, JSON.stringify(results));
    window.localStorage.setItem(LS.timestamp, timestamp.toISOString());
    window.localStorage.setItem(LS.prices, JSON.stringify(prices));
    if (stats) window.localStorage.setItem(LS.stats, JSON.stringify(stats));
    else window.localStorage.removeItem(LS.stats);
  } catch (e) {
    console.warn("[screener] saveStoredScreen failed:", e);
  }
}

// Backfill fields that may be missing if the cached payload predates a schema
// change, so the renderer never sees undefined where it expects a value.
function normaliseResult(r: Partial<ScreenerResult> & { symbol?: string }): ScreenerResult | null {
  if (!r || typeof r.symbol !== "string") return null;
  return {
    symbol: r.symbol,
    price: r.price ?? 0,
    earningsDate: r.earningsDate ?? "",
    earningsTiming: (r.earningsTiming as "BMO" | "AMC") ?? "AMC",
    daysToExpiry: r.daysToExpiry ?? 0,
    expiry: r.expiry ?? "",
    stoppedAt: r.stoppedAt ?? null,
    stageOne: r.stageOne ?? { pass: true, reason: "", details: {} },
    stageTwo: r.stageTwo ?? null,
    stageThree: r.stageThree ?? null,
    stageFour: r.stageFour ?? null,
    recommendation: r.recommendation ?? "Needs analysis",
    errors: r.errors ?? [],
    isWhitelisted: r.isWhitelisted ?? false,
    industryStatus: r.industryStatus ?? "unknown",
    spreadTooWide: r.spreadTooWide ?? false,
  };
}

type RestoredState = {
  results: ScreenerResult[];
  timestamp: Date;
  prices: Record<string, number>;
  stats: ScreenStats | null;
  ageMs: number;
};

function loadStoredScreen(): RestoredState | null {
  try {
    if (typeof window === "undefined") return null;
    const ts = window.localStorage.getItem(LS.timestamp);
    const resultsJson = window.localStorage.getItem(LS.results);
    if (!ts || !resultsJson) return null;
    const timestamp = new Date(ts);
    if (Number.isNaN(timestamp.getTime())) {
      clearStoredScreen();
      return null;
    }
    const ageMs = Date.now() - timestamp.getTime();
    if (ageMs > MAX_AGE_MS) {
      clearStoredScreen();
      return null;
    }
    const raw = JSON.parse(resultsJson) as unknown;
    if (!Array.isArray(raw)) {
      clearStoredScreen();
      return null;
    }
    const results = raw
      .map((r) => normaliseResult(r as Partial<ScreenerResult>))
      .filter((r): r is ScreenerResult => r !== null);
    const pricesJson = window.localStorage.getItem(LS.prices);
    const statsJson = window.localStorage.getItem(LS.stats);
    const prices = pricesJson ? (JSON.parse(pricesJson) as Record<string, number>) : {};
    const stats = statsJson ? (JSON.parse(statsJson) as ScreenStats) : null;
    return { results, timestamp, prices, stats, ageMs };
  } catch (e) {
    console.warn("[screener] loadStoredScreen failed:", e);
    clearStoredScreen();
    return null;
  }
}

export function ScreenerView({ connected }: Props) {
  const router = useRouter();
  const [status, setStatus] = useState<RunStatus>("idle");
  const [results, setResults] = useState<ScreenerResult[] | null>(null);
  const [prices, setPrices] = useState<Record<string, number>>({});
  const [screenedAt, setScreenedAt] = useState<Date | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastStats, setLastStats] = useState<ScreenStats | null>(null);
  const [analyzingSymbols, setAnalyzingSymbols] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [logRow, setLogRow] = useState<ScreenerResult | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("stage2");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  // When `groupMode` is non-null, results render as two groups with a divider.
  // Clicking any column header switches to flat sort and sets groupMode=null.
  const [groupMode, setGroupMode] = useState<"stage2" | "grades" | null>(null);

  // Restore any cached screen on mount. Runs client-side only.
  useEffect(() => {
    const restored = loadStoredScreen();
    if (!restored) return;
    setResults(restored.results);
    setPrices(restored.prices);
    setScreenedAt(restored.timestamp);
    setLastStats(restored.stats);
    // If any result has Stage 3+4 data, the user had run Run Analysis before —
    // restore that grouping; otherwise group by Stage 2 score.
    const analyzed = restored.results.some((r) => r.stageThree !== null);
    setGroupMode(analyzed ? "grades" : "stage2");
  }, []);

  const toggle = (id: string) => setExpanded((s) => ({ ...s, [id]: !s[id] }));

  function onSort(key: SortKey) {
    // Any column click escapes grouped mode and becomes a flat sort.
    if (groupMode === null && sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setGroupMode(null);
      setSortKey(key);
      setSortDir(key === "symbol" ? "asc" : "desc");
    }
  }

  const view = useMemo<{ items: ScreenerResult[]; group1Count: number | null }>(() => {
    if (!results) return { items: [], group1Count: null };

    const priceOf = (r: ScreenerResult) => prices[r.symbol.toUpperCase()] ?? r.price;

    if (groupMode !== null) {
      const group1 = results.filter((r) => r.industryStatus === "pass");
      const group2 = results.filter((r) => r.industryStatus !== "pass");

      if (groupMode === "stage2") {
        group1.sort((a, b) => (b.stageTwo?.score ?? -999) - (a.stageTwo?.score ?? -999));
      } else {
        // "grades" — crush grade, then opportunity grade. A > B > C > F > (none).
        group1.sort((a, b) => {
          const cd = gradeOrder(a.stageThree?.crushGrade) - gradeOrder(b.stageThree?.crushGrade);
          if (cd !== 0) return cd;
          return gradeOrder(a.stageFour?.opportunityGrade) - gradeOrder(b.stageFour?.opportunityGrade);
        });
      }
      // Group 2: price descending — higher-priced names tend to have more liquid options.
      group2.sort((a, b) => priceOf(b) - priceOf(a));

      return { items: [...group1, ...group2], group1Count: group1.length };
    }

    // Flat sort
    const copy = [...results];
    copy.sort((a, b) => {
      let va: number | string = 0;
      let vb: number | string = 0;
      switch (sortKey) {
        case "symbol":
          va = a.symbol;
          vb = b.symbol;
          break;
        case "price":
          va = priceOf(a);
          vb = priceOf(b);
          break;
        case "dte":
          va = a.daysToExpiry;
          vb = b.daysToExpiry;
          break;
        case "crush":
          va = gradeOrder(a.stageThree?.crushGrade);
          vb = gradeOrder(b.stageThree?.crushGrade);
          break;
        case "opportunity":
          va = gradeOrder(a.stageFour?.opportunityGrade);
          vb = gradeOrder(b.stageFour?.opportunityGrade);
          break;
        case "strike":
          va = a.stageFour?.suggestedStrike ?? -1;
          vb = b.stageFour?.suggestedStrike ?? -1;
          break;
        case "premium":
          va = a.stageFour?.premium ?? -1;
          vb = b.stageFour?.premium ?? -1;
          break;
        case "delta":
          va = a.stageFour?.delta ?? 999;
          vb = b.stageFour?.delta ?? 999;
          break;
        case "spread":
          va = a.stageFour?.bidAskSpreadPct ?? 999;
          vb = b.stageFour?.bidAskSpreadPct ?? 999;
          break;
        case "stage2":
          va = a.stageTwo?.score ?? -999;
          vb = b.stageTwo?.score ?? -999;
          break;
      }
      if (typeof va === "string" && typeof vb === "string") {
        return sortDir === "asc" ? va.localeCompare(vb) : vb.localeCompare(va);
      }
      const diff = (va as number) - (vb as number);
      return sortDir === "asc" ? diff : -diff;
    });
    return { items: copy, group1Count: null };
  }, [results, prices, sortKey, sortDir, groupMode]);

  const sortedResults = view.items;
  const group1Count = view.group1Count;

  async function screenToday() {
    // Clear any stale cached screen FIRST — a new run always replaces old data.
    clearStoredScreen();
    setStatus("screening");
    setError(null);
    setMessage(null);
    setExpanded({});
    setLastStats(null);
    try {
      const res = await fetch("/api/screener/screen", { method: "POST", cache: "no-store" });
      const json = (await res.json().catch(() => ({}))) as {
        results?: ScreenerResult[];
        prices?: Record<string, number>;
        screenedAt?: string;
        stats?: ScreenStats;
        error?: string;
      };
      if (!res.ok || json.error) {
        const msg = json.error ?? `HTTP ${res.status}`;
        setError(`Screen failed: ${msg}`);
        setStatus("error");
        if (json.stats) setLastStats(json.stats);
        return;
      }
      const nextResults = json.results ?? [];
      const nextPrices = json.prices ?? {};
      const nextStats = json.stats ?? null;
      const nextTimestamp = json.screenedAt ? new Date(json.screenedAt) : new Date();
      setResults(nextResults);
      setPrices(nextPrices);
      setScreenedAt(nextTimestamp);
      setLastStats(nextStats);
      setGroupMode("stage2");
      setStatus("idle");
      setMessage(`Screened ${nextResults.length} candidates`);
      saveStoredScreen(nextResults, nextTimestamp, nextPrices, nextStats);
    } catch (e) {
      setError(`Screen failed: ${e instanceof Error ? e.message : "network error"}`);
      setStatus("error");
    }
  }

  async function applyWatchlist() {
    if (!results) return;
    setStatus("applying");
    setError(null);
    setMessage(null);
    try {
      const res = await fetch("/api/screener/apply-watchlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentSymbols: results.map((r) => r.symbol) }),
        cache: "no-store",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      const json = (await res.json()) as {
        added: ScreenerResult[];
        removed: string[];
        updatedPrices: Record<string, number>;
      };
      const removedSet = new Set(json.removed.map((s) => s.toUpperCase()));
      const next = results.filter((r) => !removedSet.has(r.symbol.toUpperCase())).concat(json.added);
      const mergedPrices = { ...prices, ...json.updatedPrices };
      setResults(next);
      setPrices(mergedPrices);
      setMessage(`Added ${json.added.length}, removed ${json.removed.length}`);
      setStatus("idle");
      // Persist the mutated list. Keep the original screenedAt timestamp so
      // the "Last screened" badge still reflects the most recent Screen run.
      if (screenedAt) saveStoredScreen(next, screenedAt, mergedPrices, lastStats);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Apply watchlist failed");
      setStatus("error");
    }
  }

  async function runAnalysis() {
    if (!results || !connected) return;
    setStatus("analyzing");
    setError(null);
    setMessage(null);
    setAnalyzingSymbols(new Set(results.map((r) => r.symbol.toUpperCase())));
    try {
      const res = await fetch("/api/screener/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ candidates: results }),
        cache: "no-store",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      const json = (await res.json()) as {
        results: ScreenerResult[];
        prices: Record<string, number>;
      };
      const byKey = new Map(json.results.map((r) => [`${r.symbol}|${r.earningsDate}`, r]));
      const next = results.map((r) => byKey.get(`${r.symbol}|${r.earningsDate}`) ?? r);
      const mergedPrices = { ...prices, ...json.prices };
      setResults(next);
      setPrices(mergedPrices);
      setGroupMode("grades");
      setMessage(`Analyzed ${json.results.length} candidates`);
      setStatus("idle");
      if (screenedAt) saveStoredScreen(next, screenedAt, mergedPrices, lastStats);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Analysis failed");
      setStatus("error");
    } finally {
      setAnalyzingSymbols(new Set());
    }
  }

  const hasResults = (results?.length ?? 0) > 0;
  const emptyAfterScreen = results !== null && results.length === 0 && status !== "screening";
  const busy = status === "screening" || status === "applying" || status === "analyzing";
  const staleAgeHours =
    screenedAt && !busy ? Math.floor((Date.now() - screenedAt.getTime()) / (60 * 60 * 1000)) : 0;
  const showStaleNotice = staleAgeHours >= 4;

  return (
    <TooltipProvider>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-3 text-sm">
            <Badge variant={connected ? "default" : "destructive"}>
              Schwab: {connected ? "connected" : "disconnected"}
            </Badge>
            {screenedAt && (
              <span className="text-xs text-muted-foreground">
                Last screened:{" "}
                {screenedAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", hour12: true })}
              </span>
            )}
            {message && !error && <span className="text-xs text-emerald-300">{message}</span>}
          </div>
          <div className="flex items-center gap-2">
            {!connected && (
              <Button asChild variant="outline" size="sm">
                <a href="/api/auth/schwab">Connect Schwab</a>
              </Button>
            )}
            <Button onClick={screenToday} disabled={busy}>
              {status === "screening" ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Play className="mr-2 h-4 w-4" />
              )}
              {status === "screening" ? "Screening…" : "Screen Today"}
            </Button>
            <Button variant="secondary" disabled={!results || busy} onClick={applyWatchlist}>
              {status === "applying" ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <RefreshCcw className="mr-2 h-4 w-4" />
              )}
              Apply Watchlist
            </Button>
            <Tooltip>
              <TooltipTrigger asChild>
                <span>
                  <Button
                    className="bg-indigo-500 text-white hover:bg-indigo-400 disabled:opacity-60"
                    disabled={!results || busy || !connected}
                    onClick={runAnalysis}
                  >
                    {status === "analyzing" ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Sparkles className="mr-2 h-4 w-4" />
                    )}
                    Run Analysis
                  </Button>
                </span>
              </TooltipTrigger>
              {!connected && <TooltipContent>Connect Schwab to run analysis</TooltipContent>}
            </Tooltip>
          </div>
        </div>

        {error && (
          <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-200">
            <div className="mb-1 flex items-center gap-2 font-medium">
              <AlertTriangle className="h-4 w-4" /> {error}
            </div>
          </div>
        )}

        {showStaleNotice && (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
            <AlertTriangle className="mr-1.5 inline h-3 w-3" />
            Results from {staleAgeHours} hour{staleAgeHours === 1 ? "" : "s"} ago — consider
            re-screening.
          </div>
        )}

        {!results && status !== "screening" && (
          <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border bg-background/40 px-6 py-16 text-center">
            <Play className="mb-3 h-10 w-10 text-muted-foreground" />
            <h2 className="mb-1 text-lg font-semibold">No screen run yet</h2>
            <p className="mb-6 max-w-md text-sm text-muted-foreground">
              Click Screen Today to pull today&apos;s AMC and tomorrow&apos;s BMO earnings and score them
              through Stage 1 and Stage 2. Run Analysis later to fill in crush + opportunity grades.
            </p>
            <Button size="lg" onClick={screenToday} disabled={busy}>
              <Play className="mr-2 h-4 w-4" />
              Screen Today
            </Button>
          </div>
        )}

        {status === "screening" && (
          <div className="flex flex-col items-center justify-center rounded-lg border border-border bg-background/40 px-6 py-16 text-center">
            <Loader2 className="mb-3 h-10 w-10 animate-spin text-muted-foreground" />
            <div className="text-sm text-muted-foreground">
              Fetching earnings calendar, pricing batch, and scoring stages 1 & 2…
            </div>
          </div>
        )}

        {emptyAfterScreen && lastStats && (
          <div className="rounded-lg border border-border bg-background/40 p-4 text-sm">
            <div className="mb-2 font-medium">No candidates survived the filters.</div>
            <div className="space-y-1 font-mono text-xs text-muted-foreground">
              <div>
                Finnhub raw: <span className="text-foreground">{lastStats.finnhub}</span>
              </div>
              <div>
                After ETF / blacklist: <span className="text-foreground">{lastStats.afterEtfAndBlacklist}</span>
                {lastStats.droppedByEtf.length > 0 && (
                  <> · ETF dropped: {lastStats.droppedByEtf.slice(0, 8).join(", ")}</>
                )}
                {lastStats.droppedByBlacklist.length > 0 && (
                  <> · blacklist dropped: {lastStats.droppedByBlacklist.slice(0, 8).join(", ")}</>
                )}
              </div>
              <div>
                After $70 price floor: <span className="text-foreground">{lastStats.afterPriceFilter}</span>
                {lastStats.droppedByPrice.length > 0 && (
                  <> · price dropped: {lastStats.droppedByPrice.slice(0, 8).join(", ")}</>
                )}
              </div>
              <div>
                After weekly-chain filter: <span className="text-foreground">{lastStats.afterChainFilter}</span>
                {lastStats.droppedByChain.length > 0 && (
                  <> · no-chain: {lastStats.droppedByChain.slice(0, 8).join(", ")}</>
                )}
              </div>
              <div>
                Final: <span className="text-foreground">{lastStats.final}</span>
              </div>
            </div>
            <div className="mt-3 text-xs text-muted-foreground">
              If Finnhub raw is 0, check the Vercel runtime logs for the <code>[finnhub]</code> and <code>[earnings]</code>
              lines — they show the exact URL, date window, and raw row breakdown.
            </div>
          </div>
        )}

        {hasResults && status !== "screening" && (
          <div className="overflow-hidden rounded-lg border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8"></TableHead>
                  <SortableHeader label="Symbol" active={sortKey === "symbol"} dir={sortDir} onClick={() => onSort("symbol")} />
                  <SortableHeader label="Price" active={sortKey === "price"} dir={sortDir} onClick={() => onSort("price")} />
                  <TableHead>Earnings</TableHead>
                  <SortableHeader label="DTE" active={sortKey === "dte"} dir={sortDir} onClick={() => onSort("dte")} />
                  <SortableHeader label="Q" active={sortKey === "stage2"} dir={sortDir} onClick={() => onSort("stage2")} />
                  <SortableHeader label="Crush" active={sortKey === "crush"} dir={sortDir} onClick={() => onSort("crush")} />
                  <SortableHeader label="Opp." active={sortKey === "opportunity"} dir={sortDir} onClick={() => onSort("opportunity")} />
                  <SortableHeader label="Strike" active={sortKey === "strike"} dir={sortDir} onClick={() => onSort("strike")} />
                  <SortableHeader label="Premium" active={sortKey === "premium"} dir={sortDir} onClick={() => onSort("premium")} />
                  <SortableHeader label="Delta" active={sortKey === "delta"} dir={sortDir} onClick={() => onSort("delta")} />
                  <SortableHeader label="Spread" active={sortKey === "spread"} dir={sortDir} onClick={() => onSort("spread")} />
                  <TableHead>Recommendation</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sortedResults.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={14} className="py-10 text-center text-sm text-muted-foreground">
                      No qualifying earnings today or tomorrow after filters.
                    </TableCell>
                  </TableRow>
                )}
                {sortedResults.map((r, idx) => {
                  const id = `${r.symbol}-${r.earningsDate}`;
                  const open = !!expanded[id];
                  const displayedPrice = prices[r.symbol.toUpperCase()] ?? r.price;
                  const analyzingRow = analyzingSymbols.has(r.symbol.toUpperCase());
                  const actionable =
                    r.recommendation === "Strong - Take the trade" ||
                    r.recommendation === "Marginal - Size smaller";
                  const showDivider = group1Count !== null && idx === group1Count && idx > 0;
                  return (
                    <>
                      {showDivider && (
                        <TableRow key={`divider-${idx}`} className="hover:bg-transparent">
                          <TableCell
                            colSpan={14}
                            className="bg-amber-500/10 py-1.5 text-center text-xs italic text-amber-300/90"
                          >
                            <AlertTriangle className="mr-1.5 inline h-3 w-3" />
                            Outside screener criteria — use caution
                          </TableCell>
                        </TableRow>
                      )}
                      <TableRow key={id} className="cursor-pointer" onClick={() => toggle(id)}>
                        <TableCell>
                          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                        </TableCell>
                        <TableCell className="font-medium">
                          <span className="inline-flex items-center gap-1">
                            {r.symbol}
                            {r.isWhitelisted && (
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Star className="h-3.5 w-3.5 fill-amber-300 text-amber-300" />
                                </TooltipTrigger>
                                <TooltipContent>Whitelisted</TooltipContent>
                              </Tooltip>
                            )}
                            {r.industryStatus === "fail" && !r.isWhitelisted && (
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <AlertTriangle className="h-3.5 w-3.5 text-amber-400" />
                                </TooltipTrigger>
                                <TooltipContent>
                                  Industry not on the preferred list (−2 Stage 2 penalty)
                                </TooltipContent>
                              </Tooltip>
                            )}
                          </span>
                        </TableCell>
                        <TableCell>{fmtPrice(displayedPrice)}</TableCell>
                        <TableCell className="text-xs">
                          {r.earningsDate} <span className="text-muted-foreground">· {r.earningsTiming}</span>
                        </TableCell>
                        <TableCell>{r.daysToExpiry}</TableCell>
                        <TableCell className="font-mono">
                          {r.stageTwo ? `${r.stageTwo.score}` : "—"}
                        </TableCell>
                        <TableCell className={cn("font-mono", gradeColor(r.stageThree?.crushGrade))}>
                          {analyzingRow ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : (r.stageThree?.crushGrade ?? "—")}
                        </TableCell>
                        <TableCell className={cn("font-mono", gradeColor(r.stageFour?.opportunityGrade))}>
                          {analyzingRow ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : (r.stageFour?.opportunityGrade ?? "—")}
                        </TableCell>
                        <TableCell>{r.stageFour?.suggestedStrike ? `$${fmtNum(r.stageFour.suggestedStrike)}` : "—"}</TableCell>
                        <TableCell>
                          {r.stageFour?.premium !== null && r.stageFour?.premium !== undefined
                            ? `$${fmtNum(r.stageFour.premium)}`
                            : "—"}
                        </TableCell>
                        <TableCell>{fmtNum(r.stageFour?.delta ?? null, 3)}</TableCell>
                        <TableCell>
                          {r.stageFour?.bidAskSpreadPct !== null && r.stageFour?.bidAskSpreadPct !== undefined
                            ? `${fmtNum(r.stageFour.bidAskSpreadPct, 1)}%`
                            : "—"}
                        </TableCell>
                        <TableCell>
                          <span className={cn("rounded-md border px-2 py-0.5 text-xs", recColor(r.recommendation))}>
                            {r.recommendation}
                          </span>
                        </TableCell>
                        <TableCell onClick={(e) => e.stopPropagation()}>
                          {actionable && r.stageFour?.suggestedStrike ? (
                            <Button size="sm" variant="secondary" onClick={() => setLogRow(r)}>
                              Log trade
                            </Button>
                          ) : null}
                        </TableCell>
                      </TableRow>
                      {open && (
                        <TableRow key={`${id}-detail`}>
                          <TableCell colSpan={14} className="bg-muted/30">
                            <ExpandedDetail r={r} />
                          </TableCell>
                        </TableRow>
                      )}
                    </>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}

        {logRow && (
          <LogTradeDialog
            row={logRow}
            open={!!logRow}
            onOpenChange={(o) => !o && setLogRow(null)}
            onSuccess={() => {
              setLogRow(null);
              router.refresh();
            }}
          />
        )}
      </div>
    </TooltipProvider>
  );
}

function SortableHeader({
  label,
  active,
  dir,
  onClick,
}: {
  label: string;
  active: boolean;
  dir: "asc" | "desc";
  onClick: () => void;
}) {
  return (
    <TableHead
      onClick={onClick}
      className="cursor-pointer select-none hover:text-foreground"
    >
      <span className="inline-flex items-center gap-1">
        {label}
        {active && (dir === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)}
      </span>
    </TableHead>
  );
}

function ExpandedDetail({ r }: { r: ScreenerResult }) {
  return (
    <div className="grid gap-4 p-3 md:grid-cols-4">
      <StageCard title="Stage 1 · Context" pass={r.stageOne.pass} summary={r.stageOne.reason}>
        {Object.entries(r.stageOne.details).map(([k, v]) => (
          <Row key={k} k={k} v={String(v ?? "—")} />
        ))}
      </StageCard>

      <StageCard
        title="Stage 2 · Quality"
        pass={r.stageTwo?.pass ?? false}
        summary={r.stageTwo ? `${r.stageTwo.score}/9 — ${r.stageTwo.reason}` : "not reached"}
      >
        {r.stageTwo && (
          <>
            <Row k="Business simplicity" v={`${r.stageTwo.details.businessSimplicity}/3`} />
            <Row k="Market cap tier" v={`${r.stageTwo.details.marketCapTier}/3`} />
            <Row k="Analyst dispersion" v={`${r.stageTwo.details.analystDispersion}/3`} />
            <Row k="Overhang penalty" v={String(r.stageTwo.details.activeOverhangPenalty)} />
            <Row k="Industry penalty" v={String(r.stageTwo.details.industryPenalty)} />
            <Row
              k="Market cap"
              v={r.stageTwo.details.marketCapBillions ? `$${r.stageTwo.details.marketCapBillions.toFixed(1)}B` : "—"}
            />
            <Row k="Industry class" v={r.stageTwo.details.industryClass} />
          </>
        )}
      </StageCard>

      <StageCard
        title="Stage 3 · Crush"
        pass={r.stageThree?.pass ?? false}
        summary={
          r.stageThree
            ? `${r.stageThree.score}/25 — grade ${r.stageThree.crushGrade} (threshold ${r.stageThree.threshold})`
            : "run analysis to populate"
        }
      >
        {r.stageThree && (
          <>
            <Row k="Historical move" v={`${r.stageThree.details.historicalMoveScore}/8`} />
            <Row k="Consistency" v={`${r.stageThree.details.consistencyScore}/4`} />
            <Row k="Term structure" v={`${r.stageThree.details.termStructureScore}/5`} />
            <Row k="IV edge" v={`${r.stageThree.details.ivEdgeScore}/4`} />
            <Row k="Surprise reliability" v={`${r.stageThree.details.surpriseScore}/4`} />
          </>
        )}
      </StageCard>

      <StageCard
        title="Stage 4 · Opportunity"
        pass={!r.spreadTooWide && (r.stageFour?.score ?? 0) >= 8}
        summary={r.stageFour ? `${r.stageFour.score}/20 — grade ${r.stageFour.opportunityGrade}` : "run analysis to populate"}
      >
        {r.stageFour && (
          <>
            {r.stageFour.note && (
              <div className="mb-2 rounded border border-rose-500/40 bg-rose-500/10 px-2 py-1 text-rose-300">
                <AlertTriangle className="mr-1 inline h-3 w-3" />
                {r.stageFour.note}
              </div>
            )}
            <Row
              k="Premium yield"
              v={`${r.stageFour.details.premiumYieldScore}/8 (${r.stageFour.premiumYieldPct !== null ? r.stageFour.premiumYieldPct.toFixed(2) + "%" : "—"})`}
            />
            <Row k="Delta" v={`${r.stageFour.details.deltaScore}/6 (${r.stageFour.delta ?? "—"})`} />
            <Row
              k="Spread"
              v={`${r.stageFour.details.spreadScore}/6 (${r.stageFour.bidAskSpreadPct !== null ? r.stageFour.bidAskSpreadPct + "%" : "—"})`}
            />
            <Row k="Contract" v={r.stageFour.details.contractSymbol ?? "—"} />
          </>
        )}
      </StageCard>
    </div>
  );
}

function StageCard({
  title,
  pass,
  summary,
  children,
}: {
  title: string;
  pass: boolean;
  summary: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-md border border-border bg-background/40 p-3 text-xs">
      <div className="mb-2 flex items-center justify-between">
        <div className="font-medium text-foreground">{title}</div>
        <span
          className={cn(
            "rounded border px-1.5 py-0.5",
            pass ? "border-emerald-500/40 text-emerald-300" : "border-rose-500/40 text-rose-300",
          )}
        >
          {pass ? "pass" : "fail"}
        </span>
      </div>
      <div className="mb-2 text-muted-foreground">{summary}</div>
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-muted-foreground">{k}</span>
      <span className="font-mono text-foreground">{v}</span>
    </div>
  );
}

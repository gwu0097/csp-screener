"use client";

import { useEffect, useMemo, useState } from "react";
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
import type { ScreenerResult, StageFourResult } from "@/lib/screener";
import type { MarketContext } from "@/lib/market";
import { CrushHistoryTable } from "@/components/crush-history-table";
import { OptionsFlowSection } from "@/components/options-flow-section";

// localStorage key for the Track checkbox state (screener_tracked is an
// array of UPPERCASE symbols). Cleared whenever Screen Today runs.
const LS_TRACKED = "screener_tracked";

type Props = { connected: boolean };

type RunStatus = "idle" | "screening" | "applying" | "analyzing" | "error";

// Per-pass analyze error. When pass3 fails the user has already seen
// pass2 results merged into the table; the banner explains what's
// missing. When pass2 fails the table still shows the pass1 candidates
// (no grade columns); the banner says options data is unavailable.
type AnalysisError = {
  pass: "pass2" | "pass3";
  status: number | null; // null = network / fetch threw before response
  rawMessage: string;
  partialAvailable: boolean;
};

// Friendly copy + suggested action for a failed analyze pass.
function describeAnalysisError(err: AnalysisError): {
  title: string;
  detail: string;
  action: "retry" | "settings" | null;
} {
  const passLabel =
    err.pass === "pass2"
      ? "Pass 2 (Schwab options + grading)"
      : "Pass 3 (Perplexity news + final grade)";
  if (err.status === null) {
    return {
      title: `${passLabel} failed`,
      detail:
        "Could not reach the server. Check your internet connection and retry.",
      action: "retry",
    };
  }
  if (err.status === 504) {
    return {
      title: `${passLabel} timed out`,
      detail:
        err.pass === "pass2"
          ? "Schwab options chain or earnings history took too long. Try again, or run during market hours when Schwab is fastest."
          : "Perplexity / EDGAR call exceeded the 60s ceiling. Retry usually works.",
      action: "retry",
    };
  }
  if (err.status === 503) {
    return {
      title: `${passLabel} — service unavailable`,
      detail:
        "Schwab, Finnhub, or Perplexity is temporarily down. Try again in a few minutes.",
      action: "retry",
    };
  }
  if (err.status === 401 || err.status === 403) {
    return {
      title: `${passLabel} — Schwab auth expired`,
      detail:
        "Schwab access tokens have expired. Open Settings and reconnect Schwab, then re-run analysis.",
      action: "settings",
    };
  }
  if (err.status === 500) {
    return {
      title: `${passLabel} — server error`,
      detail: `Check Vercel logs for the full stack. Error: ${err.rawMessage || "(no message)"}`,
      action: "retry",
    };
  }
  return {
    title: `${passLabel} failed (HTTP ${err.status})`,
    detail: err.rawMessage || "Unexpected response from the server.",
    action: "retry",
  };
}

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
  | "em"
  | "crush"
  | "opportunity"
  | "strike"
  | "premium"
  | "delta"
  | "spread"
  | "stage2"
  | "grade";

function gradeColor(grade: string | null | undefined) {
  if (!grade) return "text-muted-foreground";
  if (grade === "A") return "text-emerald-300";
  if (grade === "B") return "text-sky-300";
  if (grade === "C") return "text-amber-300";
  if (grade === "?") return "text-muted-foreground";
  return "text-rose-300";
}

// Badge palette for the primary Grade column (the three-layer finalGrade).
// User spec: A=green, B=teal, C=amber, F=red.
function finalGradeBadgeColor(grade: string | null | undefined) {
  if (grade === "A") return "border-emerald-500/40 bg-emerald-500/20 text-emerald-300";
  if (grade === "B") return "border-teal-500/40 bg-teal-500/20 text-teal-300";
  if (grade === "C") return "border-amber-500/40 bg-amber-500/20 text-amber-300";
  if (grade === "F") return "border-rose-500/40 bg-rose-500/20 text-rose-300";
  return "border-border bg-background text-muted-foreground";
}

// Display "?" instead of F when the F grade reflects insufficient history
// rather than a genuinely weak crusher.
function displayCrushGrade(s: ScreenerResult["stageThree"]): string {
  if (!s) return "—";
  if (s.crushGrade === "F" && s.insufficientData) return "?";
  return s.crushGrade;
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
const LS_RESULTS = "screener_results";
const LS_TIMESTAMP = "screener_timestamp";
const LS_PRICES = "screener_prices";

// Cross-device hydration freshness window. Anything older shows the
// "stale — Run Analysis to update" banner instead of the green one.
const FRESH_WINDOW_MS = 24 * 60 * 60 * 1000;

function clearStoredScreen() {
  try {
    if (typeof window === "undefined") return;
    window.localStorage.removeItem(LS_RESULTS);
    window.localStorage.removeItem(LS_TIMESTAMP);
    window.localStorage.removeItem(LS_PRICES);
  } catch {
    // ignore — quota / privacy mode
  }
}

// Writes the latest screener snapshot to localStorage AND fires a
// background POST to /api/screener/results/save so the result is
// available cross-device. The Supabase write is best-effort —
// localStorage is the authoritative store on the originating device,
// the DB row exists for hydration on every other device.
function persistScreenSnapshot(args: {
  candidates: ScreenerResult[];
  prices: Record<string, number>;
  screenedAt: string;
  pass1Count?: number | null;
  pass2Count?: number | null;
  vix?: number | null;
}) {
  try {
    if (typeof window !== "undefined") {
      localStorage.setItem(LS_RESULTS, JSON.stringify(args.candidates));
      localStorage.setItem(LS_TIMESTAMP, args.screenedAt);
      localStorage.setItem(LS_PRICES, JSON.stringify(args.prices));
    }
  } catch (e) {
    console.error("[screener] localStorage save failed", e);
  }
  // Fire-and-forget: failure here doesn't block the UI; the next
  // mount on this device will still hydrate from localStorage.
  void fetch("/api/screener/results/save", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      candidates: args.candidates,
      screenedAt: args.screenedAt,
      prices: args.prices,
      pass1Count: args.pass1Count ?? null,
      pass2Count: args.pass2Count ?? null,
      vix: args.vix ?? null,
    }),
    cache: "no-store",
  }).catch((e) => {
    console.warn("[screener] remote save failed", e);
  });
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
    threeLayer: r.threeLayer ?? null,
  };
}

export function ScreenerView({ connected }: Props) {
  const [status, setStatus] = useState<RunStatus>("idle");
  const [results, setResults] = useState<ScreenerResult[] | null>(null);
  const [prices, setPrices] = useState<Record<string, number>>({});
  const [screenedAt, setScreenedAt] = useState<Date | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Richer per-pass error so the analyze banner can show a friendly
  // explanation + targeted retry button. Plain `error` keeps holding
  // strings for screen / apply-watchlist failures.
  const [analysisError, setAnalysisError] = useState<AnalysisError | null>(null);
  const [lastStats, setLastStats] = useState<ScreenStats | null>(null);
  const [analyzingSymbols, setAnalyzingSymbols] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  // Track checkbox state: set of UPPERCASE symbols the user has opted to
  // track for tonight's trades. Persisted in localStorage; passed to the
  // analyze endpoint so tracked_tickers gets upserted on every run.
  const [tracked, setTracked] = useState<Set<string>>(new Set());
  // Transient toast for Track confirmations. One line above the table.
  const [trackToast, setTrackToast] = useState<string | null>(null);
  // Default sort: finalGrade (A→F). ascending=true means A before F because
  // gradeOrder returns 0 for A, 3 for F. Tracked rows always float to top.
  const [sortKey, setSortKey] = useState<SortKey>("grade");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  // When `groupMode` is non-null, results render as two groups with a divider.
  // Clicking any column header switches to flat sort and sets groupMode=null.
  const [groupMode, setGroupMode] = useState<"stage2" | "grades" | null>(null);
  // Daily context for the summary line (VIX + regime + open positions count).
  // Fetched once on mount; no refresh on screen runs since these are slow-moving.
  const [dailyContext, setDailyContext] = useState<
    { market: MarketContext; openPositions: number } | null
  >(null);

  useEffect(() => {
    // Fire-and-forget daily context fetch. Runs alongside the cache restore.
    fetch("/api/context/daily", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => setDailyContext(j))
      .catch(() => setDailyContext(null));

    // Restore Track checkbox state from localStorage.
    try {
      const raw = localStorage.getItem(LS_TRACKED);
      if (raw) {
        const arr = JSON.parse(raw) as unknown;
        if (Array.isArray(arr)) {
          setTracked(new Set(arr.filter((s): s is string => typeof s === "string")));
        }
      }
    } catch {
      /* ignore */
    }
  }, []);

  function toggleTracked(symbol: string) {
    const upper = symbol.toUpperCase();
    setTracked((prev) => {
      const next = new Set(prev);
      if (next.has(upper)) {
        next.delete(upper);
        setTrackToast(`Untracked ${upper}`);
      } else {
        next.add(upper);
        setTrackToast(`Tracking ${upper} — grades captured on next analysis run`);
      }
      try {
        localStorage.setItem(LS_TRACKED, JSON.stringify(Array.from(next)));
      } catch {
        /* ignore */
      }
      return next;
    });
    window.setTimeout(() => setTrackToast(null), 4000);
  }

  // Two-stage hydration: localStorage first (instant), Supabase
  // second (cross-device truth). The /latest fetch overwrites
  // localStorage state when the DB row is newer, so opening the app
  // on a second device picks up scans run from elsewhere.
  useEffect(() => {
    // Stage 1 — localStorage. Fast paint on the same device.
    try {
      const raw = localStorage.getItem(LS_RESULTS);
      const ts = localStorage.getItem(LS_TIMESTAMP);
      const pricesRaw = localStorage.getItem(LS_PRICES);
      if (raw && ts) {
        const parsed = (JSON.parse(raw) as unknown[])
          .map((r) => normaliseResult(r as Partial<ScreenerResult>))
          .filter((r): r is ScreenerResult => r !== null);
        if (parsed.length > 0) {
          setResults(parsed);
          if (pricesRaw) setPrices(JSON.parse(pricesRaw));
          setScreenedAt(new Date(ts));
          setGroupMode(null);
        }
      }
    } catch (e) {
      console.error("[screener] localStorage restore failed", e);
    }

    // Stage 2 — Supabase /latest. Replaces local state when the DB
    // row is newer. Stale (>24 h) rows still hydrate so the user sees
    // the full table; the banner labels them as stale.
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/screener/results/latest", {
          cache: "no-store",
        });
        if (!res.ok) return;
        const json = (await res.json()) as {
          screenedAt: string | null;
          candidates: Array<Partial<ScreenerResult> & { symbol?: string }>;
          prices: Record<string, number>;
        };
        if (cancelled) return;
        if (!json.screenedAt || json.candidates.length === 0) return;
        const remoteTs = new Date(json.screenedAt).getTime();
        const localTs = (() => {
          try {
            const ts = localStorage.getItem(LS_TIMESTAMP);
            return ts ? new Date(ts).getTime() : 0;
          } catch {
            return 0;
          }
        })();
        // Only overwrite if the remote row is at least as recent as
        // what we already painted; preserves local edits (Track
        // toggles persist through localStorage; results state stays
        // in sync with the merged set on this device).
        if (remoteTs < localTs) return;
        const parsed = json.candidates
          .map((r) => normaliseResult(r))
          .filter((r): r is ScreenerResult => r !== null);
        setResults(parsed);
        setPrices(json.prices ?? {});
        setScreenedAt(new Date(json.screenedAt));
        setGroupMode(null);
      } catch (e) {
        console.warn("[screener] remote /latest hydrate failed", e);
      }
    })();
    return () => {
      cancelled = true;
    };
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

    // Flat sort. Tracked rows always float to the top regardless of the
    // chosen sort key — they're the ones the user is actively deciding on.
    const copy = [...results];
    copy.sort((a, b) => {
      // 1. Tracked always first.
      const aT = tracked.has(a.symbol.toUpperCase()) ? 0 : 1;
      const bT = tracked.has(b.symbol.toUpperCase()) ? 0 : 1;
      if (aT !== bT) return aT - bT;

      // 2. Primary sort on the chosen column.
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
        case "em":
          va = a.stageThree?.details?.expectedMovePct ??
            a.stageThree?.details?.medianHistoricalMovePct ?? -1;
          vb = b.stageThree?.details?.expectedMovePct ??
            b.stageThree?.details?.medianHistoricalMovePct ?? -1;
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
        case "grade":
          va = gradeOrder(a.threeLayer?.finalGrade);
          vb = gradeOrder(b.threeLayer?.finalGrade);
          break;
      }
      let primary: number;
      if (typeof va === "string" && typeof vb === "string") {
        primary = sortDir === "asc" ? va.localeCompare(vb) : vb.localeCompare(va);
      } else {
        const diff = (va as number) - (vb as number);
        primary = sortDir === "asc" ? diff : -diff;
      }
      if (primary !== 0) return primary;

      // 3. Tiebreakers: finalGrade (A→F) then quality score (desc).
      const gDiff = gradeOrder(a.threeLayer?.finalGrade) - gradeOrder(b.threeLayer?.finalGrade);
      if (gDiff !== 0) return gDiff;
      return (b.stageTwo?.score ?? -999) - (a.stageTwo?.score ?? -999);
    });
    return { items: copy, group1Count: null };
  }, [results, prices, sortKey, sortDir, groupMode, tracked]);

  const sortedResults = view.items;
  const group1Count = view.group1Count;

  async function screenToday() {
    // Clear any stale cached screen FIRST — a new run always replaces old data.
    clearStoredScreen();
    // A new screen = a new trading day. Tracked tickers from the previous
    // day's analysis shouldn't carry over (they apply to yesterday's
    // expiry chain).
    setTracked(new Set());
    try {
      localStorage.removeItem(LS_TRACKED);
    } catch {
      /* ignore */
    }
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
      const timestampIso = json.screenedAt ?? new Date().toISOString();
      // Save BEFORE setState — both localStorage (this device) and
      // Supabase (cross-device hydration on next mount).
      persistScreenSnapshot({
        candidates: nextResults,
        prices: nextPrices,
        screenedAt: timestampIso,
        // ScreenStats here counts candidates per filter stage rather
        // than per analysis pass; map them onto pass1/pass2 columns
        // so the DB row stays comparable across screener types.
        pass1Count: nextStats?.afterPriceFilter ?? null,
        pass2Count: nextStats?.final ?? null,
      });
      setResults(nextResults);
      setPrices(nextPrices);
      setScreenedAt(new Date(timestampIso));
      setLastStats(nextStats);
      setGroupMode(null);
      setStatus("idle");
      setMessage(`Screened ${nextResults.length} candidates`);
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
      // Save BEFORE setState. Preserve the existing timestamp so "Last screened"
      // still reflects the most recent Screen run; fall back to now if missing.
      const timestampIso = (screenedAt ?? new Date()).toISOString();
      persistScreenSnapshot({
        candidates: next,
        prices: mergedPrices,
        screenedAt: timestampIso,
      });
      setResults(next);
      setPrices(mergedPrices);
      setMessage(`Added ${json.added.length}, removed ${json.removed.length}`);
      setStatus("idle");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Apply watchlist failed");
      setStatus("error");
    }
  }

  async function runAnalysis() {
    if (!results || !connected) return;
    setStatus("analyzing");
    setError(null);
    setAnalysisError(null);
    setMessage(null);
    setAnalyzingSymbols(new Set(results.map((r) => r.symbol.toUpperCase())));

    // ---- Pass 2 — Schwab options + stages 3/4 ----
    let p2: {
      results: ScreenerResult[];
      prices: Record<string, number>;
      vix: number | null;
    } | null = null;
    try {
      const r2 = await fetch("/api/screener/analyze/pass2", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ candidates: results }),
        cache: "no-store",
      });
      if (!r2.ok) {
        const body = (await r2.json().catch(() => ({}))) as { error?: string };
        setAnalysisError({
          pass: "pass2",
          status: r2.status,
          rawMessage: body.error ?? "",
          partialAvailable: false,
        });
        setStatus("error");
        setAnalyzingSymbols(new Set());
        return;
      }
      p2 = await r2.json();
    } catch (e) {
      setAnalysisError({
        pass: "pass2",
        status: null,
        rawMessage: e instanceof Error ? e.message : String(e),
        partialAvailable: false,
      });
      setStatus("error");
      setAnalyzingSymbols(new Set());
      return;
    }

    // Merge pass 2 results into the table immediately so a pass 3
    // failure doesn't lose the options grades. Three-layer grade
    // stays null on each row until pass 3 lands.
    const byKey2 = new Map(
      (p2!.results ?? []).map((r) => [`${r.symbol}|${r.earningsDate}`, r]),
    );
    const merged2 = results.map(
      (r) => byKey2.get(`${r.symbol}|${r.earningsDate}`) ?? r,
    );
    const mergedPrices = { ...prices, ...p2!.prices };
    setResults(merged2);
    setPrices(mergedPrices);

    // ---- Pass 3 — Perplexity + grade + post-actions ----
    try {
      const r3 = await fetch("/api/screener/analyze/pass3", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          candidates: p2!.results,
          vix: p2!.vix,
          trackedSymbols: Array.from(tracked),
        }),
        cache: "no-store",
      });
      if (!r3.ok) {
        const body = (await r3.json().catch(() => ({}))) as { error?: string };
        setAnalysisError({
          pass: "pass3",
          status: r3.status,
          rawMessage: body.error ?? "",
          partialAvailable: true,
        });
        setStatus("error");
        setAnalyzingSymbols(new Set());
        return;
      }
      const json = (await r3.json()) as {
        results: ScreenerResult[];
        scoredCount?: number;
        trackedUpserted?: number;
        snapshotsWritten?: number;
        encyclopediaUpdates?: number;
      };
      const byKey = new Map(json.results.map((r) => [`${r.symbol}|${r.earningsDate}`, r]));
      const next = merged2.map((r) => byKey.get(`${r.symbol}|${r.earningsDate}`) ?? r);
      const timestampIso = (screenedAt ?? new Date()).toISOString();
      persistScreenSnapshot({
        candidates: next,
        prices: mergedPrices,
        screenedAt: timestampIso,
      });
      setResults(next);
      setGroupMode(null);
      const scored = json.scoredCount ?? json.results.length;
      const trackedCount = json.trackedUpserted ?? 0;
      const snapshots = json.snapshotsWritten ?? 0;
      const encyclopedia = json.encyclopediaUpdates ?? 0;
      setMessage(
        `Analysis complete ✓\n📊 ${scored} candidates scored\n🎯 ${trackedCount} tracked tickers saved\n📸 ${snapshots} position snapshots taken\n📚 ${encyclopedia} encyclopedia updates`,
      );
      setStatus("idle");
    } catch (e) {
      setAnalysisError({
        pass: "pass3",
        status: null,
        rawMessage: e instanceof Error ? e.message : String(e),
        partialAvailable: true,
      });
      setStatus("error");
    } finally {
      setAnalyzingSymbols(new Set());
    }
  }

  // Per-symbol re-run of pass 2 + pass 3. Useful when the bulk analyze
  // call returned partial data for one row (e.g. news fetch failed) or
  // when the user wants to refresh a single candidate without re-running
  // the whole table. Hits /api/screener/analyze-single, then merges the
  // single enriched candidate back into `results` and persists to LS.
  async function runAnalysisSingle(symbol: string) {
    if (!results || !connected) return;
    const upper = symbol.toUpperCase();
    const candidate = results.find((r) => r.symbol.toUpperCase() === upper);
    if (!candidate) return;
    setError(null);
    setMessage(null);
    setAnalyzingSymbols((prev) => {
      const next = new Set(prev);
      next.add(upper);
      return next;
    });
    try {
      const res = await fetch("/api/screener/analyze-single", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ candidate }),
        cache: "no-store",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setMessage(
          `Analyze ${upper} failed: ${body.error ?? `HTTP ${res.status}`}`,
        );
        return;
      }
      const json = (await res.json()) as {
        result: ScreenerResult;
        vix: number | null;
      };
      const enriched = json.result;
      const next = results.map((r) =>
        r.symbol === enriched.symbol && r.earningsDate === enriched.earningsDate
          ? enriched
          : r,
      );
      const timestampIso = (screenedAt ?? new Date()).toISOString();
      persistScreenSnapshot({
        candidates: next,
        prices,
        screenedAt: timestampIso,
      });
      setResults(next);
      setMessage(`Analysis refreshed for ${upper}`);
    } catch (e) {
      setMessage(
        `Analyze ${upper} failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      setAnalyzingSymbols((prev) => {
        const next = new Set(prev);
        next.delete(upper);
        return next;
      });
    }
  }

  const hasResults = (results?.length ?? 0) > 0;
  const emptyAfterScreen = results !== null && results.length === 0 && status !== "screening";
  const busy = status === "screening" || status === "applying" || status === "analyzing";
  const staleAgeHours =
    screenedAt && !busy ? Math.floor((Date.now() - screenedAt.getTime()) / (60 * 60 * 1000)) : 0;
  const showStaleNotice = staleAgeHours >= 4;

  // "Best" candidate for the summary line — first actionable recommendation.
  const bestCandidate = results?.find(
    (r) =>
      r.recommendation === "Strong - Take the trade" ||
      r.recommendation === "Marginal - Size smaller" ||
      r.recommendation === "Marginal - Crush unproven",
  ) ?? null;
  const vixRegimeColor =
    dailyContext?.market.regime === "panic"
      ? "text-rose-300"
      : dailyContext?.market.regime === "elevated"
        ? "text-amber-300"
        : "text-emerald-300";

  return (
    <TooltipProvider>
      <div className="space-y-4">
        {dailyContext && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>
              VIX:{" "}
              <span className={vixRegimeColor}>
                {dailyContext.market.vix !== null ? dailyContext.market.vix.toFixed(2) : "—"}
                {dailyContext.market.regime ? ` (${dailyContext.market.regime})` : ""}
              </span>
            </span>
            <span>
              <span className="text-foreground">{results?.length ?? 0}</span> candidates today
            </span>
            {bestCandidate && (
              <span>
                Best:{" "}
                <span className="text-foreground">{bestCandidate.symbol}</span>{" "}
                <span className="text-xs">({bestCandidate.recommendation})</span>
              </span>
            )}
            <span>
              Open positions:{" "}
              <span className="text-foreground">{dailyContext.openPositions}</span>
            </span>
          </div>
        )}
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
            {message && !error && (
              <span className="whitespace-pre-line text-xs leading-snug text-emerald-300">
                {message}
              </span>
            )}
            {trackToast && <span className="text-xs text-sky-300">{trackToast}</span>}
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

        {analysisError && (
          <AnalysisErrorBanner
            err={analysisError}
            onRetry={() => {
              // Pass 3 retries from the existing pass2 results merged
              // into `results`; pass2 retry replays the whole thing.
              setAnalysisError(null);
              runAnalysis();
            }}
            onDismiss={() => setAnalysisError(null)}
          />
        )}
        {!analysisError && error && (
          <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-200">
            <div className="mb-1 flex items-center gap-2 font-medium">
              <AlertTriangle className="h-4 w-4" /> {error}
            </div>
          </div>
        )}

        {results && results.length > 0 && screenedAt && !busy && (
          <HydrationBanner screenedAt={screenedAt} onRefresh={screenToday} />
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
                  <TableHead className="w-14 text-xs text-muted-foreground">Track</TableHead>
                  <SortableHeader
                    label="Grade"
                    active={sortKey === "grade"}
                    dir={sortDir}
                    onClick={() => onSort("grade")}
                    tooltip={
                      <>
                        Three-layer final grade: Industry (POP, IV edge, term, opp) +
                        Your history (win rate, ROC) + Regime (news, VIX). A ≥ 80,
                        B ≥ 65, C ≥ 50, F &lt; 50.
                      </>
                    }
                  />
                  <SortableHeader label="Symbol" active={sortKey === "symbol"} dir={sortDir} onClick={() => onSort("symbol")} />
                  <SortableHeader label="Price" active={sortKey === "price"} dir={sortDir} onClick={() => onSort("price")} />
                  <TableHead>Earnings</TableHead>
                  <SortableHeader label="DTE" active={sortKey === "dte"} dir={sortDir} onClick={() => onSort("dte")} />
                  <SortableHeader
                    label="EM%"
                    active={sortKey === "em"}
                    dir={sortDir}
                    onClick={() => onSort("em")}
                    tooltip={
                      <>
                        Expected move used for strike calculation: IV-implied
                        weekly EM (weeklyIV × √(DTE/365)), or &ldquo;~X%&rdquo;
                        historical median when IV data is unavailable. 2× EM
                        is the strike distance below spot.
                      </>
                    }
                  />
                  <SortableHeader label="Q" active={sortKey === "stage2"} dir={sortDir} onClick={() => onSort("stage2")} />
                  <SortableHeader
                    label="Crush"
                    active={sortKey === "crush"}
                    dir={sortDir}
                    onClick={() => onSort("crush")}
                    tooltip={
                      <>
                        Stage 3 crush grade — quality of the IV-crush setup
                        (historical moves, consistency, term structure, IV edge,
                        surprise reliability). &ldquo;?&rdquo; = fewer than 3
                        historical earnings moves available.
                      </>
                    }
                  />
                  <SortableHeader
                    label="Opp."
                    active={sortKey === "opportunity"}
                    dir={sortDir}
                    onClick={() => onSort("opportunity")}
                    tooltip={
                      <>
                        Stage 4 opportunity grade — premium yield + delta.
                        Spread is no longer part of the score; shown as
                        informational only.
                      </>
                    }
                  />
                  <SortableHeader label="Strike" active={sortKey === "strike"} dir={sortDir} onClick={() => onSort("strike")} />
                  <SortableHeader label="Premium" active={sortKey === "premium"} dir={sortDir} onClick={() => onSort("premium")} />
                  <SortableHeader label="Delta" active={sortKey === "delta"} dir={sortDir} onClick={() => onSort("delta")} />
                  <SortableHeader label="Spread" active={sortKey === "spread"} dir={sortDir} onClick={() => onSort("spread")} />
                </TableRow>
              </TableHeader>
              <TableBody>
                {sortedResults.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={15} className="py-10 text-center text-sm text-muted-foreground">
                      No qualifying earnings today or tomorrow after filters.
                    </TableCell>
                  </TableRow>
                )}
                {sortedResults.map((r, idx) => {
                  const id = `${r.symbol}-${r.earningsDate}`;
                  const open = !!expanded[id];
                  const displayedPrice = prices[r.symbol.toUpperCase()] ?? r.price;
                  const analyzingRow = analyzingSymbols.has(r.symbol.toUpperCase());
                  const showDivider = group1Count !== null && idx === group1Count && idx > 0;
                  return (
                    <>
                      {showDivider && (
                        <TableRow key={`divider-${idx}`} className="hover:bg-transparent">
                          <TableCell
                            colSpan={15}
                            className="bg-amber-500/10 py-1.5 text-center text-xs italic text-amber-300/90"
                          >
                            <AlertTriangle className="mr-1.5 inline h-3 w-3" />
                            Outside screener criteria — use caution
                          </TableCell>
                        </TableRow>
                      )}
                      <TableRow key={id} className="h-[52px] cursor-pointer" onClick={() => toggle(id)}>
                        <TableCell>
                          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                        </TableCell>
                        <TableCell onClick={(e) => e.stopPropagation()}>
                          <input
                            type="checkbox"
                            checked={tracked.has(r.symbol.toUpperCase())}
                            onChange={() => toggleTracked(r.symbol)}
                            className="h-6 w-6 cursor-pointer rounded border-border bg-background"
                            aria-label={`Track ${r.symbol}`}
                          />
                        </TableCell>
                        <TableCell>
                          {r.threeLayer ? (
                            <span
                              className={cn(
                                "rounded-md border px-3 py-1 text-sm font-bold",
                                finalGradeBadgeColor(r.threeLayer.finalGrade),
                              )}
                            >
                              {r.threeLayer.finalGrade}
                            </span>
                          ) : (
                            <span className="text-sm text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell className="text-[15px] font-bold">
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
                        <TableCell className="text-sm">{fmtPrice(displayedPrice)}</TableCell>
                        <TableCell className="text-xs">
                          {r.earningsDate} <span className="text-muted-foreground">· {r.earningsTiming}</span>
                        </TableCell>
                        <TableCell className="text-sm">{r.daysToExpiry}</TableCell>
                        <TableCell className="font-mono text-sm">
                          {(() => {
                            const em = r.stageThree?.details?.expectedMovePct;
                            if (em !== null && em !== undefined) {
                              return `${(em * 100).toFixed(1)}%`;
                            }
                            const hist = r.stageThree?.details?.medianHistoricalMovePct;
                            if (hist !== null && hist !== undefined) {
                              return (
                                <span className="text-muted-foreground">
                                  ~{(hist * 100).toFixed(1)}%
                                </span>
                              );
                            }
                            return "—";
                          })()}
                        </TableCell>
                        <TableCell className="font-mono text-sm">
                          {r.stageTwo ? `${r.stageTwo.score}` : "—"}
                        </TableCell>
                        <TableCell className={cn("font-mono text-sm", gradeColor(displayCrushGrade(r.stageThree)))}>
                          {analyzingRow ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : displayCrushGrade(r.stageThree)}
                        </TableCell>
                        <TableCell className={cn("font-mono text-sm", gradeColor(r.stageFour?.opportunityGrade))}>
                          {analyzingRow ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : (r.stageFour?.opportunityGrade ?? "—")}
                        </TableCell>
                        <TableCell className="text-sm">{r.stageFour?.suggestedStrike ? `$${fmtNum(r.stageFour.suggestedStrike)}` : "—"}</TableCell>
                        <TableCell className="text-sm">
                          {r.stageFour?.premium !== null && r.stageFour?.premium !== undefined
                            ? `$${fmtNum(r.stageFour.premium)}`
                            : "—"}
                        </TableCell>
                        <TableCell className="text-sm">{fmtNum(r.stageFour?.delta ?? null, 3)}</TableCell>
                        <TableCell className="text-sm">
                          {r.stageFour?.bidAskSpreadPct !== null && r.stageFour?.bidAskSpreadPct !== undefined
                            ? `${fmtNum(r.stageFour.bidAskSpreadPct, 1)}%`
                            : "—"}
                        </TableCell>
                      </TableRow>
                      {open && (
                        <TableRow key={`${id}-detail`}>
                          <TableCell colSpan={15} className="bg-muted/30">
                            <ExpandedDetail
                              r={r}
                              analyzing={analyzingSymbols.has(r.symbol.toUpperCase())}
                              onAnalyze={connected ? runAnalysisSingle : null}
                            />
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

      </div>
    </TooltipProvider>
  );
}

function SortableHeader({
  label,
  active,
  dir,
  onClick,
  tooltip,
}: {
  label: string;
  active: boolean;
  dir: "asc" | "desc";
  onClick: () => void;
  tooltip?: React.ReactNode;
}) {
  const inner = (
    <span className="inline-flex items-center gap-1">
      {label}
      {active && (dir === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)}
    </span>
  );
  return (
    <TableHead
      onClick={onClick}
      className="cursor-pointer select-none whitespace-nowrap hover:text-foreground"
    >
      {tooltip ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex cursor-help items-center gap-1">
              {label}
              {active && (dir === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)}
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-sm text-xs">{tooltip}</TooltipContent>
        </Tooltip>
      ) : (
        inner
      )}
    </TableHead>
  );
}

function gradeBadgeColor(g: string | null | undefined): string {
  if (g === "A") return "border-emerald-500/40 text-emerald-300 bg-emerald-500/10";
  if (g === "B") return "border-sky-500/40 text-sky-300 bg-sky-500/10";
  if (g === "C") return "border-amber-500/40 text-amber-300 bg-amber-500/10";
  if (g === "F") return "border-rose-500/40 text-rose-300 bg-rose-500/10";
  return "border-border text-muted-foreground bg-background/40";
}

function GradeBadge({
  grade,
  tooltip,
  size = "sm",
}: {
  grade: string | null | undefined;
  tooltip?: React.ReactNode;
  size?: "sm" | "md";
}) {
  const sizing = size === "md" ? "px-3 py-1 text-sm font-bold" : "px-1.5 py-0.5 font-mono";
  const badge = (
    <span className={cn("rounded border", sizing, gradeBadgeColor(grade))}>
      {grade ?? "?"}
    </span>
  );
  if (!tooltip) return badge;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="cursor-help">{badge}</span>
      </TooltipTrigger>
      <TooltipContent className="max-w-sm text-xs">{tooltip}</TooltipContent>
    </Tooltip>
  );
}

// Client-side replica of the rule cascade in lib/screener.ts so the
// CustomStrikeAnalyzer can preview a grade impact without round-tripping
// the server. Keep in sync with calculateThreeLayerGrade().
function dropGradeClient(g: "A" | "B" | "C" | "F"): "A" | "B" | "C" | "F" {
  if (g === "A") return "B";
  if (g === "B") return "C";
  return "F";
}
function boostGradeClient(g: "A" | "B" | "C" | "F"): "A" | "B" | "C" | "F" {
  if (g === "F") return "C";
  if (g === "C") return "B";
  return "A";
}

function gradeFromRulesClient(params: {
  pop: number;
  crushGrade: "A" | "B" | "C" | "F";
  opportunityGrade: "A" | "B" | "C" | "F";
  hasOverhang: boolean;
  vix: number | null;
  penalty: number;
  personalModifier: "boost" | "drop" | null;
}): "A" | "B" | "C" | "F" {
  const { pop, crushGrade, opportunityGrade, hasOverhang, vix, penalty, personalModifier } = params;
  const crushOk = crushGrade === "A" || crushGrade === "B";
  let grade: "A" | "B" | "C" | "F";
  if (crushOk && pop >= 0.9 && opportunityGrade !== "F" && !hasOverhang && (vix === null || vix < 25)) {
    grade = "A";
  } else if (pop >= 0.83 && (crushOk || pop >= 0.95) && !hasOverhang) {
    grade = "B";
  } else if (pop >= 0.75 && penalty > -15) {
    grade = "C";
  } else {
    grade = "F";
  }
  if (hasOverhang) grade = "F";
  else if (vix !== null && vix > 30) grade = dropGradeClient(grade);
  if (!hasOverhang) {
    if (personalModifier === "boost") grade = boostGradeClient(grade);
    else if (personalModifier === "drop") grade = dropGradeClient(grade);
  }
  return grade;
}

type CustomStrikeAnalysis = {
  strike: number;
  distancePct: number;
  pop: number;
  premium: number;
  delta: number;
  breakeven: number;
  finalGradeNew: "A" | "B" | "C" | "F";
};

function ExpandedDetail({
  r,
  analyzing,
  onAnalyze,
}: {
  r: ScreenerResult;
  analyzing: boolean;
  onAnalyze: ((symbol: string) => Promise<void>) | null;
}) {
  const tl = r.threeLayer;
  if (!tl) {
    // Before Run Analysis has populated threeLayer, fall back to the
    // Stage-1/2 detail cards — Stage 1 + Stage 2 still run during Screen
    // Today so the user has SOMETHING to look at pre-analysis.
    return (
      <div className="space-y-3 p-3">
        {onAnalyze && (
          <div className="flex items-center justify-between rounded border border-amber-500/30 bg-amber-500/5 px-3 py-2">
            <div className="text-xs text-amber-200">
              Three-layer grade not yet computed for {r.symbol}.
            </div>
            <Button
              size="sm"
              onClick={() => onAnalyze(r.symbol)}
              disabled={analyzing}
            >
              {analyzing ? (
                <>
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                  Analyzing…
                </>
              ) : (
                <>
                  <Sparkles className="mr-1 h-3.5 w-3.5" />
                  Analyze {r.symbol}
                </>
              )}
            </Button>
          </div>
        )}
        <div className="grid gap-4 md:grid-cols-2">
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
                <Row k="Industry class" v={r.stageTwo.details.industryClass} />
              </>
            )}
          </StageCard>
          <div className="text-xs text-muted-foreground md:col-span-2">
            Click <span className="font-medium">Run Analysis</span> at the top
            of the table to grade every candidate, or use the per-symbol
            button above for just {r.symbol}.
          </div>
        </div>
      </div>
    );
  }

  // Derive the personal-history modifier (needed by the custom-strike
  // analyzer to re-run the rule cascade client-side).
  const pf = tl.personalFactors;
  const personalModifier: "boost" | "drop" | null = (() => {
    if (pf.dataInsufficient || pf.tickerWinRate === null) return null;
    const wr = pf.tickerWinRate;
    const roc = pf.tickerAvgRoc ?? 0;
    if (wr > 80 && roc > 0.4) return "boost";
    if (wr < 50) return "drop";
    return null;
  })();

  // News-context fetch failure is the most common reason a user wants
  // to re-run a single symbol — surface a clearer CTA when that's the
  // case, otherwise keep the refresh link unobtrusive.
  const newsLooksFailed =
    /failed|could not|—/i.test(tl.regimeFactors.newsSummary ?? "") ||
    tl.regimeFactors.newsSummary.length < 8;

  return (
    <div className="space-y-3 p-3">
      {onAnalyze && (
        <div className="flex items-center justify-end">
          <button
            type="button"
            onClick={() => onAnalyze(r.symbol)}
            disabled={analyzing}
            className={cn(
              "inline-flex items-center gap-1 rounded px-2 py-1 text-xs transition",
              newsLooksFailed
                ? "border border-amber-500/40 bg-amber-500/10 text-amber-200 hover:bg-amber-500/20"
                : "text-muted-foreground hover:text-foreground",
              analyzing && "opacity-60",
            )}
          >
            {analyzing ? (
              <>
                <Loader2 className="h-3 w-3 animate-spin" />
                Analyzing…
              </>
            ) : (
              <>
                <RefreshCcw className="h-3 w-3" />
                {newsLooksFailed
                  ? `Re-analyze ${r.symbol} (news context missing)`
                  : `Refresh analysis`}
              </>
            )}
          </button>
        </div>
      )}
      <div className="grid gap-3 md:grid-cols-3">
        <LayerCard
          title="LAYER 1 — INDUSTRY STANDARD"
          grade={tl.industryGrade}
          tooltip={
            <div className="space-y-1">
              <div className="font-semibold">Industry factors</div>
              <div>POP {(tl.industryFactors.probabilityOfProfit * 100).toFixed(0)}% · Crush {tl.industryFactors.crushGrade}</div>
              <div>IV edge {tl.industryFactors.ivEdge.toFixed(2)} · Opp {tl.industryFactors.opportunityGrade}</div>
            </div>
          }
        >
          <CrushRow
            symbol={r.symbol}
            crushGrade={tl.industryFactors.crushGrade}
            emPct={r.stageThree?.details?.expectedMovePct ?? null}
            medianHistoricalMovePct={r.stageThree?.details?.medianHistoricalMovePct ?? null}
            currentPrice={r.price}
          />
          <Row k="Opportunity" v={`${tl.industryFactors.opportunityGrade}`} />
          <Row
            k="Prob of profit"
            v={`${(tl.industryFactors.probabilityOfProfit * 100).toFixed(0)}%`}
          />
          <Row k="IV edge" v={tl.industryFactors.ivEdge.toFixed(2)} />
          <Row k="Term" v={`${tl.industryFactors.termStructure}/5`} />
          <Row
            k="Expected value"
            v={`$${tl.industryFactors.expectedValue.toFixed(0)}/contract`}
          />
          <Row k="Breakeven" v={`$${tl.industryFactors.breakevenPrice.toFixed(2)}`} />
        </LayerCard>

        <LayerCard
          title="LAYER 2 — YOUR INTELLIGENCE"
          grade={tl.personalGrade === "INSUFFICIENT" ? "?" : tl.personalGrade}
          tooltip={
            tl.personalFactors.dataInsufficient ? (
              <div>
                Insufficient history — need 5+ closed trades on {r.symbol} (you have{" "}
                {tl.personalFactors.tickerTradeCount}). No modifier applied.
              </div>
            ) : (
              <div className="space-y-1">
                <div className="font-semibold">
                  Personal history
                  {personalModifier === "boost"
                    ? " → +1 grade"
                    : personalModifier === "drop"
                      ? " → −1 grade"
                      : ""}
                </div>
                <div>
                  {tl.personalFactors.tickerTradeCount} prior trades ·
                  {" "}
                  {tl.personalFactors.tickerWinRate !== null
                    ? `${tl.personalFactors.tickerWinRate.toFixed(0)}% win rate`
                    : "win rate n/a"}
                </div>
                <div>
                  Avg ROC{" "}
                  {tl.personalFactors.tickerAvgRoc !== null
                    ? `${tl.personalFactors.tickerAvgRoc.toFixed(2)}%`
                    : "n/a"}
                </div>
                <div className="pt-1 text-muted-foreground">
                  Boost if wr &gt;80% & roc &gt;0.4%. Drop if wr &lt;50%.
                </div>
              </div>
            )
          }
        >
          {tl.personalFactors.dataInsufficient ? (
            <div className="text-xs text-muted-foreground">
              Insufficient data — need 5+ trades on {r.symbol} (you have {tl.personalFactors.tickerTradeCount})
            </div>
          ) : (
            <>
              <Row k={`${r.symbol} trades logged`} v={String(tl.personalFactors.tickerTradeCount)} />
              <Row
                k="Win rate"
                v={
                  tl.personalFactors.tickerWinRate !== null
                    ? `${tl.personalFactors.tickerWinRate.toFixed(0)}%`
                    : "—"
                }
              />
              <Row
                k="Avg ROC"
                v={
                  tl.personalFactors.tickerAvgRoc !== null
                    ? `${tl.personalFactors.tickerAvgRoc.toFixed(2)}%`
                    : "—"
                }
              />
              <Row
                k="Sample"
                v={tl.personalFactors.tickerTradeCount >= 20 ? "robust" : "small"}
              />
            </>
          )}
        </LayerCard>

        <LayerCard
          title="LAYER 3 — CURRENT REGIME"
          grade={tl.regimeGrade}
          tooltip={
            <div className="space-y-1">
              <div className="font-semibold">Regime factors</div>
              <div>Sentiment: {tl.regimeFactors.newsSentiment}</div>
              <div>
                VIX{" "}
                {tl.regimeFactors.vix !== null ? tl.regimeFactors.vix.toFixed(1) : "n/a"}{" "}
                ({tl.regimeFactors.vixRegime ?? "—"})
              </div>
              {tl.regimeFactors.hasActiveOverhang && (
                <div className="text-rose-300">
                  Overhang: {tl.regimeFactors.overhangDescription} (forces F)
                </div>
              )}
              {tl.regimeFactors.vix !== null && tl.regimeFactors.vix > 30 && (
                <div className="text-amber-300">VIX &gt; 30 → drops final grade one level.</div>
              )}
            </div>
          }
        >
          <Row
            k="News sentiment"
            v={tl.regimeFactors.newsSentiment}
          />
          <Row
            k="VIX"
            v={
              tl.regimeFactors.vix !== null
                ? `${tl.regimeFactors.vix.toFixed(1)} (${tl.regimeFactors.vixRegime ?? "—"})`
                : "—"
            }
          />
          {tl.regimeFactors.hasActiveOverhang && (
            <div className="mt-2 rounded border border-rose-500/40 bg-rose-500/10 px-2 py-1 text-xs text-rose-300">
              <AlertTriangle className="mr-1 inline h-3 w-3" />
              Active overhang: {tl.regimeFactors.overhangDescription ?? "see news"}
              {" "}({tl.regimeFactors.gradePenalty}pts)
            </div>
          )}
          {!tl.regimeFactors.hasActiveOverhang && tl.regimeFactors.gradePenalty !== 0 && (
            <div className="mt-2 text-xs text-amber-300">
              Penalty {tl.regimeFactors.gradePenalty}pts
            </div>
          )}
          <div className="mt-2 text-[11px] text-muted-foreground">
            {tl.regimeFactors.newsSummary}
          </div>
        </LayerCard>
      </div>

      <OptionsFlowSection flow={r.stageThree?.details?.optionsFlow ?? null} />

      <CrushHistoryTable
        events={r.stageThree?.details?.crushHistory}
        todayEmPct={r.stageThree?.details?.expectedMovePct ?? null}
        todaySymbol={r.symbol}
        todayEarningsDate={r.earningsDate}
      />

      <CustomStrikeAnalyzer
        suggestedStrike={tl.industryFactors.breakevenPrice + (r.stageFour?.premium ?? 0)}
        currentPrice={r.price}
        availableStrikes={r.stageFour?.availableStrikes}
        crushGrade={tl.industryFactors.crushGrade}
        opportunityGrade={tl.industryFactors.opportunityGrade}
        hasOverhang={tl.regimeFactors.hasActiveOverhang}
        vix={tl.regimeFactors.vix}
        penalty={tl.regimeFactors.gradePenalty}
        personalModifier={personalModifier}
        currentFinalGrade={tl.finalGrade}
      />

      <div className="rounded-md border border-border bg-background/40 p-3">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-muted-foreground">FINAL GRADE:</span>
          <GradeBadge
            grade={tl.finalGrade}
            size="md"
            tooltip={
              <div className="space-y-1">
                <div className="font-semibold">Rule-based grade</div>
                <div>A: crush A/B · POP ≥ 90% · opp ≠ F · no overhang · VIX &lt; 25</div>
                <div>B: POP ≥ 83% and (crush A/B or POP ≥ 95%), no overhang</div>
                <div>C: POP ≥ 75% and penalty &gt; −15</div>
                <div className="pt-1 text-muted-foreground">
                  Overrides: overhang → F · VIX &gt; 30 drops one level · personal wr &gt;80%+roc &gt;0.4% boosts · wr &lt;50% drops
                </div>
              </div>
            }
          />
        </div>
        <div className="mt-3 space-y-2 text-xs leading-relaxed text-muted-foreground">
          {tl.recommendationReason.split("\n\n").map((para, i) => {
            const sep = para.indexOf(": ");
            if (sep === -1) return <div key={i}>{para}</div>;
            return (
              <div key={i}>
                <span className="font-semibold text-foreground">
                  {para.slice(0, sep + 1)}
                </span>{" "}
                <span>{para.slice(sep + 2)}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function CustomStrikeAnalyzer({
  suggestedStrike,
  currentPrice,
  availableStrikes,
  crushGrade,
  opportunityGrade,
  hasOverhang,
  vix,
  penalty,
  personalModifier,
  currentFinalGrade,
}: {
  suggestedStrike: number;
  currentPrice: number;
  availableStrikes: StageFourResult["availableStrikes"];
  crushGrade: "A" | "B" | "C" | "F";
  opportunityGrade: "A" | "B" | "C" | "F";
  hasOverhang: boolean;
  vix: number | null;
  penalty: number;
  personalModifier: "boost" | "drop" | null;
  currentFinalGrade: "A" | "B" | "C" | "F";
}) {
  const [input, setInput] = useState("");
  const [result, setResult] = useState<CustomStrikeAnalysis | null>(null);

  const strikes = availableStrikes ?? [];

  function analyze() {
    const parsed = Number(input);
    if (!Number.isFinite(parsed) || parsed <= 0 || strikes.length === 0) {
      setResult(null);
      return;
    }
    // Snap to the closest strike the chain actually exposes.
    let nearest = strikes[0];
    let bestDiff = Math.abs(strikes[0].strike - parsed);
    for (const s of strikes) {
      const d = Math.abs(s.strike - parsed);
      if (d < bestDiff) {
        nearest = s;
        bestDiff = d;
      }
    }
    const pop = 1 - Math.abs(nearest.delta);
    const premium = nearest.mark;
    const breakeven = nearest.strike - premium;
    const distancePct =
      currentPrice > 0 ? ((currentPrice - nearest.strike) / currentPrice) * 100 : 0;

    const finalGradeNew = gradeFromRulesClient({
      pop,
      crushGrade,
      opportunityGrade,
      hasOverhang,
      vix,
      penalty,
      personalModifier,
    });
    setResult({
      strike: nearest.strike,
      distancePct,
      pop,
      premium,
      delta: nearest.delta,
      breakeven,
      finalGradeNew,
    });
  }

  return (
    <div className="rounded-md border border-border bg-background/40 p-3 text-xs">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-muted-foreground">
          Suggested:{" "}
          <span className="text-foreground">${suggestedStrike.toFixed(2)}</span>{" "}
          <span className="text-muted-foreground">(2x EM)</span>
        </span>
        <span className="text-muted-foreground">·</span>
        <label className="flex items-center gap-2">
          <span className="text-muted-foreground">Try:</span>
          <input
            type="number"
            step="0.5"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="strike"
            className="w-24 rounded border border-border bg-background px-2 py-1"
          />
        </label>
        <Button size="sm" variant="secondary" onClick={analyze} disabled={strikes.length === 0}>
          Analyze
        </Button>
        {strikes.length === 0 && (
          <span className="text-muted-foreground">(no chain snapshot available)</span>
        )}
      </div>
      {result && (
        <div className="mt-3 rounded border border-border bg-muted/20 p-2">
          <div className="mb-1 font-medium">Custom Strike Analysis</div>
          <div className="grid grid-cols-2 gap-x-6 gap-y-0.5 font-mono md:grid-cols-3">
            <Row k="Strike" v={`$${result.strike.toFixed(2)}`} />
            <Row k="Distance" v={`${result.distancePct.toFixed(1)}% OTM`} />
            <Row k="Prob of profit" v={`${(result.pop * 100).toFixed(0)}%`} />
            <Row k="Premium" v={`$${result.premium.toFixed(2)}`} />
            <Row k="Delta" v={result.delta.toFixed(3)} />
            <Row k="Breakeven" v={`$${result.breakeven.toFixed(2)}`} />
          </div>
          <div className="mt-2 flex items-center gap-2 border-t border-border pt-2">
            <span className="text-muted-foreground">Grade impact:</span>
            <GradeBadge grade={currentFinalGrade} />
            <span className="text-muted-foreground">→</span>
            <GradeBadge grade={result.finalGradeNew} />
          </div>
        </div>
      )}
    </div>
  );
}


function LayerCard({
  title,
  grade,
  tooltip,
  children,
}: {
  title: string;
  grade: string | null | undefined;
  tooltip?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-md border border-border bg-background/40 p-3 text-xs">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          {title}
        </div>
        <GradeBadge grade={grade} tooltip={tooltip} />
      </div>
      <div className="space-y-0.5">{children}</div>
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

function AnalysisErrorBanner({
  err,
  onRetry,
  onDismiss,
}: {
  err: AnalysisError;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  const { title, detail, action } = describeAnalysisError(err);
  return (
    <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-200">
      <div className="mb-1 flex items-start gap-2 font-medium">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {title}
      </div>
      <div className="mb-2 ml-6 text-rose-200/80">{detail}</div>
      <div className="ml-6 flex flex-wrap items-center gap-2">
        {action === "retry" && (
          <Button size="sm" variant="outline" onClick={onRetry}>
            Retry {err.pass === "pass2" ? "Pass 2" : "Pass 3"}
          </Button>
        )}
        {action === "settings" && (
          <Button size="sm" variant="outline" asChild>
            <a href="/settings">Open Settings</a>
          </Button>
        )}
        {err.partialAvailable && (
          <span className="text-xs text-rose-200/70">
            ✓ Pass 2 grades already shown in the table — Pass 3 (news /
            regime / final grade) is missing.
          </span>
        )}
        {!err.partialAvailable && err.pass === "pass2" && (
          <span className="text-xs text-rose-200/70">
            Showing ungraded candidates — options data unavailable until
            Pass 2 succeeds.
          </span>
        )}
        <button
          type="button"
          onClick={onDismiss}
          className="ml-auto text-xs text-rose-200/60 hover:text-rose-200"
        >
          Dismiss
        </button>
      </div>
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

// Crush row with a hoverable label that explains the grade bands and
// shows today's emPct, implied dollar move, median historical, and
// computed ratio. Replaces the plain <Row k="Crush" /> in Layer 1.
function CrushRow({
  symbol,
  crushGrade,
  emPct,
  medianHistoricalMovePct,
  currentPrice,
}: {
  symbol: string;
  crushGrade: "A" | "B" | "C" | "F";
  emPct: number | null;
  medianHistoricalMovePct: number | null;
  currentPrice: number;
}) {
  const ratio =
    emPct !== null && emPct > 0 && medianHistoricalMovePct !== null
      ? medianHistoricalMovePct / emPct
      : null;
  const ratioGrade =
    ratio === null
      ? null
      : ratio < 0.7
        ? "A"
        : ratio < 0.85
          ? "B"
          : ratio < 1.0
            ? "C"
            : ratio < 1.2
              ? "D"
              : "F";
  const impliedDollar =
    emPct !== null && currentPrice > 0
      ? Math.round(emPct * currentPrice)
      : null;
  return (
    <div className="flex justify-between gap-2">
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="cursor-help text-muted-foreground underline decoration-dotted decoration-muted-foreground/60 underline-offset-4 hover:decoration-foreground/80">
            Crush
          </span>
        </TooltipTrigger>
        <TooltipContent side="right" className="max-w-[340px]">
          <div className="space-y-2 text-xs leading-relaxed">
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Crush rating
              </div>
              <div>
                Measures whether this stock&apos;s earnings moves stay
                within what options pricing implies.
              </div>
            </div>
            <div>
              <span className="font-mono">crush ratio = actual ÷ implied</span>{" "}
              · median across last 8 quarters → grade
            </div>
            <ul className="list-disc space-y-0.5 pl-4 font-mono text-[11px]">
              <li>
                <b>A</b> &lt; 0.70 — undershoots, best for sellers ✅
              </li>
              <li>
                <b>B</b> 0.70–0.85 — slight edge ✅
              </li>
              <li>
                <b>C</b> 0.85–1.00 — fairly priced
              </li>
              <li>
                <b>D</b> 1.00–1.20 — slight disadvantage ⚠️
              </li>
              <li>
                <b>F</b> &gt; 1.20 — overshoots, avoid ❌
              </li>
            </ul>
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                {symbol} today
              </div>
              <div className="font-mono text-[11px]">
                Implied move:{" "}
                {emPct !== null ? `${(emPct * 100).toFixed(1)}%` : "—"}
                {impliedDollar !== null && <> (~${impliedDollar})</>}
                <br />
                Median historical:{" "}
                {medianHistoricalMovePct !== null
                  ? `${(medianHistoricalMovePct * 100).toFixed(1)}%`
                  : "—"}
                <br />
                Crush ratio:{" "}
                {ratio !== null ? `${ratio.toFixed(2)}x` : "—"}
                {ratioGrade && <> → {ratioGrade}</>}
              </div>
            </div>
            <div className="border-t border-border pt-1.5 text-[10px] text-muted-foreground">
              ★ in the history table marks quarters with similar implied
              move to today (within ±2pp). Those are the most relevant
              comparisons for THIS trade.
            </div>
          </div>
        </TooltipContent>
      </Tooltip>
      <span className="font-mono text-foreground">{crushGrade}</span>
    </div>
  );
}

// Cross-device hydration banner. Tells the user where the results
// they're seeing came from — the most recent screener_results row in
// Supabase. Two states:
//   <24 h old  → green "Showing results from {time} — Run Analysis to refresh"
//   >=24 h old → amber "Last scan: {time} (stale) — Run Analysis to update"
function HydrationBanner({
  screenedAt,
  onRefresh,
}: {
  screenedAt: Date;
  onRefresh: () => void;
}) {
  const ageMs = Date.now() - screenedAt.getTime();
  const stale = ageMs >= FRESH_WINDOW_MS;
  const sameDay = (() => {
    const today = new Date();
    return (
      today.getFullYear() === screenedAt.getFullYear() &&
      today.getMonth() === screenedAt.getMonth() &&
      today.getDate() === screenedAt.getDate()
    );
  })();
  const label = sameDay
    ? screenedAt.toLocaleTimeString([], {
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      })
    : screenedAt.toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      });
  const cls = stale
    ? "border-amber-500/30 bg-amber-500/10 text-amber-200"
    : "border-emerald-500/30 bg-emerald-500/10 text-emerald-200";
  return (
    <div
      className={`flex flex-wrap items-center justify-between gap-2 rounded-lg border ${cls} px-3 py-2 text-xs`}
    >
      <span>
        {stale ? (
          <>
            Last scan:{" "}
            <span className="font-mono">{label}</span>
            <span className="ml-1 rounded border border-amber-500/40 bg-amber-500/15 px-1 py-0.5 text-[10px] font-semibold uppercase">
              stale
            </span>{" "}
            — Run Analysis to update.
          </>
        ) : (
          <>
            Showing results from{" "}
            <span className="font-mono">{label}</span> — Run Analysis to
            refresh.
          </>
        )}
      </span>
      <button
        type="button"
        onClick={onRefresh}
        className="rounded border border-current bg-transparent px-2 py-0.5 text-[11px] font-medium hover:bg-current/10"
      >
        Run Analysis
      </button>
    </div>
  );
}

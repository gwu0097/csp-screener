"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Play,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  History,
  Loader2,
  Pencil,
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
import type { PerplexityNewsResult } from "@/lib/perplexity";
import type { MarketContext } from "@/lib/market";
import { CrushHistoryTable } from "@/components/crush-history-table";
import { OptionsFlowSection } from "@/components/options-flow-section";
import { ErrorBanner } from "@/components/error-banner";
import {
  interpretError,
  interpretFetchError,
  type InterpretedError,
} from "@/lib/errors";

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
  | "yield"
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

// CSP yield = premium / strike, expressed as a percent. The denominator
// is strike (capital at risk for a cash-secured put) rather than spot,
// so a $5 premium on a $500 strike reads 1.00%, the same number a
// trader would compute when sizing the trade.
function csPYieldPct(
  premium: number | null | undefined,
  strike: number | null | undefined,
): number | null {
  if (
    premium === null ||
    premium === undefined ||
    !Number.isFinite(premium) ||
    strike === null ||
    strike === undefined ||
    !Number.isFinite(strike) ||
    strike <= 0
  ) {
    return null;
  }
  return (premium / strike) * 100;
}
function fmtYield(
  premium: number | null | undefined,
  strike: number | null | undefined,
): string {
  const y = csPYieldPct(premium, strike);
  if (y === null) return "—";
  return `${y.toFixed(2)}%`;
}
function yieldColor(
  premium: number | null | undefined,
  strike: number | null | undefined,
): string {
  const y = csPYieldPct(premium, strike);
  if (y === null) return "text-muted-foreground";
  if (y > 0.5) return "text-emerald-300";
  if (y >= 0.2) return "text-foreground";
  return "text-muted-foreground";
}

// % Drop to Strike — how far the stock has to fall before breaching
// the put. (price − strike) / price × 100. Inverse to yield: more
// drop = safer cushion.
function pctDrop(
  price: number | null | undefined,
  strike: number | null | undefined,
): number | null {
  if (
    price === null || price === undefined || !Number.isFinite(price) || price <= 0 ||
    strike === null || strike === undefined || !Number.isFinite(strike)
  ) {
    return null;
  }
  return ((price - strike) / price) * 100;
}
function fmtPctDrop(
  price: number | null | undefined,
  strike: number | null | undefined,
): string {
  const d = pctDrop(price, strike);
  if (d === null) return "—";
  return `${d.toFixed(1)}%`;
}
function pctDropColor(
  price: number | null | undefined,
  strike: number | null | undefined,
): string {
  const d = pctDrop(price, strike);
  if (d === null) return "text-muted-foreground";
  if (d > 20) return "text-emerald-300";
  if (d >= 15) return "text-foreground";
  if (d >= 10) return "text-amber-300";
  return "text-rose-300";
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
const LS_GRADED = "screener_graded";

// Adaptive batch sizing — each stream has its own LS key. On a
// successful run the size persists; on a failure (typically a 60s
// timeout) the client halves it and retries the same batch with the
// smaller size. resetBatchSizes() is called on Screen Today so a
// fresh trading day starts with the defaults.
type StreamKey = "perplexity" | "edgar";
const LS_BATCH_SIZE: Record<StreamKey, string> = {
  perplexity: "screener_batch_perplexity",
  edgar: "screener_batch_edgar",
};
const DEFAULT_BATCH_SIZES: Record<StreamKey, number> = {
  perplexity: 10,
  edgar: 5,
};

function getAdaptiveBatchSize(key: StreamKey): number {
  if (typeof window === "undefined") return DEFAULT_BATCH_SIZES[key];
  try {
    const raw = localStorage.getItem(LS_BATCH_SIZE[key]);
    if (raw === null) return DEFAULT_BATCH_SIZES[key];
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 1) return DEFAULT_BATCH_SIZES[key];
    return Math.floor(n);
  } catch {
    return DEFAULT_BATCH_SIZES[key];
  }
}
function setAdaptiveBatchSize(key: StreamKey, n: number) {
  try {
    if (typeof window !== "undefined") {
      localStorage.setItem(LS_BATCH_SIZE[key], String(n));
    }
  } catch {
    /* quota / privacy */
  }
}
function reduceAdaptiveBatchSize(key: StreamKey): number {
  const current = getAdaptiveBatchSize(key);
  const next = Math.max(1, Math.floor(current / 2));
  setAdaptiveBatchSize(key, next);
  return next;
}
function resetBatchSizes() {
  try {
    if (typeof window !== "undefined") {
      localStorage.removeItem(LS_BATCH_SIZE.perplexity);
      localStorage.removeItem(LS_BATCH_SIZE.edgar);
    }
  } catch {
    /* ignore */
  }
}

// Cross-device hydration freshness window. Anything older shows the
// "stale — Run Analysis to update" banner instead of the green one.
const FRESH_WINDOW_MS = 24 * 60 * 60 * 1000;

function clearStoredScreen() {
  try {
    if (typeof window === "undefined") return;
    window.localStorage.removeItem(LS_RESULTS);
    window.localStorage.removeItem(LS_TIMESTAMP);
    window.localStorage.removeItem(LS_PRICES);
    window.localStorage.removeItem(LS_GRADED);
  } catch {
    // ignore — quota / privacy mode
  }
}

// Writes the latest screener snapshot to localStorage AND fires a
// background POST to /api/screener/results/save so the result is
// available cross-device. The Supabase write is best-effort —
// localStorage is the authoritative store on the originating device,
// the DB row exists for hydration on every other device.
//
// `graded` distinguishes Screen Today output (Stage 1+2 filters
// only) from Run Analysis output (Stage 3 + 4 grades attached). The
// hydration banner uses this to tell the user whether they need to
// re-run analysis on the cached row.
function persistScreenSnapshot(args: {
  candidates: ScreenerResult[];
  prices: Record<string, number>;
  screenedAt: string;
  graded: boolean;
  pass1Count?: number | null;
  pass2Count?: number | null;
  vix?: number | null;
}) {
  try {
    if (typeof window !== "undefined") {
      localStorage.setItem(LS_RESULTS, JSON.stringify(args.candidates));
      localStorage.setItem(LS_TIMESTAMP, args.screenedAt);
      localStorage.setItem(LS_PRICES, JSON.stringify(args.prices));
      localStorage.setItem(LS_GRADED, args.graded ? "true" : "false");
    }
  } catch (e) {
    console.error("[screener] localStorage save failed", e);
  }
  // Fire-and-forget: failure here doesn't block the UI; the next
  // mount on this device will still hydrate from localStorage. But
  // we DO inspect res.ok — a missing migration / 500 response would
  // otherwise be silently swallowed by .catch(), which historically
  // hid the "screener_results table doesn't exist" failure mode.
  void (async () => {
    try {
      const res = await fetch("/api/screener/results/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          candidates: args.candidates,
          screenedAt: args.screenedAt,
          prices: args.prices,
          pass1Count: args.pass1Count ?? null,
          pass2Count: args.pass2Count ?? null,
          vix: args.vix ?? null,
          graded: args.graded,
        }),
        cache: "no-store",
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        console.error(
          `[screener] /api/screener/results/save returned HTTP ${res.status}. Body: ${body.slice(0, 240)}. ` +
            `Cross-device hydration will not work until this is fixed — ` +
            `most common cause: db/migrations/010_screener_results.sql has not been applied to Supabase.`,
        );
        return;
      }
      console.log(
        `[screener] saved ${args.candidates.length} candidates to DB at ${args.screenedAt} (graded=${args.graded})`,
      );
    } catch (e) {
      console.error("[screener] remote save threw (network):", e);
    }
  })();
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
  // Whether the currently-rendered candidate list carries Stage 3 + 4
  // analysis grades. Drives the cross-device hydration banner copy.
  // Flips to true when Run Analysis completes; stays false after a
  // bare Screen Today or applyWatchlist (which can introduce new
  // ungraded rows).
  const [screenIsGraded, setScreenIsGraded] = useState<boolean>(false);
  // Two-stream Pass 3 state. After Pass 2 lands, the client kicks
  // off an independent News stream (Perplexity, /api/screener/
  // analyze/pass3a) and a Grade stream (personal history + three-
  // layer grade + post-actions, /api/screener/analyze/pass3b). Each
  // stream batches the candidate list, halves its batch size on
  // timeout, and drains its own pending-key set so the resume
  // buttons can replay just the leftovers.
  //
  // A stock's final grade lights up only after BOTH streams have
  // returned data for that stock — pass3b uses pass3a's news as
  // the regime-factors input.
  const [pendingNewsKeys, setPendingNewsKeys] = useState<Set<string>>(
    new Set(),
  );
  const [pendingGradeKeys, setPendingGradeKeys] = useState<Set<string>>(
    new Set(),
  );
  // Per-stream UI progress. Updated at every batch boundary so the
  // panel can render bars + current-batch symbols.
  type StreamProgress = {
    done: number;
    total: number;
    batchSize: number;
    batchIndex: number;
    batchTotal: number;
    sample: string[];
    reduced: boolean;
  };
  const [newsProgress, setNewsProgress] = useState<StreamProgress | null>(null);
  const [gradeProgress, setGradeProgress] = useState<StreamProgress | null>(
    null,
  );
  const [analysisVix, setAnalysisVix] = useState<number | null>(null);
  // Probed on mount from /api/screener/results/latest (no state
  // hydration — population happens only when the user clicks Load
  // Previous). Null = no previous result, or probe still in flight.
  const [previousAvailable, setPreviousAvailable] = useState<{
    screenedAt: string;
    count: number;
    graded: boolean;
  } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<
    { err: InterpretedError; retry?: () => void | Promise<void> } | null
  >(null);
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
  // Per-row strike overrides applied via inline-edit. Snapshots premium /
  // delta / spread% from the chosen entry in stageFour.availableStrikes
  // so subsequent re-renders don't have to rerun the lookup. Cleared
  // implicitly by Apply Watchlist / Run Analysis (orphan keys are
  // harmless; the table reads via key lookup).
  const [strikeOverrides, setStrikeOverrides] = useState<
    Record<
      string,
      { strike: number; premium: number; delta: number; bidAskSpreadPct: number }
    >
  >({});
  // Transient toast for Track confirmations. One line above the table.
  const [trackToast, setTrackToast] = useState<string | null>(null);
  // Stream C (chain verification) progress strip — populated while
  // batches stream in, cleared a few seconds after completion.
  const [chainProgress, setChainProgress] = useState<
    { done: number; total: number; phase: "verifying" | "done" } | null
  >(null);
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

    // Adaptive batch sizes are deliberately session-scoped. A run
    // that ended with size=1 yesterday because Perplexity was slow
    // shouldn't penalize today's run, and the next page load IS
    // the next session boundary. Clear them here so a refresh
    // always starts both streams at their full default size.
    resetBatchSizes();

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

  // Mount auto-restore. A page refresh shouldn't lose the table
  // the user just looked at — but a stale row (>24h) shouldn't
  // hide the empty-state either. Two paths:
  //   fresh (<24h): populate state silently. No banner, no
  //                 message — refresh feels like nothing happened.
  //   stale (>=24h): leave state empty; only record availability
  //                  so the Load Previous button can offer it
  //                  explicitly.
  // Either way, previousAvailable is set so Load Previous remains
  // available for cross-device refreshes (other tab ran a scan,
  // this tab wants to pick it up without a full reload).
  useEffect(() => {
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
          graded?: boolean;
        };
        if (cancelled) return;
        if (!json.screenedAt || !Array.isArray(json.candidates) || json.candidates.length === 0) {
          return;
        }
        setPreviousAvailable({
          screenedAt: json.screenedAt,
          count: json.candidates.length,
          graded: json.graded === true,
        });
        const ageMs = Date.now() - new Date(json.screenedAt).getTime();
        if (ageMs >= FRESH_WINDOW_MS) {
          // Stale — don't auto-populate. Empty state stays.
          return;
        }
        const parsed = json.candidates
          .map((r) => normaliseResult(r))
          .filter((r): r is ScreenerResult => r !== null);
        if (parsed.length === 0) return;
        setResults(parsed);
        setPrices(json.prices ?? {});
        setScreenedAt(new Date(json.screenedAt));
        setScreenIsGraded(json.graded === true);
        setGroupMode(null);
        // Sync localStorage so subsequent in-session edits read
        // from a consistent baseline. No banner, no message — this
        // is a silent restore.
        try {
          localStorage.setItem(LS_RESULTS, JSON.stringify(parsed));
          localStorage.setItem(LS_TIMESTAMP, json.screenedAt);
          localStorage.setItem(LS_PRICES, JSON.stringify(json.prices ?? {}));
          localStorage.setItem(
            LS_GRADED,
            json.graded === true ? "true" : "false",
          );
        } catch (e) {
          console.warn("[screener] LS seed after silent restore failed", e);
        }
      } catch (e) {
        console.warn("[screener] /latest mount fetch failed", e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function loadPrevious() {
    setError(null);
    setMessage(null);
    setStatus("screening");
    try {
      const res = await fetch("/api/screener/results/latest", {
        cache: "no-store",
      });
      const json = (await res.json()) as {
        screenedAt: string | null;
        candidates: Array<Partial<ScreenerResult> & { symbol?: string }>;
        prices: Record<string, number>;
        graded?: boolean;
        error?: string;
      };
      if (!res.ok || json.error) {
        throw new Error(json.error ?? `HTTP ${res.status}`);
      }
      if (!json.screenedAt || json.candidates.length === 0) {
        setMessage("No previous results saved.");
        return;
      }
      const parsed = json.candidates
        .map((r) => normaliseResult(r))
        .filter((r): r is ScreenerResult => r !== null);
      setResults(parsed);
      setPrices(json.prices ?? {});
      setScreenedAt(new Date(json.screenedAt));
      setScreenIsGraded(json.graded === true);
      setGroupMode(null);
      setExpanded({});
      // Sync localStorage so subsequent in-session edits (track toggles,
      // single-symbol re-analyze) read from a consistent baseline.
      try {
        localStorage.setItem(LS_RESULTS, JSON.stringify(parsed));
        localStorage.setItem(LS_TIMESTAMP, json.screenedAt);
        localStorage.setItem(LS_PRICES, JSON.stringify(json.prices ?? {}));
        localStorage.setItem(LS_GRADED, json.graded === true ? "true" : "false");
      } catch (e) {
        console.error("[screener] localStorage seed after Load Previous failed", e);
      }
      const ts = new Date(json.screenedAt).toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      });
      setMessage(`Loaded ${parsed.length} candidates from ${ts}`);
    } catch (e) {
      setError({
        err: interpretError(e, "Load Previous"),
        retry: () => loadPrevious(),
      });
    } finally {
      setStatus("idle");
    }
  }

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
        case "yield": {
          const yA =
            a.stageFour?.premium && a.stageFour?.suggestedStrike
              ? a.stageFour.premium / a.stageFour.suggestedStrike
              : -1;
          const yB =
            b.stageFour?.premium && b.stageFour?.suggestedStrike
              ? b.stageFour.premium / b.stageFour.suggestedStrike
              : -1;
          va = yA;
          vb = yB;
          break;
        }
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
    // A fresh trading day starts the adaptive batch sizes back at the
    // defaults — yesterday's reduced sizes (after a slow Perplexity
    // afternoon) shouldn't penalize today's run.
    resetBatchSizes();
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
    setChainProgress(null);
    try {
      // ---- Stream A: calendar + filters + Stage 1+2 scoring ----
      // Fast — 2-5s typical. Returns the full survivor list with
      // chain verification DEFERRED to /verify-chains so a Schwab
      // outage can't blank the board.
      setMessage("Fetching earnings calendar…");
      const r1 = await fetch("/api/screener/screen", {
        method: "POST",
        cache: "no-store",
      });
      const j1 = (await r1.json().catch(() => ({}))) as {
        results?: ScreenerResult[];
        prices?: Record<string, number>;
        screenedAt?: string;
        stats?: ScreenStats;
        error?: string;
      };
      if (!r1.ok || j1.error) {
        const interpreted = await interpretFetchError(
          new Response(JSON.stringify(j1), { status: r1.status }),
          "Screen Today",
        );
        setError({ err: interpreted, retry: () => screenToday() });
        setStatus("error");
        if (j1.stats) setLastStats(j1.stats);
        return;
      }
      const initialResults: ScreenerResult[] = j1.results ?? [];
      const initialPrices = j1.prices ?? {};
      const initialStats = j1.stats ?? null;
      const timestampIso = j1.screenedAt ?? new Date().toISOString();

      // Surface the result list IMMEDIATELY so the user sees
      // candidates while Stream C runs. Stage 1+2 grades are already
      // present; chain verification only adds a per-row badge and
      // drops verified-absent rows.
      setResults(initialResults);
      setPrices(initialPrices);
      setScreenedAt(new Date(timestampIso));
      setLastStats(initialStats);
      setGroupMode(null);
      setScreenIsGraded(false);
      setMessage(
        `Screened ${initialResults.length} candidates — verifying option chains…`,
      );

      // ---- Stream C: chain verification, batched ----
      const BATCH_SIZE = 10;
      const GLOBAL_TIMEOUT_MS = 45_000;
      const RETRY_BACKOFF_MS = 2_000;
      const startedAt = Date.now();
      const batches: ScreenerResult[][] = [];
      for (let i = 0; i < initialResults.length; i += BATCH_SIZE) {
        batches.push(initialResults.slice(i, i + BATCH_SIZE));
      }
      type VerifyRow = {
        symbol: string;
        status: "present" | "absent" | "unverified";
        reason?: string;
      };
      const verifyOnce = async (
        batch: ScreenerResult[],
      ): Promise<{ rows: VerifyRow[] | null; status: number | null }> => {
        try {
          const res = await fetch(
            "/api/screener/screen/verify-chains",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                candidates: batch.map((c) => ({
                  symbol: c.symbol,
                  date: c.earningsDate,
                  timing: c.earningsTiming,
                  price: c.price,
                })),
              }),
              cache: "no-store",
            },
          );
          if (!res.ok) return { rows: null, status: res.status };
          const json = (await res.json()) as { verifications?: VerifyRow[] };
          return { rows: json.verifications ?? [], status: res.status };
        } catch {
          return { rows: null, status: null };
        }
      };

      const dropSymbols = new Set<string>();
      let verifiedCount = 0;
      let absentCount = 0;
      let unverifiedCount = 0;
      let workingResults = [...initialResults];
      const isLatestRunRef = { current: true }; // guards against double-run races

      setChainProgress({
        done: 0,
        total: initialResults.length,
        phase: "verifying",
      });

      let timedOut = false;
      for (let b = 0; b < batches.length; b += 1) {
        if (Date.now() - startedAt > GLOBAL_TIMEOUT_MS) {
          timedOut = true;
          // Mark all remaining batches as unverified.
          for (let r = b; r < batches.length; r += 1) {
            for (const c of batches[r]) {
              workingResults = workingResults.map((row) =>
                row.symbol === c.symbol
                  ? ({ ...row, chainUnverified: true } as ScreenerResult)
                  : row,
              );
              unverifiedCount += 1;
            }
          }
          break;
        }
        const batch = batches[b];
        let attempt = await verifyOnce(batch);
        if (
          (!attempt.rows && attempt.status !== 401 && attempt.status !== 403) ||
          attempt.status === 504 ||
          attempt.status === 503 ||
          attempt.status === 429
        ) {
          await new Promise((res) => setTimeout(res, RETRY_BACKOFF_MS));
          attempt = await verifyOnce(batch);
        }
        const verifications = attempt.rows;
        if (!verifications) {
          // Two-attempt failure → mark all unverified, continue.
          for (const c of batch) {
            workingResults = workingResults.map((row) =>
              row.symbol === c.symbol
                ? ({ ...row, chainUnverified: true } as ScreenerResult)
                : row,
            );
            unverifiedCount += 1;
          }
        } else {
          const byKey = new Map(
            verifications.map((v) => [v.symbol.toUpperCase(), v]),
          );
          for (const c of batch) {
            const v = byKey.get(c.symbol.toUpperCase());
            if (!v || v.status === "unverified") {
              workingResults = workingResults.map((row) =>
                row.symbol === c.symbol
                  ? ({ ...row, chainUnverified: true } as ScreenerResult)
                  : row,
              );
              unverifiedCount += 1;
            } else if (v.status === "present") {
              workingResults = workingResults.map((row) =>
                row.symbol === c.symbol
                  ? ({ ...row, chainUnverified: false } as ScreenerResult)
                  : row,
              );
              verifiedCount += 1;
            } else {
              // verified_absent — drop unless whitelisted.
              absentCount += 1;
              if (!c.isWhitelisted) {
                dropSymbols.add(c.symbol.toUpperCase());
              } else {
                workingResults = workingResults.map((row) =>
                  row.symbol === c.symbol
                    ? ({ ...row, chainUnverified: false } as ScreenerResult)
                    : row,
                );
              }
            }
          }
        }
        // Push the running set into the table after each batch so
        // candidates appear / drop incrementally.
        const displayed = workingResults.filter(
          (r) => !dropSymbols.has(r.symbol.toUpperCase()),
        );
        if (isLatestRunRef.current) {
          setResults(displayed);
          setChainProgress({
            done: Math.min((b + 1) * BATCH_SIZE, initialResults.length),
            total: initialResults.length,
            phase: "verifying",
          });
        }
      }

      const finalResults = workingResults.filter(
        (r) => !dropSymbols.has(r.symbol.toUpperCase()),
      );
      setResults(finalResults);
      setChainProgress({
        done: initialResults.length,
        total: initialResults.length,
        phase: "done",
      });

      // Persist the final post-verification snapshot.
      persistScreenSnapshot({
        candidates: finalResults,
        prices: initialPrices,
        screenedAt: timestampIso,
        graded: false,
        pass1Count: initialStats?.afterPriceFilter ?? null,
        pass2Count: finalResults.length,
      });
      setStatus("idle");
      const tail =
        absentCount > 0 || unverifiedCount > 0
          ? ` · ${verifiedCount} verified${
              absentCount > 0 ? ` · ${absentCount} dropped` : ""
            }${unverifiedCount > 0 ? ` · ${unverifiedCount} unverified` : ""}`
          : "";
      setMessage(
        timedOut
          ? `Screened ${finalResults.length} candidates · chain verification incomplete (${unverifiedCount} unverified after 45s timeout)`
          : `Screened ${finalResults.length} candidates${tail}`,
      );
      // Auto-clear the progress strip after a beat so it doesn't
      // linger past the user noticing it finished.
      window.setTimeout(() => setChainProgress(null), 4000);
    } catch (e) {
      setError({
        err: interpretError(e, "Screen Today"),
        retry: () => screenToday(),
      });
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
      // ApplyWatchlist may add ungraded rows; flip to ungraded so the
      // banner prompts a re-analyze. Existing graded rows in `next`
      // keep their stageThree/stageFour data — we just don't *claim*
      // the whole snapshot is graded.
      persistScreenSnapshot({
        candidates: next,
        prices: mergedPrices,
        screenedAt: timestampIso,
        graded: false,
      });
      setScreenIsGraded(false);
      setResults(next);
      setPrices(mergedPrices);
      setMessage(`Added ${json.added.length}, removed ${json.removed.length}`);
      setStatus("idle");
    } catch (e) {
      setError({
        err: interpretError(e, "Apply Watchlist"),
        retry: () => applyWatchlist(),
      });
      setStatus("error");
    }
  }

  // Tracked tickers first, then untracked — within each group sort by
  // Stage 2 score descending so the highest-quality untracked
  // candidates land in the first batch even when nothing's tracked.
  // Stage 2 score is the best signal we have at this point;
  // Stage 3 + 4 grades aren't computed yet.
  function sortForPass3(
    candidates: ScreenerResult[],
    trackedUpper: Set<string>,
  ): ScreenerResult[] {
    const tier = (c: ScreenerResult): number =>
      trackedUpper.has(c.symbol.toUpperCase()) ? 0 : 1;
    const score = (c: ScreenerResult): number => c.stageTwo?.score ?? -1;
    return [...candidates].sort((a, b) => {
      const t = tier(a) - tier(b);
      if (t !== 0) return t;
      return score(b) - score(a);
    });
  }

  // Shared batch context used by both streams. Mutated as batches
  // complete so the persist + state-update path always sees the
  // latest grade snapshot, regardless of which stream produced it.
  type StreamCtx = {
    workingResults: ScreenerResult[];
    newsByKey: Record<string, PerplexityNewsResult>;
    pendingNews: Set<string>;
    pendingGrade: Set<string>;
    timestampIso: string;
    pricesForPersist: Record<string, number>;
    vix: number | null;
    summary: {
      scored: number;
      tracked: number;
      snapshots: number;
      encyclopedia: number;
    };
  };

  // Persist after every batch from either stream. graded=true only
  // when both pending sets are empty (i.e. every candidate has both
  // news and a recomputed grade).
  function persistAfterBatch(ctx: StreamCtx) {
    const fullyDone = ctx.pendingNews.size === 0 && ctx.pendingGrade.size === 0;
    persistScreenSnapshot({
      candidates: ctx.workingResults,
      prices: ctx.pricesForPersist,
      screenedAt: ctx.timestampIso,
      graded: fullyDone,
    });
    if (fullyDone) setScreenIsGraded(true);
  }

  // Row-level spinner control: a row keeps its spinner until BOTH
  // streams have finished its key. Derived from the pending sets so
  // there's a single source of truth for "still analyzing."
  function recomputeRowSpinners(ctx: StreamCtx) {
    const stillAnalyzing = new Set<string>();
    ctx.pendingNews.forEach((key) => {
      const sym = key.split("|")[0]?.toUpperCase();
      if (sym) stillAnalyzing.add(sym);
    });
    ctx.pendingGrade.forEach((key) => {
      const sym = key.split("|")[0]?.toUpperCase();
      if (sym) stillAnalyzing.add(sym);
    });
    setAnalyzingSymbols(stillAnalyzing);
  }

  // News stream — calls /api/screener/analyze/pass3a in batches of
  // size getAdaptiveBatchSize('perplexity'). On a non-2xx (typically
  // a 60s timeout) the helper halves its batch size and retries the
  // SAME batch once. On a second failure it gives up on that batch
  // and continues — those candidates stay in pendingNews and the
  // Resume button replays just them.
  async function runNewsStream(
    targets: ScreenerResult[],
    ctx: StreamCtx,
  ): Promise<void> {
    let batchSize = getAdaptiveBatchSize("perplexity");
    let reduced = false;
    let i = 0;
    let cursor = 0;
    while (cursor < targets.length) {
      const batch = targets.slice(cursor, cursor + batchSize);
      const totalEstimated = Math.ceil(targets.length / batchSize);
      setNewsProgress({
        done: cursor,
        total: targets.length,
        batchSize,
        batchIndex: i + 1,
        batchTotal: Math.max(totalEstimated, i + 1),
        sample: batch.slice(0, 3).map((b) => b.symbol),
        reduced,
      });

      let success = false;
      try {
        const r = await fetch("/api/screener/analyze/pass3a", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ candidates: batch }),
          cache: "no-store",
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const json = (await r.json()) as {
          results: Array<{
            key: string;
            news: PerplexityNewsResult;
          }>;
        };
        for (const row of json.results) {
          ctx.newsByKey[row.key] = row.news;
          ctx.pendingNews.delete(row.key);
        }
        setPendingNewsKeys(new Set(ctx.pendingNews));
        recomputeRowSpinners(ctx);
        cursor += batch.length;
        i += 1;
        success = true;
        persistAfterBatch(ctx);
      } catch (e) {
        // Halve and retry once. If we're already at 1, give up on
        // this batch — the candidates stay in pendingNews and the
        // Resume button picks them up.
        if (batchSize > 1) {
          batchSize = reduceAdaptiveBatchSize("perplexity");
          reduced = true;
          console.warn(
            `[screener] news stream batch failed (${e instanceof Error ? e.message : e}) — reducing batch size to ${batchSize} and retrying`,
          );
          continue;
        }
        console.warn(
          `[screener] news stream batch at size 1 still failing — moving on, ${batch.length} candidate(s) left pending`,
        );
        cursor += batch.length;
        i += 1;
      }
      if (!success) {
        // size-1 give-up path landed above; loop to next batch
      }
    }
    setNewsProgress((prev) =>
      prev
        ? { ...prev, done: targets.length, sample: [], batchIndex: prev.batchTotal }
        : prev,
    );
  }

  // Grade stream — pulls candidates whose news has already landed (or
  // accepts a neutral fallback) and calls /api/screener/analyze/pass3b
  // in batches of size getAdaptiveBatchSize('edgar'). Polls the news
  // map at each batch boundary so it overlaps the news stream rather
  // than serializing behind it.
  async function runGradeStream(
    targets: ScreenerResult[],
    ctx: StreamCtx,
    finalBatchToken: { key: string },
  ): Promise<void> {
    let batchSize = getAdaptiveBatchSize("edgar");
    let reduced = false;
    let i = 0;
    let cursor = 0;
    while (cursor < targets.length) {
      // Wait until at least one candidate in this slice has news ready
      // — keeps the grade stream pipelined behind news without
      // blocking on every individual candidate. Hard cap of 30s
      // poll wait so a stuck news call doesn't hang grading forever.
      const slice = targets.slice(cursor, cursor + batchSize);
      const startedWaiting = Date.now();
      while (
        slice.every(
          (c) => !ctx.newsByKey[`${c.symbol}|${c.earningsDate}`],
        ) &&
        ctx.pendingNews.size > 0 &&
        Date.now() - startedWaiting < 30000
      ) {
        await new Promise((res) => setTimeout(res, 200));
      }

      const totalEstimated = Math.ceil(targets.length / batchSize);
      setGradeProgress({
        done: cursor,
        total: targets.length,
        batchSize,
        batchIndex: i + 1,
        batchTotal: Math.max(totalEstimated, i + 1),
        sample: slice.slice(0, 3).map((b) => b.symbol),
        reduced,
      });

      // Fire-and-forget post-actions only on the FINAL grade batch
      // (when this batch will exhaust the pending set). Per-batch
      // post-actions would re-write tracked / snapshots needlessly.
      const willBeFinal =
        cursor + slice.length >= targets.length && ctx.pendingNews.size === 0;
      finalBatchToken.key = willBeFinal ? "final" : "intermediate";

      try {
        const r = await fetch("/api/screener/analyze/pass3b", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            candidates: slice,
            newsByKey: Object.fromEntries(
              slice
                .map((c) => [
                  `${c.symbol}|${c.earningsDate}`,
                  ctx.newsByKey[`${c.symbol}|${c.earningsDate}`],
                ])
                .filter(([, v]) => !!v),
            ),
            vix: ctx.vix,
            trackedSymbols: Array.from(tracked),
            runPostActions: willBeFinal,
          }),
          cache: "no-store",
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const json = (await r.json()) as {
          results: ScreenerResult[];
          scoredCount?: number;
          trackedUpserted?: number;
          snapshotsWritten?: number;
          encyclopediaUpdates?: number;
        };
        const byKey = new Map(
          json.results.map((rr) => [`${rr.symbol}|${rr.earningsDate}`, rr]),
        );
        ctx.workingResults = ctx.workingResults.map(
          (rr) => byKey.get(`${rr.symbol}|${rr.earningsDate}`) ?? rr,
        );
        for (const c of slice) {
          ctx.pendingGrade.delete(`${c.symbol}|${c.earningsDate}`);
        }
        setPendingGradeKeys(new Set(ctx.pendingGrade));
        recomputeRowSpinners(ctx);
        setResults([...ctx.workingResults]);
        setGroupMode(null);
        ctx.summary.scored += json.scoredCount ?? json.results.length;
        ctx.summary.tracked += json.trackedUpserted ?? 0;
        ctx.summary.snapshots += json.snapshotsWritten ?? 0;
        ctx.summary.encyclopedia += json.encyclopediaUpdates ?? 0;
        cursor += slice.length;
        i += 1;
        persistAfterBatch(ctx);
      } catch (e) {
        if (batchSize > 1) {
          batchSize = reduceAdaptiveBatchSize("edgar");
          reduced = true;
          console.warn(
            `[screener] grade stream batch failed (${e instanceof Error ? e.message : e}) — reducing batch size to ${batchSize} and retrying`,
          );
          continue;
        }
        console.warn(
          `[screener] grade stream batch at size 1 still failing — moving on`,
        );
        cursor += slice.length;
        i += 1;
      }
    }
    setGradeProgress((prev) =>
      prev
        ? { ...prev, done: targets.length, sample: [], batchIndex: prev.batchTotal }
        : prev,
    );
  }

  // Resume — replays only candidates that didn't make it through one
  // or both streams. The two streams run independently so each has
  // its own resume button.
  async function resumeNewsStream() {
    if (!results || pendingNewsKeys.size === 0) return;
    setStatus("analyzing");
    setAnalysisError(null);
    setError(null);
    const remaining = results.filter((r) =>
      pendingNewsKeys.has(`${r.symbol}|${r.earningsDate}`),
    );
    const ctx = buildStreamCtx({ resumeFrom: results });
    await runNewsStream(remaining, ctx);
    finishStreamsIfDone(ctx);
  }
  async function resumeGradeStream() {
    if (!results || pendingGradeKeys.size === 0) return;
    setStatus("analyzing");
    setAnalysisError(null);
    setError(null);
    const remaining = results.filter((r) =>
      pendingGradeKeys.has(`${r.symbol}|${r.earningsDate}`),
    );
    const ctx = buildStreamCtx({ resumeFrom: results });
    const token = { key: "intermediate" };
    await runGradeStream(remaining, ctx, token);
    finishStreamsIfDone(ctx);
  }

  // Helper: build a fresh StreamCtx using the current page state.
  // resumeFrom seeds workingResults with what the table currently
  // shows (so a Resume run merges into the existing graded rows
  // instead of reverting to Pass 2 output).
  function buildStreamCtx(opts: {
    resumeFrom: ScreenerResult[];
  }): StreamCtx {
    return {
      workingResults: [...opts.resumeFrom],
      newsByKey: {},
      pendingNews: new Set(pendingNewsKeys),
      pendingGrade: new Set(pendingGradeKeys),
      timestampIso: (screenedAt ?? new Date()).toISOString(),
      pricesForPersist: prices,
      vix: analysisVix,
      summary: { scored: 0, tracked: 0, snapshots: 0, encyclopedia: 0 },
    };
  }

  function finishStreamsIfDone(ctx: StreamCtx) {
    if (ctx.pendingNews.size === 0 && ctx.pendingGrade.size === 0) {
      setStatus("idle");
      setNewsProgress(null);
      setGradeProgress(null);
      setMessage(
        `Analysis complete ✓\n📊 ${ctx.summary.scored} candidates scored\n🎯 ${ctx.summary.tracked} tracked tickers saved\n📸 ${ctx.summary.snapshots} position snapshots taken\n📚 ${ctx.summary.encyclopedia} encyclopedia updates`,
      );
    } else {
      // Partial — leave progress panel up so the resume buttons stay
      // visible. status drops back to idle so other actions work.
      setStatus("idle");
      const partials: string[] = [];
      if (ctx.pendingNews.size > 0)
        partials.push(`${ctx.pendingNews.size} pending news`);
      if (ctx.pendingGrade.size > 0)
        partials.push(`${ctx.pendingGrade.size} pending grade`);
      setMessage(`Partial analysis (${partials.join(", ")}) — Resume to retry`);
    }
  }

  async function runAnalysis() {
    if (!results) return;
    setMessage(null);
    await runAnalysisOn(results);
  }

  // "Analyze Tracked" — same Pass 2/3 flow as Run Analysis but
  // restricted to candidates the user has checkbox-tracked. Untracked
  // rows are left exactly as-is in the merged result set, so they
  // still show Pass 1 data (crush/opportunity grades, suggested
  // strike, premium) but no three-layer grade.
  async function analyzeTracked() {
    if (!results) return;
    const trackedCandidates = results.filter((r) =>
      tracked.has(r.symbol.toUpperCase()),
    );
    if (trackedCandidates.length === 0) {
      setMessage(
        "No tracked candidates — check the boxes on rows you want to analyze.",
      );
      return;
    }
    setMessage(
      `Analyzing ${trackedCandidates.length} tracked candidate${trackedCandidates.length === 1 ? "" : "s"}…`,
    );
    await runAnalysisOn(trackedCandidates);
  }

  // Shared analysis flow — runs Pass 2 + the parallel News/Grade
  // streams on the supplied candidate list. The merge step always
  // walks the full `results` array so untouched rows pass through
  // unchanged (this is what lets Analyze Tracked leave non-tracked
  // candidates with their Pass 1 data intact).
  async function runAnalysisOn(candidatesToAnalyze: ScreenerResult[]) {
    if (!results || !connected) return;
    if (candidatesToAnalyze.length === 0) return;
    setStatus("analyzing");
    setError(null);
    setAnalysisError(null);
    setNewsProgress(null);
    setGradeProgress(null);
    setAnalyzingSymbols(
      new Set(candidatesToAnalyze.map((r) => r.symbol.toUpperCase())),
    );

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
        body: JSON.stringify({ candidates: candidatesToAnalyze }),
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

    // ---- Pass 3 — News + Grade as two parallel streams ----
    // News (pass3a) is Perplexity-bound; Grade (pass3b) is personal-
    // history + grade compute + (final-batch) post-actions. Streams
    // are launched in parallel; Grade pipelines behind News at each
    // batch boundary so both make forward progress simultaneously.
    setAnalysisVix(p2!.vix);
    const timestampIso = (screenedAt ?? new Date()).toISOString();
    const sorted = sortForPass3(p2!.results, tracked);
    const allKeys = new Set(
      sorted.map((c) => `${c.symbol}|${c.earningsDate}`),
    );
    setPendingNewsKeys(new Set(allKeys));
    setPendingGradeKeys(new Set(allKeys));

    const ctx: StreamCtx = {
      workingResults: merged2,
      newsByKey: {},
      pendingNews: new Set(allKeys),
      pendingGrade: new Set(allKeys),
      timestampIso,
      pricesForPersist: mergedPrices,
      vix: p2!.vix,
      summary: { scored: 0, tracked: 0, snapshots: 0, encyclopedia: 0 },
    };

    const finalBatchToken = { key: "intermediate" };
    await Promise.allSettled([
      runNewsStream(sorted, ctx),
      runGradeStream(sorted, ctx, finalBatchToken),
    ]);

    setAnalyzingSymbols(new Set());
    finishStreamsIfDone(ctx);
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
      // Single-symbol re-analyze refreshes one row's grades. Preserve
      // the existing screenIsGraded flag — if the bulk Run Analysis
      // already happened the snapshot is still graded; if we
      // re-analyze a single row before the bulk run, the snapshot
      // is still mostly ungraded.
      persistScreenSnapshot({
        candidates: next,
        prices,
        screenedAt: timestampIso,
        graded: screenIsGraded,
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
            {(() => {
              const trackedCandidateCount = (results ?? []).filter((r) =>
                tracked.has(r.symbol.toUpperCase()),
              ).length;
              return (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span>
                      <Button
                        variant="secondary"
                        disabled={
                          !results ||
                          busy ||
                          !connected ||
                          trackedCandidateCount === 0
                        }
                        onClick={analyzeTracked}
                      >
                        {status === "analyzing" ? (
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        ) : (
                          <Star className="mr-2 h-4 w-4" />
                        )}
                        Analyze Tracked ({trackedCandidateCount})
                      </Button>
                    </span>
                  </TooltipTrigger>
                  {!connected && (
                    <TooltipContent>Connect Schwab to analyze</TooltipContent>
                  )}
                  {connected && trackedCandidateCount === 0 && (
                    <TooltipContent>
                      Check the box on rows you want to analyze
                    </TooltipContent>
                  )}
                </Tooltip>
              );
            })()}
            <Button variant="secondary" disabled={!results || busy} onClick={applyWatchlist}>
              {status === "applying" ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <RefreshCcw className="mr-2 h-4 w-4" />
              )}
              Apply Watchlist
            </Button>
            {previousAvailable && (
              <Button
                variant="outline"
                disabled={busy}
                onClick={loadPrevious}
                title={`Load saved results from ${new Date(
                  previousAvailable.screenedAt,
                ).toLocaleString([], {
                  month: "short",
                  day: "numeric",
                  hour: "numeric",
                  minute: "2-digit",
                  hour12: true,
                })} (${previousAvailable.count} candidates${previousAvailable.graded ? ", graded" : ", ungraded"})`}
              >
                <History className="mr-2 h-4 w-4" />
                Load Previous
              </Button>
            )}
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
            // Resume in the dual-stream world is per-stream, surfaced
            // inside StreamProgressPanel below. Banner only offers
            // Retry (full restart) or Dismiss.
            onResume={null}
            pendingCount={pendingNewsKeys.size + pendingGradeKeys.size}
            onRetry={() => {
              setAnalysisError(null);
              void runAnalysis();
            }}
            onDismiss={() => setAnalysisError(null)}
          />
        )}
        {(newsProgress || gradeProgress) && (
          <StreamProgressPanel
            news={newsProgress}
            grade={gradeProgress}
            running={status === "analyzing"}
            pendingNews={pendingNewsKeys.size}
            pendingGrade={pendingGradeKeys.size}
            onResumeNews={
              status !== "analyzing" && pendingNewsKeys.size > 0
                ? () => void resumeNewsStream()
                : null
            }
            onResumeGrade={
              status !== "analyzing" && pendingGradeKeys.size > 0
                ? () => void resumeGradeStream()
                : null
            }
            onDismiss={() => {
              setNewsProgress(null);
              setGradeProgress(null);
            }}
          />
        )}
        {!analysisError && error && (
          <ErrorBanner
            error={error.err}
            onRetry={
              error.retry
                ? () => {
                    const fn = error.retry;
                    setError(null);
                    void fn?.();
                  }
                : undefined
            }
            onDismiss={() => setError(null)}
          />
        )}

        {chainProgress && (
          <div
            className={`rounded-lg border px-3 py-2 text-xs ${
              chainProgress.phase === "done"
                ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
                : "border-sky-500/30 bg-sky-500/10 text-sky-200"
            }`}
          >
            <div className="flex items-center gap-2">
              {chainProgress.phase === "verifying" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <span>✓</span>
              )}
              <span className="font-medium">
                {chainProgress.phase === "verifying"
                  ? "Stream C — verifying option chains"
                  : "Stream C — verification complete"}
              </span>
              <span className="font-mono">
                {chainProgress.done}/{chainProgress.total}
              </span>
            </div>
            {chainProgress.phase === "verifying" && chainProgress.total > 0 && (
              <div className="mt-1.5 h-1 overflow-hidden rounded bg-sky-500/20">
                <div
                  className="h-full bg-sky-400/70 transition-[width] duration-200"
                  style={{
                    width: `${Math.min(100, (chainProgress.done / chainProgress.total) * 100)}%`,
                  }}
                />
              </div>
            )}
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
                  <TableHead title="How far the stock has to fall to breach the strike: (price − strike) / price">
                    % Drop
                  </TableHead>
                  <SortableHeader label="Premium" active={sortKey === "premium"} dir={sortDir} onClick={() => onSort("premium")} />
                  <SortableHeader label="Yield%" active={sortKey === "yield"} dir={sortDir} onClick={() => onSort("yield")} />
                  <SortableHeader label="Delta" active={sortKey === "delta"} dir={sortDir} onClick={() => onSort("delta")} />
                  <TableHead className="w-10 text-center" title="Wide spread (>50% of premium)">⚠️</TableHead>
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
                        <TableCell className={cn("font-mono text-sm", gradeColor(displayCrushGrade(r.stageThree)))}>
                          {analyzingRow ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : displayCrushGrade(r.stageThree)}
                        </TableCell>
                        <TableCell className={cn("font-mono text-sm", gradeColor(r.stageFour?.opportunityGrade))}>
                          {analyzingRow ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : (r.stageFour?.opportunityGrade ?? "—")}
                        </TableCell>
                        {(() => {
                          const ov = strikeOverrides[id] ?? null;
                          const effStrike = ov?.strike ?? r.stageFour?.suggestedStrike ?? null;
                          const effPremium = ov?.premium ?? r.stageFour?.premium ?? null;
                          const effDelta = ov?.delta ?? r.stageFour?.delta ?? null;
                          const effSpread = ov?.bidAskSpreadPct ?? r.stageFour?.bidAskSpreadPct ?? null;
                          return (
                            <>
                              <TableCell onClick={(e) => e.stopPropagation()}>
                                <EditableStrikeCell
                                  defaultStrike={r.stageFour?.suggestedStrike ?? null}
                                  override={ov}
                                  availableStrikes={r.stageFour?.availableStrikes ?? []}
                                  onApply={(o) =>
                                    setStrikeOverrides((prev) => ({ ...prev, [id]: o }))
                                  }
                                />
                              </TableCell>
                              <TableCell className={cn("text-sm font-mono", pctDropColor(displayedPrice, effStrike))}>
                                {fmtPctDrop(displayedPrice, effStrike)}
                              </TableCell>
                              <TableCell className="text-sm">
                                {effPremium !== null && effPremium !== undefined
                                  ? `$${fmtNum(effPremium)}`
                                  : "—"}
                              </TableCell>
                              <TableCell className={cn("text-sm font-mono", yieldColor(effPremium, effStrike))}>
                                {fmtYield(effPremium, effStrike)}
                              </TableCell>
                              <TableCell className="text-sm">{fmtNum(effDelta, 3)}</TableCell>
                              <TableCell className="text-center">
                                {effSpread !== null && effSpread !== undefined && effSpread > 50 ? (
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <AlertTriangle className="inline h-4 w-4 text-amber-400" />
                                    </TooltipTrigger>
                                    <TooltipContent>
                                      Bid-ask spread {fmtNum(effSpread, 1)}% — wider than 50% of premium
                                    </TooltipContent>
                                  </Tooltip>
                                ) : null}
                              </TableCell>
                            </>
                          );
                        })()}
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
          <div className="grid grid-cols-2 gap-x-6 gap-y-0.5 font-mono">
            <Row k="Strike" v={`$${result.strike.toFixed(2)}`} />
            <Row k="% Drop to Strike" v={`${result.distancePct.toFixed(1)}%`} />
            <Row k="Premium" v={`$${result.premium.toFixed(2)}`} />
            <Row k="Delta" v={result.delta.toFixed(3)} />
            <Row
              k="Yield%"
              v={fmtYield(result.premium, result.strike)}
              valueClassName={yieldColor(result.premium, result.strike)}
            />
            <Row k="Prob of profit" v={`${(result.pop * 100).toFixed(0)}%`} />
            <div />
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
  onResume,
  pendingCount,
  onDismiss,
}: {
  err: AnalysisError;
  onRetry: () => void;
  // Resume the batched Pass 3 from where it stopped. Null when no
  // partial state exists (e.g. Pass 2 failed entirely).
  onResume: (() => void) | null;
  pendingCount: number;
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
        {onResume && (
          <Button
            size="sm"
            onClick={onResume}
            className="bg-emerald-500/80 hover:bg-emerald-500"
          >
            Resume ({pendingCount} pending)
          </Button>
        )}
        {action === "retry" && (
          <Button size="sm" variant="outline" onClick={onRetry}>
            Retry {err.pass === "pass2" ? "Pass 2" : "Pass 3 from start"}
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
            regime / final grade) is missing for {pendingCount}{" "}
            candidate{pendingCount === 1 ? "" : "s"}.
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

// Live progress panel for the two Pass-3 streams. Shows per-stream
// progress bars, current-batch sample symbols, batch index/total,
// the currently-applied batch size (with a "reduced" badge when the
// adaptive sizer halved on a timeout), and per-stream Resume buttons
// once the run finishes with leftovers.
type StreamProgressView = {
  done: number;
  total: number;
  batchSize: number;
  batchIndex: number;
  batchTotal: number;
  sample: string[];
  reduced: boolean;
};

function StreamProgressPanel({
  news,
  grade,
  running,
  pendingNews,
  pendingGrade,
  onResumeNews,
  onResumeGrade,
  onDismiss,
}: {
  news: StreamProgressView | null;
  grade: StreamProgressView | null;
  running: boolean;
  pendingNews: number;
  pendingGrade: number;
  onResumeNews: (() => void) | null;
  onResumeGrade: (() => void) | null;
  onDismiss: () => void;
}) {
  const total = news?.total ?? grade?.total ?? 0;
  const allDone = pendingNews === 0 && pendingGrade === 0;
  // "Fully graded" = no pending key in either stream. Only counts
  // stocks that have completed BOTH Perplexity AND Grade — the
  // per-stream done counts on the rows below stay independent so
  // the user can see which stream is the bottleneck, but the
  // headline number reflects the actual gating progress.
  const fullyGraded = (() => {
    if (total === 0) return 0;
    // Rough derivation: total minus the union of pending keys. The
    // panel doesn't have the underlying sets, so use the per-stream
    // pending counts as a conservative proxy — a key is in EITHER
    // pending set if it's not fully graded.
    const stillPending = Math.max(pendingNews, pendingGrade);
    return Math.max(0, total - stillPending);
  })();
  return (
    <div className="rounded-lg border border-sky-500/30 bg-sky-500/5 p-3 text-xs text-sky-100">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 font-medium">
          {running ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : allDone ? (
            <span className="text-emerald-300">✅</span>
          ) : (
            <AlertTriangle className="h-3.5 w-3.5 text-amber-300" />
          )}
          {running ? (
            <>
              Analyzing {total} candidate{total === 1 ? "" : "s"}
              <span className="ml-1 text-sky-300/80">
                · {fullyGraded}/{total} fully graded
              </span>
            </>
          ) : allDone ? (
            <>Analysis complete — {total}/{total} graded</>
          ) : (
            <>
              Partial analysis — {fullyGraded}/{total} fully graded ·{" "}
              {pendingNews + pendingGrade} key{pendingNews + pendingGrade === 1 ? "" : "s"} pending
            </>
          )}
        </div>
        {!running && (
          <button
            type="button"
            onClick={onDismiss}
            className="text-[11px] text-sky-200/60 hover:text-sky-200"
          >
            Dismiss
          </button>
        )}
      </div>
      <StreamRow
        label="Schwab"
        progress={{
          done: total,
          total,
          batchSize: total,
          batchIndex: 1,
          batchTotal: 1,
          sample: [],
          reduced: false,
        }}
        // Pass 2 always completes before this panel renders.
        forceComplete
        pending={0}
        resume={null}
      />
      <StreamRow
        label="Perplexity"
        progress={news}
        pending={pendingNews}
        resume={onResumeNews}
      />
      <StreamRow
        label="Grade"
        progress={grade}
        pending={pendingGrade}
        resume={onResumeGrade}
      />
      <div className="mt-2 text-[11px] text-sky-200/70">
        Grades appear as each stock completes both streams.
      </div>
    </div>
  );
}

function StreamRow({
  label,
  progress,
  pending,
  resume,
  forceComplete,
}: {
  label: string;
  progress: StreamProgressView | null;
  pending: number;
  resume: (() => void) | null;
  forceComplete?: boolean;
}) {
  const total = progress?.total ?? 0;
  const done = forceComplete ? total : progress?.done ?? 0;
  const pct = total > 0 ? Math.min(1, done / total) : 0;
  const blocks = 12;
  const filled = Math.round(pct * blocks);
  const bar = "█".repeat(filled) + "░".repeat(Math.max(0, blocks - filled));
  const sample = progress?.sample ?? [];
  return (
    <div className="my-1 flex flex-wrap items-baseline gap-2">
      <span className="w-20 shrink-0 text-[11px] uppercase tracking-wide text-sky-200/80">
        {label}
      </span>
      <span className="font-mono text-[11px] tracking-tighter text-sky-300">
        {bar}
      </span>
      <span className="font-mono text-[11px] text-sky-100">
        {done}/{total}
      </span>
      {forceComplete || (total > 0 && done === total) ? (
        <span className="text-emerald-300">✅</span>
      ) : null}
      {progress && progress.batchTotal > 1 && done < total && (
        <span className="text-[10px] text-sky-200/70">
          batch {progress.batchIndex}/{progress.batchTotal} · size{" "}
          {progress.batchSize}
          {sample.length > 0 && (
            <>
              {" "}
              · {sample.join(", ")}
              {progress.batchSize > sample.length ? "…" : ""}
            </>
          )}
        </span>
      )}
      {progress?.reduced && (
        <span className="rounded border border-amber-500/40 bg-amber-500/10 px-1 py-0.5 text-[9px] font-semibold uppercase text-amber-300">
          ⚠ reduced to size {progress.batchSize}
        </span>
      )}
      {resume && (
        <Button
          size="sm"
          onClick={resume}
          className="ml-auto bg-emerald-500/80 hover:bg-emerald-500"
        >
          Resume ({pending})
        </Button>
      )}
    </div>
  );
}

// Inline-editable strike cell. Click to type a target strike, Enter to
// apply (snaps to the nearest entry in availableStrikes — no extra API
// call), Escape/blur to cancel. Override is owned by the parent table
// so Premium / Yield% / Delta / ⚠️ cells in the same row can read from
// the same snapshot.
function EditableStrikeCell({
  defaultStrike,
  override,
  availableStrikes,
  onApply,
}: {
  defaultStrike: number | null;
  override:
    | { strike: number; premium: number; delta: number; bidAskSpreadPct: number }
    | null;
  availableStrikes: NonNullable<StageFourResult["availableStrikes"]>;
  onApply: (
    o: { strike: number; premium: number; delta: number; bidAskSpreadPct: number },
  ) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState("");
  const displayStrike = override?.strike ?? defaultStrike;
  const showHint = override !== null && defaultStrike !== null;

  if (editing) {
    return (
      <input
        autoFocus
        type="number"
        step="0.5"
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            const target = Number(val);
            if (
              !Number.isFinite(target) ||
              !availableStrikes ||
              availableStrikes.length === 0
            ) {
              setEditing(false);
              return;
            }
            const nearest = availableStrikes.reduce((best, s) =>
              Math.abs(s.strike - target) < Math.abs(best.strike - target) ? s : best,
            );
            const spreadPct =
              nearest.mark > 0
                ? ((nearest.ask - nearest.bid) / nearest.mark) * 100
                : 0;
            onApply({
              strike: nearest.strike,
              premium: nearest.mark,
              delta: nearest.delta,
              bidAskSpreadPct: spreadPct,
            });
            setEditing(false);
          } else if (e.key === "Escape") {
            setEditing(false);
          }
        }}
        onBlur={() => setEditing(false)}
        className="w-20 rounded border border-border bg-background px-1.5 py-0.5 text-sm font-mono"
      />
    );
  }

  if (displayStrike === null) {
    return <span className="text-sm text-muted-foreground">—</span>;
  }

  return (
    <div
      className="group inline-block cursor-text"
      onClick={() => {
        setVal(displayStrike.toString());
        setEditing(true);
      }}
      title="Click to edit strike"
    >
      <span className="text-sm">${fmtNum(displayStrike)}</span>
      <Pencil className="ml-1 inline h-3 w-3 opacity-0 transition-opacity group-hover:opacity-50" />
      {showHint && defaultStrike !== null && (
        <div className="text-[10px] text-muted-foreground">
          2× EM: ${fmtNum(defaultStrike)}
        </div>
      )}
    </div>
  );
}

function Row({
  k,
  v,
  valueClassName,
}: {
  k: string;
  v: string;
  valueClassName?: string;
}) {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-muted-foreground">{k}</span>
      <span className={`font-mono ${valueClassName ?? "text-foreground"}`}>
        {v}
      </span>
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


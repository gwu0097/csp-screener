"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Briefcase, Camera, Loader2, Plus, RefreshCcw, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ImportScreenshotModal } from "@/components/import-screenshot-modal";
import { ImportManualModal } from "@/components/import-manual-modal";
import { PositionCard, type OpenPositionClientView } from "@/components/position-card";
import { fmtDollars, fmtDollarsSigned } from "@/lib/format";
import type { MarketContext } from "@/lib/market";

type PositionsResponse = {
  market: MarketContext;
  positions: OpenPositionClientView[];
  unmatchedCloses: Array<{
    id: string;
    symbol: string;
    strike: number;
    expiry: string;
    contracts: number;
    premiumBought: number | null;
  }>;
  opportunityAvailable: boolean;
  live: boolean;
};

type BestOpportunity = { symbol: string; recommendation: string } | null;

function readBestOpportunity(): BestOpportunity {
  try {
    const raw = localStorage.getItem("screener_results");
    const ts = localStorage.getItem("screener_timestamp");
    if (!raw || !ts) return null;
    const screenDate = new Date(ts);
    if (Number.isNaN(screenDate.getTime())) return null;
    // Same calendar day in the user's locale.
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

// Today's realized P&L: sum of (premium_sold - premium_bought) * contracts * 100
// across closes the API surfaces through its return + children.
function calcTodaysRealized(positions: OpenPositionClientView[]): number {
  const today = new Date().toISOString().slice(0, 10);
  let total = 0;
  for (const p of positions) {
    for (const c of p.closes) {
      if (!c.closedAt || !c.closedAt.startsWith(today)) continue;
      if (c.premiumBought === null) continue;
      total += (p.premiumSold - c.premiumBought) * c.contracts * 100;
    }
  }
  return total;
}

// Temporary debug panel state — visible at the top of the page so we can
// diagnose "0 positions" without DevTools. Remove once fixed.
type DebugInfo = {
  url: string;
  status: number | null;
  elapsedMs: number | null;
  bodyText: string | null;
  errorMessage: string | null;
  timestamp: string;
};

export function PositionsView() {
  const [data, setData] = useState<PositionsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [liveLoading, setLiveLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [showScreenshot, setShowScreenshot] = useState(false);
  const [showManual, setShowManual] = useState(false);
  const [best, setBest] = useState<BestOpportunity>(null);
  const [debug, setDebug] = useState<DebugInfo | null>(null);

  // `live=false` is the fast path: Supabase + Yahoo spot, no Schwab chain.
  // `live=true` is the full path (greeks, mark, P&L) — slower and only
  // fired when the user clicks Refresh live data.
  const load = useCallback(async (live: boolean) => {
    if (live) setLiveLoading(true);
    else setLoading(true);
    setError(null);
    const opp = readBestOpportunity();
    setBest(opp);

    const url = `/api/positions/open?opportunityAvailable=${opp !== null}&live=${live}`;
    const t0 = Date.now();
    const dbg: DebugInfo = {
      url,
      status: null,
      elapsedMs: null,
      bodyText: null,
      errorMessage: null,
      timestamp: new Date().toISOString(),
    };

    try {
      const res = await fetch(url, { cache: "no-store" });
      dbg.status = res.status;
      dbg.elapsedMs = Date.now() - t0;
      // Read as text first so we can log the raw body even if JSON parse
      // fails. Then parse.
      const bodyText = await res.text();
      dbg.bodyText = bodyText;

      let json: (PositionsResponse & { error?: string }) | null = null;
      try {
        json = JSON.parse(bodyText) as PositionsResponse & { error?: string };
      } catch {
        // Leave json null; logged below.
      }

      console.log("[positions] API response:", {
        status: res.status,
        ok: res.ok,
        data: JSON.stringify(json),
      });

      if (!json) throw new Error(`Non-JSON response: ${bodyText.slice(0, 200)}`);
      if (!res.ok || json.error) throw new Error(json.error ?? `HTTP ${res.status}`);
      setData(json);
      setDebug(dbg);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to load positions";
      console.log("[positions] fetch error:", err);
      dbg.errorMessage = msg;
      dbg.elapsedMs = dbg.elapsedMs ?? Date.now() - t0;
      setError(msg);
      setDebug(dbg);
    } finally {
      if (live) setLiveLoading(false);
      else setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Initial load is fast — users see positions instantly; they can opt
    // into live data via the dedicated button.
    void load(false);
  }, [load]);

  const onImportSuccess = (msg: string) => {
    setMessage(msg);
    // Fast refresh after import — user can click "Refresh live data" if
    // they want greeks for the newly-imported positions.
    void load(false);
  };

  const positions = data?.positions ?? [];
  const market = data?.market;
  const todaysRealized = calcTodaysRealized(positions);
  const unmatched = data?.unmatchedCloses ?? [];

  // First position, pretty-printed, for the debug panel. Falls back to
  // null if we don't have any.
  const firstPositionJson =
    data?.positions && data.positions.length > 0
      ? JSON.stringify(data.positions[0], null, 2)
      : null;

  return (
    <div className="space-y-4">
      {/* TEMP DEBUG PANEL — remove once 0-positions bug is diagnosed. */}
      {debug && (
        <div className="rounded-lg border-2 border-rose-500/60 bg-rose-500/5 p-3 text-xs">
          <div className="mb-1 flex items-center justify-between">
            <span className="font-semibold text-rose-200">
              DEBUG · /api/positions/open
            </span>
            <span className="text-muted-foreground">{debug.timestamp}</span>
          </div>
          <div className="mb-1 font-mono text-rose-100">
            status:{" "}
            <span
              className={
                debug.status && debug.status >= 200 && debug.status < 300
                  ? "text-emerald-300"
                  : "text-rose-300"
              }
            >
              {debug.status ?? "—"}
            </span>
            {" · "}positions.length:{" "}
            <span className="text-foreground">{data?.positions?.length ?? 0}</span>
            {" · "}elapsed: {debug.elapsedMs ?? "—"}ms
          </div>
          {debug.errorMessage && (
            <div className="mb-1 font-mono text-rose-300">
              error: {debug.errorMessage}
            </div>
          )}
          {firstPositionJson && (
            <details className="mt-2" open>
              <summary className="cursor-pointer text-rose-200">
                first position (raw JSON)
              </summary>
              <pre className="mt-1 max-h-64 overflow-auto rounded border border-rose-500/30 bg-background/60 p-2 text-[10px] leading-tight">
                {firstPositionJson}
              </pre>
            </details>
          )}
        </div>
      )}

      {/* Header bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
        <div className="flex flex-wrap items-center gap-3">
          <span className="inline-flex items-center gap-2 font-medium text-foreground">
            <Briefcase className="h-4 w-4" /> Positions
          </span>
          <span className="text-muted-foreground">
            Today:{" "}
            <span className={todaysRealized >= 0 ? "text-emerald-300" : "text-rose-300"}>
              {fmtDollarsSigned(todaysRealized)}
            </span>
          </span>
          <span className="text-muted-foreground">
            Open: <span className="text-foreground">{positions.length}</span>
          </span>
          {market && (
            <span className="text-muted-foreground">
              VIX:{" "}
              <span className={regimeColor(market.regime)}>
                {market.vix !== null ? market.vix.toFixed(2) : "—"}
                {market.regime ? ` (${market.regime})` : ""}
              </span>
            </span>
          )}
          {best && (
            <span className="text-muted-foreground">
              Best: <span className="text-foreground">{best.symbol}</span>{" "}
              <span className="text-xs text-muted-foreground">({best.recommendation})</span>
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {data && !data.live && positions.length > 0 && (
            <span className="text-xs text-muted-foreground">Live data not loaded</span>
          )}
          <Button
            variant="secondary"
            size="sm"
            onClick={() => load(false)}
            disabled={loading || liveLoading}
          >
            {loading ? (
              <Loader2 className="mr-2 h-3 w-3 animate-spin" />
            ) : (
              <RefreshCcw className="mr-2 h-3 w-3" />
            )}
            Refresh
          </Button>
          <Button
            size="sm"
            onClick={() => load(true)}
            disabled={loading || liveLoading || positions.length === 0}
          >
            {liveLoading ? (
              <Loader2 className="mr-2 h-3 w-3 animate-spin" />
            ) : (
              <Zap className="mr-2 h-3 w-3" />
            )}
            Refresh live data
          </Button>
        </div>
      </div>

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

      {/* Import buttons */}
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={() => setShowScreenshot(true)}>
          <Camera className="mr-2 h-4 w-4" />
          Import from screenshot
        </Button>
        <Button variant="secondary" onClick={() => setShowManual(true)}>
          <Plus className="mr-2 h-4 w-4" />
          Add manually
        </Button>
      </div>

      {/* Open positions */}
      <div className="flex items-center gap-2 pt-2">
        <h2 className="text-sm font-semibold">Open positions ({positions.length})</h2>
      </div>

      {loading && !data && (
        <div className="flex items-center justify-center rounded-lg border border-border bg-background/40 px-6 py-12 text-sm text-muted-foreground">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading positions…
        </div>
      )}

      {!loading && positions.length === 0 && (
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border bg-background/40 px-6 py-12 text-center">
          <Briefcase className="mb-3 h-8 w-8 text-muted-foreground" />
          <div className="text-sm text-muted-foreground">No open positions. Import from a screenshot or log one manually.</div>
        </div>
      )}

      <div className="space-y-3">
        {positions.map((p) => (
          <PositionCard key={p.id} position={p} onCloseSubmitted={onImportSuccess} />
        ))}
      </div>

      {unmatched.length > 0 && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs">
          <div className="mb-2 font-medium text-amber-200">
            Unmatched closes ({unmatched.length}) — link or ignore
          </div>
          <div className="space-y-1">
            {unmatched.map((u) => (
              <div key={u.id} className="flex items-center justify-between gap-2">
                <span>
                  {u.symbol} · {u.contracts}× ${u.strike} · expiry {u.expiry}{" "}
                  · closed @ {fmtDollars(u.premiumBought)}
                </span>
                <span className="text-muted-foreground">
                  parent_trade_id=null
                </span>
              </div>
            ))}
          </div>
          <div className="mt-2 text-muted-foreground">
            Manual linking UI lands in a future PR. For now these stay in the DB so the
            journal can still count them.
          </div>
        </div>
      )}

      <ImportScreenshotModal
        open={showScreenshot}
        onOpenChange={setShowScreenshot}
        onSuccess={onImportSuccess}
      />
      <ImportManualModal open={showManual} onOpenChange={setShowManual} onSuccess={onImportSuccess} />
    </div>
  );
}

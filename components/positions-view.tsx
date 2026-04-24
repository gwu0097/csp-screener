"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Briefcase, Camera, Loader2, Plus, RefreshCcw, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ImportScreenshotModal } from "@/components/import-screenshot-modal";
import { ImportManualModal } from "@/components/import-manual-modal";
import {
  PositionCard,
  type ClosedPositionClientView,
  type OpenPositionClientView,
} from "@/components/position-card";
import { ChevronDown, ChevronRight } from "lucide-react";
import { fmtDollarsSigned } from "@/lib/format";
import type { MarketContext } from "@/lib/market";

type PositionsResponse = {
  market: MarketContext;
  positions: OpenPositionClientView[];
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
  const [best, setBest] = useState<BestOpportunity>(null);
  const [closedPositions, setClosedPositions] = useState<ClosedPositionClientView[] | null>(null);
  const [closedOpen, setClosedOpen] = useState(false);
  const [closedLoading, setClosedLoading] = useState(false);

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
      setData(json);
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
  // Sum of unrealized P&L across positions that have live option marks.
  const unrealized = positions.reduce(
    (sum, p) => sum + (p.pnlDollars ?? 0),
    0,
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
        <div className="flex flex-wrap items-center gap-3">
          <span className="inline-flex items-center gap-2 font-medium text-foreground">
            <Briefcase className="h-4 w-4" /> Positions
          </span>
          <span className="text-muted-foreground">
            Open: <span className="text-foreground">{positions.length}</span>
            {totalOpenContracts > 0 && (
              <span className="text-muted-foreground"> ({totalOpenContracts} contracts)</span>
            )}
          </span>
          {data?.live && (
            <span className="text-muted-foreground">
              Unrealized:{" "}
              <span className={unrealized >= 0 ? "text-emerald-300" : "text-rose-300"}>
                {fmtDollarsSigned(unrealized)}
              </span>
            </span>
          )}
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
          <div className="text-sm text-muted-foreground">
            No open positions. Import from a screenshot or log one manually.
          </div>
        </div>
      )}

      <div className="space-y-2">
        {positions.map((p) => (
          <PositionCard
            key={p.id}
            kind="open"
            position={p}
            onCloseSubmitted={onImportSuccess}
          />
        ))}
      </div>

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
            {closedPositions?.map((p) => (
              <PositionCard key={p.id} kind="closed" position={p} />
            ))}
          </div>
        )}
      </div>

      <ImportScreenshotModal
        open={showScreenshot}
        onOpenChange={setShowScreenshot}
        onSuccess={onImportSuccess}
      />
      <ImportManualModal open={showManual} onOpenChange={setShowManual} onSuccess={onImportSuccess} />
    </div>
  );
}

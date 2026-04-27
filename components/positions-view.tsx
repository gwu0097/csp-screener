"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Briefcase, Camera, Loader2, Plus, RefreshCcw, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ImportScreenshotModal } from "@/components/import-screenshot-modal";
import { ImportManualModal } from "@/components/import-manual-modal";
import {
  COLLAPSED_ROW_GRID,
  PositionCard,
  type ClosedPositionClientView,
  type OpenPositionClientView,
} from "@/components/position-card";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

// Column header row for a group of position cards. Uses the exact same
// grid template as the collapsed row so labels sit above their data.
// Hidden on mobile (< sm) — the mobile card layout uses auto columns
// and the labels wouldn't align anyway.
function PositionsTableHeader() {
  return (
    <div
      className={cn(
        COLLAPSED_ROW_GRID,
        "hidden py-1 text-[10px] font-semibold uppercase text-muted-foreground sm:grid",
      )}
    >
      {/* 1 dot */}
      <div />
      {/* 2 */}
      <div>Symbol</div>
      {/* 3 */}
      <div>Strike</div>
      {/* 4 — hidden mobile */}
      <div className="hidden sm:block">Expiry</div>
      {/* 5 */}
      <div className="text-right">Qty</div>
      {/* 6 */}
      <div className="text-right">Stock</div>
      {/* 7 */}
      <div className="text-right">P&amp;L</div>
      {/* 8 */}
      <div className="text-right">POP</div>
      {/* 9 — hidden mobile */}
      <div className="hidden text-right sm:block">% OTM</div>
      {/* 10 — hidden mobile */}
      <div className="hidden text-right sm:block">IV</div>
      {/* 11 — hidden mobile */}
      <div className="hidden text-right sm:block">θ</div>
      {/* 12 */}
      <div>Grade</div>
      {/* 13 */}
      <div className="text-right">Status</div>
    </div>
  );
}
import { fmtDollarsSigned } from "@/lib/format";
import type { MarketContext } from "@/lib/market";

// localStorage cache of the last successful /api/positions/open?live=true
// response — lets us populate live fields immediately on page load
// instead of flashing "—" until the user hits Refresh live data.
const LS_LIVE_CACHE = "positions_live_cache";

// Fields that only exist on a live fetch. Everything else on the open
// position row (grades, opened date, etc.) comes from the DB and is
// present on both live=false and live=true responses.
const LIVE_FIELDS = [
  "currentStockPrice",
  "currentMark",
  "currentBid",
  "currentAsk",
  "currentDelta",
  "currentTheta",
  "currentIv",
  "pnlDollars",
  "pnlPct",
  "distanceToStrikePct",
  "thetaDecayTotal",
  "momentum",
  "urgency",
  "recommendationReason",
] as const;

type LiveCacheEntry = Partial<Pick<OpenPositionClientView, (typeof LIVE_FIELDS)[number]>>;
type LiveCache = { fetchedAt: string; byId: Record<string, LiveCacheEntry> };

function readLiveCache(): LiveCache | null {
  try {
    const raw = localStorage.getItem(LS_LIVE_CACHE);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as LiveCache;
    if (!parsed || !parsed.fetchedAt || !parsed.byId) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeLiveCache(positions: OpenPositionClientView[]): LiveCache {
  const byId: Record<string, LiveCacheEntry> = {};
  for (const p of positions) {
    const entry: LiveCacheEntry = {};
    for (const f of LIVE_FIELDS) {
      // @ts-expect-error runtime shape matches the typed fields list
      entry[f] = p[f];
    }
    byId[p.id] = entry;
  }
  const cache: LiveCache = { fetchedAt: new Date().toISOString(), byId };
  try {
    localStorage.setItem(LS_LIVE_CACHE, JSON.stringify(cache));
  } catch {
    /* quota exceeded — ignore, cache is best-effort */
  }
  return cache;
}

function mergeCacheIntoPositions(
  positions: OpenPositionClientView[],
  cache: LiveCache,
): OpenPositionClientView[] {
  return positions.map((p) => {
    const cached = cache.byId[p.id];
    if (!cached) return p;
    // Only fill cached values where the fresh row has them null/undefined —
    // a true live refresh always wins.
    const merged = { ...p };
    for (const f of LIVE_FIELDS) {
      const liveVal = (p as Record<string, unknown>)[f];
      if (liveVal === null || liveVal === undefined) {
        // @ts-expect-error runtime shape matches the typed fields list
        merged[f] = cached[f] ?? liveVal;
      }
    }
    return merged;
  });
}

function fmtTimeShort(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

// Section label + ordering for the broker groups. Anything not in
// this list (or missing a broker) falls into the "Other" bucket and
// renders last.
const BROKER_ORDER = ["schwab", "robinhood"] as const;
const BROKER_LABEL: Record<string, string> = {
  schwab: "Schwab",
  robinhood: "Robinhood",
  other: "Other",
};

function groupByBroker<T extends { broker?: string | null; remainingContracts?: number }>(
  items: T[],
): Array<{ key: string; label: string; items: T[]; contractCount: number }> {
  const groups = new Map<string, T[]>();
  for (const it of items) {
    const b = (it.broker ?? "").toLowerCase();
    const key =
      b === "schwab" || b === "robinhood" ? b : b.length > 0 ? b : "other";
    const arr = groups.get(key) ?? [];
    arr.push(it);
    groups.set(key, arr);
  }
  const ordered: Array<{ key: string; label: string; items: T[]; contractCount: number }> = [];
  for (const k of BROKER_ORDER) {
    const items = groups.get(k);
    if (items && items.length > 0) {
      ordered.push({
        key: k,
        label: BROKER_LABEL[k] ?? k,
        items,
        contractCount: items.reduce((s, p) => s + (p.remainingContracts ?? 0), 0),
      });
      groups.delete(k);
    }
  }
  // Any remaining groups (unknown brokers) collapse into "Other" at the end.
  const remaining: T[] = [];
  for (const arr of Array.from(groups.values())) remaining.push(...arr);
  if (remaining.length > 0) {
    ordered.push({
      key: "other",
      label: BROKER_LABEL.other,
      items: remaining,
      contractCount: remaining.reduce((s, p) => s + (p.remainingContracts ?? 0), 0),
    });
  }
  return ordered;
}

type ExpireReport = {
  auto_expired: Array<{
    symbol: string;
    strike: number;
    realized_pnl: number;
  }>;
  needs_verification: unknown[];
  pending: unknown[];
  skipped: boolean;
  skipReason?: string;
};

type PositionsResponse = {
  market: MarketContext;
  positions: OpenPositionClientView[];
  opportunityAvailable: boolean;
  live: boolean;
  expireReport?: ExpireReport;
  snapshotsWritten?: number;
  snapshotsSkipped?: number;
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
  // When the last live refresh was cached to localStorage, for the
  // "Live data as of [time]" label. Null = never refreshed (or cache
  // was cleared manually).
  const [liveCacheFetchedAt, setLiveCacheFetchedAt] = useState<string | null>(null);
  // Result of the most recent live refresh — drives the "N snapshots
  // saved" / "snapshots up to date" suffix after the timestamp. Null
  // when we haven't done a live fetch yet this session.
  const [liveSnapshotSummary, setLiveSnapshotSummary] = useState<
    { written: number; skipped: number } | null
  >(null);

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
      if (live) {
        // Fresh live fetch — cache the per-position live fields so the
        // next page load can hydrate immediately instead of showing "—".
        const cache = writeLiveCache(json.positions);
        setLiveCacheFetchedAt(cache.fetchedAt);
        setLiveSnapshotSummary({
          written: json.snapshotsWritten ?? 0,
          skipped: json.snapshotsSkipped ?? 0,
        });
        setData(json);
      } else {
        // Non-live fetch: merge cached live fields so P&L/Greeks
        // survive the page load. A true live refresh later overwrites.
        const cache = readLiveCache();
        if (cache) {
          setLiveCacheFetchedAt(cache.fetchedAt);
          setData({ ...json, positions: mergeCacheIntoPositions(json.positions, cache) });
        } else {
          setData(json);
        }
      }
      // Surface the auto-expire toast once per load if anything got
      // auto-closed. One green message, every auto-expired position
      // listed inline with its realized P&L.
      const expired = json.expireReport?.auto_expired ?? [];
      if (expired.length > 0) {
        const bits = expired.map((e) => {
          const sign = e.realized_pnl >= 0 ? "+" : "";
          return `${e.symbol} ${sign}$${e.realized_pnl.toFixed(0)}`;
        });
        setMessage(`✓ Expired worthless: ${bits.join(" | ")}`);
      }
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
          {data && positions.length > 0 && (
            <span className="text-xs text-muted-foreground">
              {liveCacheFetchedAt
                ? `Live data as of ${fmtTimeShort(liveCacheFetchedAt)}`
                : "Live data not loaded"}
              {liveSnapshotSummary && (
                <>
                  {" · "}
                  {liveSnapshotSummary.written > 0
                    ? `${liveSnapshotSummary.written} snapshot${liveSnapshotSummary.written === 1 ? "" : "s"} saved`
                    : "snapshots up to date"}
                </>
              )}
            </span>
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

      {groupByBroker(positions).map((group) => (
        <div key={group.key} className="space-y-2">
          <div className="flex items-baseline gap-2 pt-2 text-xs font-semibold uppercase text-muted-foreground">
            <span>{group.label}</span>
            <span className="font-normal normal-case">
              ({group.contractCount} {group.contractCount === 1 ? "contract" : "contracts"})
            </span>
          </div>
          <PositionsTableHeader />
          {group.items.map((p) => (
            <PositionCard
              key={p.id}
              kind="open"
              position={p}
              onCloseSubmitted={onImportSuccess}
              onPositionRemoved={(id) => {
                // Optimistic remove — drop the row from local state so
                // the UI updates instantly. We don't refetch; the next
                // Refresh / page reload will reconcile against the DB.
                setData((prev) =>
                  prev
                    ? {
                        ...prev,
                        positions: prev.positions.filter((q) => q.id !== id),
                      }
                    : prev,
                );
              }}
            />
          ))}
        </div>
      ))}

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
            {closedPositions !== null &&
              closedPositions.length > 0 &&
              groupByBroker(closedPositions).map((group) => (
                <div key={group.key} className="space-y-2">
                  <div className="flex items-baseline gap-2 pt-1 text-xs font-semibold uppercase text-muted-foreground">
                    <span>{group.label}</span>
                    <span className="font-normal normal-case">
                      ({group.items.length} {group.items.length === 1 ? "position" : "positions"})
                    </span>
                  </div>
                  <PositionsTableHeader />
                  {group.items.map((p) => (
                    <PositionCard key={p.id} kind="closed" position={p} />
                  ))}
                </div>
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

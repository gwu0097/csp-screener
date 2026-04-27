"use client";

// Multi-tab per-stock encyclopedia view. Distinct from /research/[symbol]:
// /research is the analytical view (catalysts, valuation, sentiment,
// risk — sourced from external research modules). /encyclopedia is the
// PERSONAL trading record — earnings outcomes the trader has lived
// through, closed positions, swing-screener appearances, plus a thin
// pointer back to the research view.
//
// Tabs (left to right):
//   Overview      — header + quick stats + maintenance buttons
//   CSP History   — per-quarter earnings + flow + trade decision
//   My Trades     — closed CSP positions for this symbol
//   Swing History — appearances in the swing screener
//   Research      — module digests with link to full /research/[symbol]

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  AlertTriangle,
  ChevronLeft,
  ExternalLink,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { CspHistoryTab } from "@/components/encyclopedia-csp-history";

type StockEncyclopedia = {
  id: string;
  symbol: string;
  total_earnings_records: number;
  crush_rate: number | null;
  avg_move_ratio: number | null;
  beat_rate: number | null;
  recovery_rate_after_breach: number | null;
  avg_iv_crush_magnitude: number | null;
  updated_at: string | null;
};

// Crush stats derived live from earnings_history on the server, since
// the stock_encyclopedia aggregate columns can be stale or null. Both
// require BOTH implied + actual move to be present on a row.
type ComputedCrushStats = {
  totalEvents: number;
  crushedCount: number;
  crushRate: number | null;
  avgRatio: number | null;
};

type StockInfo = {
  symbol: string;
  company_name: string | null;
  sector: string | null;
  industry: string | null;
  market_cap: number | null;
  overall_grade: string | null;
  grade_reasoning: string | null;
  last_researched_at: string | null;
};

type ModuleSummary = {
  type: string;
  label: string;
  grade: string | null;
  headline: string | null;
  runAt: string;
  isExpired: boolean;
};

type Outcome = "expired_worthless" | "assigned" | "closed";

type TradeView = {
  id: string;
  openedDate: string;
  closedDate: string | null;
  strike: number;
  expiry: string;
  optionType: string | null;
  broker: string | null;
  contracts: number | null;
  premiumSold: number | null;
  realizedPnl: number | null;
  outcome: Outcome;
  notes: string | null;
};

type TradesPayload = {
  trades: TradeView[];
  summary: {
    totalTrades: number;
    totalPnl: number;
    winRate: number | null;
    expiredWorthless: number;
    assigned: number;
    closed: number;
  };
};

type ScanView = {
  scannedAt: string;
  category: string;
  confidence: string | null;
  signalBasis: string | null;
};

type SwingsPayload = {
  scans: ScanView[];
  summary: {
    totalAppearances: number;
    categories: string[];
  };
};

const VALID_TABS = new Set([
  "overview",
  "csp",
  "trades",
  "swings",
  "research",
]);

// ---------- formatters ----------

function fmtPct(v: number | null, digits = 1): string {
  if (v === null || !Number.isFinite(v)) return "—";
  return `${(v * 100).toFixed(digits)}%`;
}
function fmtNum(v: number | null, digits = 2): string {
  if (v === null || !Number.isFinite(v)) return "—";
  return v.toFixed(digits);
}
function fmtDollarsSigned(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return "—";
  const sign = v >= 0 ? "+" : "";
  return `${sign}$${v.toFixed(2)}`;
}
function fmtMarketCap(cap: number | null): string {
  if (cap === null || !Number.isFinite(cap)) return "—";
  if (cap >= 1e12) return `$${(cap / 1e12).toFixed(2)}T`;
  if (cap >= 1e9) return `$${(cap / 1e9).toFixed(2)}B`;
  if (cap >= 1e6) return `$${(cap / 1e6).toFixed(0)}M`;
  return `$${cap.toFixed(0)}`;
}
function fmtDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString();
}
function gradeColor(g: string | null | undefined): string {
  if (g === "A") return "bg-emerald-500/20 text-emerald-300 border-emerald-500/40";
  if (g === "B") return "bg-sky-500/20 text-sky-300 border-sky-500/40";
  if (g === "C") return "bg-amber-500/20 text-amber-300 border-amber-500/40";
  if (g === "D") return "bg-orange-500/20 text-orange-300 border-orange-500/40";
  if (g === "F") return "bg-rose-500/20 text-rose-300 border-rose-500/40";
  return "bg-muted/40 text-muted-foreground border-border";
}
function outcomeBadgeClass(o: Outcome): string {
  if (o === "expired_worthless")
    return "bg-emerald-500/15 text-emerald-300 border-emerald-500/40";
  if (o === "assigned")
    return "bg-amber-500/15 text-amber-300 border-amber-500/40";
  return "bg-zinc-500/15 text-zinc-300 border-zinc-500/40";
}
function outcomeLabel(o: Outcome): string {
  if (o === "expired_worthless") return "EXPIRED";
  if (o === "assigned") return "ASSIGNED";
  return "CLOSED";
}

// ---------- top-level ----------

export function EncyclopediaStockView({ symbol }: { symbol: string }) {
  const searchParams = useSearchParams();
  const initialTab = searchParams?.get("tab");
  const [tab, setTab] = useState(
    initialTab && VALID_TABS.has(initialTab) ? initialTab : "overview",
  );

  // Overview eagerly loads all summary data so the tab strip can show
  // counts and quick stats without each tab being clicked first. Tabs
  // that own deeper data (CSP / Trades / Swings / Research) re-fetch
  // when activated to render full payloads.
  const [encyclopedia, setEncyclopedia] = useState<StockEncyclopedia | null>(null);
  const [computed, setComputed] = useState<ComputedCrushStats | null>(null);
  const [stock, setStock] = useState<StockInfo | null>(null);
  const [tradesSummary, setTradesSummary] = useState<TradesPayload["summary"] | null>(null);
  const [swingsSummary, setSwingsSummary] = useState<SwingsPayload["summary"] | null>(null);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const [overviewLoading, setOverviewLoading] = useState(true);
  // Maintenance: refresh historical earnings + re-ingest historical dates.
  const [maintenanceMsg, setMaintenanceMsg] = useState<string | null>(null);
  const [maintenanceErr, setMaintenanceErr] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const loadOverview = useMemo(
    () =>
      async function loadOverview() {
        setOverviewLoading(true);
        setOverviewError(null);
        const fetches = await Promise.all([
          fetch(`/api/encyclopedia/${encodeURIComponent(symbol)}`, {
            cache: "no-store",
          }).then(
            (r) =>
              r.json() as Promise<{
                encyclopedia: StockEncyclopedia | null;
                computed?: ComputedCrushStats;
                error?: string;
              }>,
          ),
          fetch(
            `/api/encyclopedia/${encodeURIComponent(symbol)}/research-summary`,
            { cache: "no-store" },
          ).then((r) => r.json() as Promise<{ stock: StockInfo | null; error?: string }>),
          fetch(`/api/encyclopedia/${encodeURIComponent(symbol)}/trades`, {
            cache: "no-store",
          }).then((r) => r.json() as Promise<TradesPayload & { error?: string }>),
          fetch(`/api/encyclopedia/${encodeURIComponent(symbol)}/swings`, {
            cache: "no-store",
          }).then((r) => r.json() as Promise<SwingsPayload & { error?: string }>),
        ]);
        const [encJson, stockJson, tradesJson, swingsJson] = fetches;
        if (encJson.error) setOverviewError(encJson.error);
        setEncyclopedia(encJson.encyclopedia ?? null);
        setComputed(encJson.computed ?? null);
        setStock(stockJson.stock ?? null);
        setTradesSummary(tradesJson.summary ?? null);
        setSwingsSummary(swingsJson.summary ?? null);
        setOverviewLoading(false);
      },
    [symbol],
  );

  useEffect(() => {
    void loadOverview();
  }, [loadOverview]);

  async function refreshEarningsHistory() {
    setRefreshing(true);
    setMaintenanceMsg(null);
    setMaintenanceErr(null);
    try {
      const res = await fetch("/api/encyclopedia/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbols: [symbol] }),
      });
      const json = (await res.json()) as {
        updated?: Array<{ symbol: string; newRecords: number; updatedRecords: number }>;
        errors?: Array<{ symbol: string; error: string }>;
        error?: string;
      };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      const u = json.updated?.[0];
      setMaintenanceMsg(
        u
          ? `Refreshed ${u.symbol}: ${u.newRecords} new, ${u.updatedRecords} updated`
          : `Errors: ${(json.errors ?? []).map((e) => `${e.symbol}: ${e.error}`).join("; ")}`,
      );
      await loadOverview();
    } catch (e) {
      setMaintenanceErr(e instanceof Error ? e.message : "refresh failed");
    } finally {
      setRefreshing(false);
    }
  }

  async function reingestHistory() {
    setRefreshing(true);
    setMaintenanceMsg(null);
    setMaintenanceErr(null);
    try {
      const res = await fetch("/api/encyclopedia/reingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbols: [symbol] }),
      });
      const json = (await res.json()) as {
        results?: Array<{
          symbol: string;
          reingested: number;
          merged_with_existing: number;
          unmatched_rows: Array<{ oldDate: string; reason: string }>;
          already_clean: boolean;
        }>;
        errors?: Array<{ symbol: string; error: string }>;
        error?: string;
      };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      const r = json.results?.[0];
      if (r) {
        const unmatched =
          r.unmatched_rows.length > 0
            ? ` · ${r.unmatched_rows.length} unmatched`
            : "";
        setMaintenanceMsg(
          r.already_clean
            ? `${r.symbol}: already clean`
            : `Re-ingested ${r.symbol}: ${r.reingested} re-keyed, ${r.merged_with_existing} merged${unmatched}`,
        );
      } else {
        setMaintenanceMsg(
          `Errors: ${(json.errors ?? []).map((e) => `${e.symbol}: ${e.error}`).join("; ")}`,
        );
      }
      await loadOverview();
    } catch (e) {
      setMaintenanceErr(e instanceof Error ? e.message : "re-ingest failed");
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <Link
          href="/encyclopedia"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="h-3 w-3" />
          Back to Encyclopedia
        </Link>
      </div>

      <Header symbol={symbol} stock={stock} />

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="flex flex-wrap">
          <TabsTrigger value="overview">📋 Overview</TabsTrigger>
          <TabsTrigger value="csp">📈 CSP History</TabsTrigger>
          <TabsTrigger value="trades">💼 My Trades</TabsTrigger>
          <TabsTrigger value="swings">🌊 Swing History</TabsTrigger>
          <TabsTrigger value="research">🔬 Research</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-3">
          <OverviewTab
            symbol={symbol}
            stock={stock}
            encyclopedia={encyclopedia}
            computed={computed}
            tradesSummary={tradesSummary}
            swingsSummary={swingsSummary}
            loading={overviewLoading}
            error={overviewError}
            refreshing={refreshing}
            maintenanceMsg={maintenanceMsg}
            maintenanceErr={maintenanceErr}
            onRefresh={refreshEarningsHistory}
            onReingest={reingestHistory}
          />
        </TabsContent>

        <TabsContent value="csp">
          <CspHistoryTab symbol={symbol} />
        </TabsContent>

        <TabsContent value="trades">
          <TradesTab symbol={symbol} />
        </TabsContent>

        <TabsContent value="swings">
          <SwingsTab symbol={symbol} />
        </TabsContent>

        <TabsContent value="research">
          <ResearchTab symbol={symbol} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ---------- header ----------

function Header({ symbol, stock }: { symbol: string; stock: StockInfo | null }) {
  return (
    <div className="rounded border border-border bg-background/40 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-semibold">{symbol}</span>
            {stock?.company_name && (
              <span className="text-sm text-muted-foreground">
                {stock.company_name}
              </span>
            )}
            {stock?.overall_grade && (
              <span
                className={`rounded border px-2 py-0.5 text-[11px] font-semibold ${gradeColor(stock.overall_grade)}`}
                title={stock.grade_reasoning ?? undefined}
              >
                {stock.overall_grade}
              </span>
            )}
          </div>
          <div className="mt-1 flex flex-wrap gap-3 text-xs text-muted-foreground">
            {stock?.sector && <span>{stock.sector}</span>}
            {stock?.industry && (
              <span className="text-muted-foreground/60">· {stock.industry}</span>
            )}
            {stock?.market_cap !== null && stock?.market_cap !== undefined && (
              <span>· Mkt cap {fmtMarketCap(stock.market_cap)}</span>
            )}
            <span>
              · Last researched: {fmtDateTime(stock?.last_researched_at ?? null)}
            </span>
          </div>
        </div>
        <Link
          href={`/research/${encodeURIComponent(symbol)}`}
          className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ExternalLink className="h-3 w-3" />
          Open in Research
        </Link>
      </div>
    </div>
  );
}

// ---------- overview tab ----------

function OverviewTab({
  symbol,
  encyclopedia,
  computed,
  tradesSummary,
  swingsSummary,
  loading,
  error,
  refreshing,
  maintenanceMsg,
  maintenanceErr,
  onRefresh,
  onReingest,
}: {
  symbol: string;
  stock: StockInfo | null;
  encyclopedia: StockEncyclopedia | null;
  computed: ComputedCrushStats | null;
  tradesSummary: TradesPayload["summary"] | null;
  swingsSummary: SwingsPayload["summary"] | null;
  loading: boolean;
  error: string | null;
  refreshing: boolean;
  maintenanceMsg: string | null;
  maintenanceErr: string | null;
  onRefresh: () => void;
  onReingest: () => void;
}) {
  if (loading && !encyclopedia && !tradesSummary) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading {symbol}…
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {error && (
        <div className="rounded border border-rose-500/40 bg-rose-500/10 p-2 text-sm text-rose-300">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard
          label="Earnings events tracked"
          value={
            encyclopedia
              ? String(encyclopedia.total_earnings_records)
              : "—"
          }
          sub={
            computed && computed.totalEvents > 0
              ? `Crush rate ${fmtPct(computed.crushRate, 0)} (${computed.crushedCount} of ${computed.totalEvents} quarters) · Avg ratio ${fmtNum(computed.avgRatio, 2)}×`
              : encyclopedia
                ? "No quarters with both implied + actual moves yet — Refresh or run the screener at the next event."
                : "Click Refresh data to backfill from Finnhub"
          }
        />
        <StatCard
          label="CSP trades"
          value={
            tradesSummary ? String(tradesSummary.totalTrades) : "—"
          }
          sub={
            tradesSummary
              ? `${tradesSummary.expiredWorthless} expired · ${tradesSummary.assigned} assigned · ${tradesSummary.closed} closed`
              : ""
          }
          accent={
            tradesSummary && tradesSummary.totalTrades > 0
              ? `Realized P&L: ${fmtDollarsSigned(tradesSummary.totalPnl)}`
              : null
          }
          accentColor={
            tradesSummary && tradesSummary.totalPnl > 0
              ? "text-emerald-300"
              : tradesSummary && tradesSummary.totalPnl < 0
                ? "text-rose-300"
                : "text-muted-foreground"
          }
        />
        <StatCard
          label="Swing screener appearances"
          value={
            swingsSummary
              ? String(swingsSummary.totalAppearances)
              : "—"
          }
          sub={
            swingsSummary && swingsSummary.totalAppearances > 0
              ? `Categories: ${swingsSummary.categories.join(", ")}`
              : "Hasn't appeared yet"
          }
        />
      </div>

      {tradesSummary && tradesSummary.totalTrades > 0 && (
        <div className="rounded border border-border bg-background/40 p-3 text-xs text-muted-foreground">
          Win rate:{" "}
          <span className="text-foreground">
            {tradesSummary.winRate !== null
              ? fmtPct(tradesSummary.winRate, 0)
              : "—"}
          </span>
          {" · "}
          {encyclopedia?.beat_rate !== null && encyclopedia?.beat_rate !== undefined && (
            <>
              EPS beat rate:{" "}
              <span className="text-foreground">
                {fmtPct(encyclopedia.beat_rate, 0)}
              </span>
              {" · "}
            </>
          )}
          {encyclopedia?.recovery_rate_after_breach !== null &&
            encyclopedia?.recovery_rate_after_breach !== undefined && (
              <>
                Breach recovery:{" "}
                <span className="text-foreground">
                  {fmtPct(encyclopedia.recovery_rate_after_breach, 0)}
                </span>
              </>
            )}
        </div>
      )}

      <div className="rounded border border-border bg-background/40 p-3">
        <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Maintenance
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={onRefresh} disabled={refreshing} size="sm">
            {refreshing ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <RefreshCw className="h-3 w-3" />
            )}
            <span className="ml-1">Refresh earnings data</span>
          </Button>
          <Button
            onClick={onReingest}
            disabled={refreshing}
            size="sm"
            variant="outline"
          >
            {refreshing ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <RefreshCw className="h-3 w-3" />
            )}
            <span className="ml-1">Re-ingest historical dates</span>
          </Button>
          {encyclopedia?.updated_at && (
            <span className="text-xs text-muted-foreground">
              Last updated: {fmtDateTime(encyclopedia.updated_at)}
            </span>
          )}
        </div>
        {maintenanceErr && (
          <div className="mt-2 text-xs text-rose-300">{maintenanceErr}</div>
        )}
        {maintenanceMsg && !maintenanceErr && (
          <div className="mt-2 text-xs text-emerald-300">{maintenanceMsg}</div>
        )}
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  sub,
  accent,
  accentColor,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: string | null;
  accentColor?: string;
}) {
  return (
    <div className="rounded border border-border bg-background/40 p-3">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="mt-0.5 text-2xl font-semibold">{value}</div>
      {accent && (
        <div className={`mt-1 font-mono text-xs ${accentColor ?? ""}`}>
          {accent}
        </div>
      )}
      {sub && (
        <div className="mt-1 text-xs text-muted-foreground">{sub}</div>
      )}
    </div>
  );
}

// ---------- trades tab ----------

function TradesTab({ symbol }: { symbol: string }) {
  const [data, setData] = useState<TradesPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function run() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(
          `/api/encyclopedia/${encodeURIComponent(symbol)}/trades`,
          { cache: "no-store" },
        );
        const json = (await res.json()) as TradesPayload & { error?: string };
        if (cancelled) return;
        if (!res.ok || json.error) {
          throw new Error(json.error ?? `HTTP ${res.status}`);
        }
        setData(json);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, [symbol]);

  if (loading) return <Spinner label={`Loading ${symbol} trades…`} />;
  if (error) return <ErrorBanner message={error} />;
  if (!data || data.trades.length === 0) {
    return (
      <EmptyState>
        No closed CSP trades on {symbol} yet.
      </EmptyState>
    );
  }

  return (
    <div className="space-y-3">
      <div className="rounded border border-border bg-background/40 p-3 text-xs">
        <div className="flex flex-wrap items-baseline gap-3">
          <span>
            <span className="text-muted-foreground">Trades:</span>{" "}
            <span className="font-semibold">{data.summary.totalTrades}</span>
          </span>
          <span>
            <span className="text-muted-foreground">Realized P&amp;L:</span>{" "}
            <span
              className={`font-mono font-semibold ${data.summary.totalPnl >= 0 ? "text-emerald-300" : "text-rose-300"}`}
            >
              {fmtDollarsSigned(data.summary.totalPnl)}
            </span>
          </span>
          <span>
            <span className="text-muted-foreground">Win rate:</span>{" "}
            <span className="font-semibold">
              {data.summary.winRate !== null
                ? fmtPct(data.summary.winRate, 0)
                : "—"}
            </span>
          </span>
          <span className="text-muted-foreground">
            ({data.summary.expiredWorthless} expired · {data.summary.assigned} assigned ·{" "}
            {data.summary.closed} closed)
          </span>
        </div>
      </div>

      <div className="overflow-x-auto rounded border border-border">
        <table className="min-w-full text-xs">
          <thead className="bg-background/60">
            <tr className="text-left text-[10px] uppercase tracking-wide text-muted-foreground">
              <th className="px-2 py-1.5">Opened</th>
              <th className="px-2 py-1.5">Closed</th>
              <th className="px-2 py-1.5 text-right">Strike</th>
              <th className="px-2 py-1.5">Expiry</th>
              <th className="px-2 py-1.5 text-right">Qty</th>
              <th className="px-2 py-1.5 text-right">Premium</th>
              <th className="px-2 py-1.5 text-right">P&amp;L</th>
              <th className="px-2 py-1.5 text-center">Outcome</th>
            </tr>
          </thead>
          <tbody>
            {data.trades.map((t) => (
              <tr key={t.id} className="border-t border-border">
                <td className="px-2 py-1.5 font-mono">{t.openedDate}</td>
                <td className="px-2 py-1.5 font-mono">{t.closedDate ?? "—"}</td>
                <td className="px-2 py-1.5 text-right font-mono">
                  ${t.strike}
                  {t.optionType === "put"
                    ? "P"
                    : t.optionType === "call"
                      ? "C"
                      : ""}
                </td>
                <td className="px-2 py-1.5 font-mono">{t.expiry}</td>
                <td className="px-2 py-1.5 text-right">×{t.contracts ?? "?"}</td>
                <td className="px-2 py-1.5 text-right font-mono">
                  {t.premiumSold !== null ? `$${t.premiumSold.toFixed(2)}` : "—"}
                </td>
                <td
                  className={`px-2 py-1.5 text-right font-mono ${(t.realizedPnl ?? 0) > 0 ? "text-emerald-300" : (t.realizedPnl ?? 0) < 0 ? "text-rose-300" : "text-muted-foreground"}`}
                >
                  {fmtDollarsSigned(t.realizedPnl)}
                </td>
                <td className="px-2 py-1.5 text-center">
                  <span
                    className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold ${outcomeBadgeClass(t.outcome)}`}
                  >
                    {outcomeLabel(t.outcome)}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------- swings tab ----------

function SwingsTab({ symbol }: { symbol: string }) {
  const [data, setData] = useState<SwingsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function run() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(
          `/api/encyclopedia/${encodeURIComponent(symbol)}/swings`,
          { cache: "no-store" },
        );
        const json = (await res.json()) as SwingsPayload & { error?: string };
        if (cancelled) return;
        if (!res.ok || json.error) {
          throw new Error(json.error ?? `HTTP ${res.status}`);
        }
        setData(json);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, [symbol]);

  if (loading) return <Spinner label={`Loading ${symbol} swing history…`} />;
  if (error) return <ErrorBanner message={error} />;
  if (!data || data.scans.length === 0) {
    return (
      <EmptyState>
        {symbol} hasn&apos;t appeared in the swing screener yet.
      </EmptyState>
    );
  }

  return (
    <div className="space-y-3">
      <div className="rounded border border-border bg-background/40 p-3 text-xs">
        <span className="text-muted-foreground">Appearances:</span>{" "}
        <span className="font-semibold">{data.summary.totalAppearances}</span>
        {" · "}
        <span className="text-muted-foreground">Categories:</span>{" "}
        <span className="font-semibold">{data.summary.categories.join(", ")}</span>
      </div>
      <div className="overflow-x-auto rounded border border-border">
        <table className="min-w-full text-xs">
          <thead className="bg-background/60">
            <tr className="text-left text-[10px] uppercase tracking-wide text-muted-foreground">
              <th className="px-2 py-1.5">Scanned</th>
              <th className="px-2 py-1.5">Category</th>
              <th className="px-2 py-1.5">Confidence</th>
              <th className="px-2 py-1.5">Signal basis</th>
            </tr>
          </thead>
          <tbody>
            {data.scans.map((s, i) => (
              <tr key={`${s.scannedAt}-${i}`} className="border-t border-border">
                <td className="px-2 py-1.5 font-mono">
                  {fmtDateTime(s.scannedAt)}
                </td>
                <td className="px-2 py-1.5">{s.category}</td>
                <td className="px-2 py-1.5">{s.confidence ?? "—"}</td>
                <td className="px-2 py-1.5 text-muted-foreground">
                  {s.signalBasis ?? "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------- research tab ----------

function ResearchTab({ symbol }: { symbol: string }) {
  const [modules, setModules] = useState<ModuleSummary[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function run() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(
          `/api/encyclopedia/${encodeURIComponent(symbol)}/research-summary`,
          { cache: "no-store" },
        );
        const json = (await res.json()) as {
          stock: StockInfo | null;
          modules: ModuleSummary[];
          error?: string;
        };
        if (cancelled) return;
        if (!res.ok || json.error) {
          throw new Error(json.error ?? `HTTP ${res.status}`);
        }
        setModules(json.modules ?? []);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, [symbol]);

  if (loading) return <Spinner label={`Loading ${symbol} research summary…`} />;
  if (error) return <ErrorBanner message={error} />;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs text-muted-foreground">
        <span>
          Latest run summary per research module. Open the full module
          on the research page.
        </span>
        <Link
          href={`/research/${encodeURIComponent(symbol)}`}
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ExternalLink className="h-3 w-3" />
          /research/{symbol}
        </Link>
      </div>
      {!modules || modules.length === 0 ? (
        <EmptyState>
          No research modules have been run for {symbol} yet. Open the
          research page to run the first one.
        </EmptyState>
      ) : (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {modules.map((m) => (
            <div
              key={m.type}
              className="rounded border border-border bg-background/40 p-3"
            >
              <div className="flex items-center justify-between">
                <div className="text-sm font-semibold">{m.label}</div>
                <div className="flex items-center gap-1.5">
                  {m.grade && (
                    <span
                      className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold ${gradeColor(m.grade)}`}
                    >
                      {m.grade}
                    </span>
                  )}
                  {m.isExpired && (
                    <span
                      className="rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-amber-300"
                      title="Module is past its cache TTL — re-run on the research page"
                    >
                      stale
                    </span>
                  )}
                </div>
              </div>
              {m.headline && (
                <div className="mt-1.5 text-xs text-muted-foreground">
                  {m.headline}
                </div>
              )}
              <div className="mt-2 text-[10px] text-muted-foreground">
                Last run: {fmtDateTime(m.runAt)}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------- shared bits ----------

function Spinner({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-center rounded-md border border-border bg-background/40 px-6 py-12 text-sm text-muted-foreground">
      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
      {label}
    </div>
  );
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
      <AlertTriangle className="mr-1.5 inline h-3 w-3" />
      {message}
    </div>
  );
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-dashed border-border bg-background/40 px-6 py-12 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

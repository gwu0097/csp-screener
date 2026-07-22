"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Loader2,
  RefreshCw,
  Search,
} from "lucide-react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PriceChart } from "@/components/price-chart";
import { MarkdownBody } from "@/components/filing-analysis";
import { stripCitations } from "@/lib/text";
import { cn } from "@/lib/utils";

type WatchlistMeta = {
  id: string;
  name: string;
  isPortfolio: boolean;
};

export type BuyZoneRow = {
  symbol: string;
  companyName: string | null;
  price: number | null;
  changePct: number | null;
  rsi14: number | null;
  buyZoneRsiScore: number;
  buyZoneMacdScore: number;
  buyZoneComposite: number;
  buyZoneMacdStatus: string;
  analystTarget: number | null;
  upsideToTarget: number | null;
  fiftyTwoWeekLow: number | null;
  fiftyTwoWeekHigh: number | null;
  watchlistNames: string[];
};

export type InsiderTx = {
  name: string;
  action: string;
  transactionCode: string;
  shares: number;
  price: number;
  date: string;
  type: "buy" | "sell";
  dollarValue: number;
};

export type ResearchData = {
  insider: {
    signal: "strong_bullish" | "bullish" | "neutral" | "bearish";
    executiveBuys: InsiderTx[];
    transactions: InsiderTx[];
  };
  catalyst: {
    analysis: string | null;
    date: string | null;
    isExpired: boolean;
    cached: boolean;
    fetched_at: string | null;
  };
};

function fmtMoney(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  return `$${n.toFixed(2)}`;
}

function fmtPct(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  const sign = n >= 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}

function rsiColor(rsi: number | null): string {
  if (rsi === null || !Number.isFinite(rsi)) return "text-muted-foreground";
  if (rsi < 40) return "text-emerald-300";
  if (rsi > 70) return "text-rose-300";
  return "text-amber-300";
}

function buyZoneBadgeColor(composite: number): string {
  if (composite >= 8) return "border-emerald-500/40 bg-emerald-500/10 text-emerald-300";
  if (composite >= 5) return "border-amber-500/40 bg-amber-500/10 text-amber-300";
  return "border-muted-foreground/30 bg-muted-foreground/10 text-muted-foreground";
}

function macdStatusColor(status: string): string {
  if (status.startsWith("crossed")) return "text-emerald-300";
  if (status === "approaching") return "text-amber-300";
  if (status === "widening") return "text-rose-300";
  return "text-muted-foreground";
}

function insiderSignalColor(signal: string): string {
  switch (signal) {
    case "strong_bullish": return "border-emerald-500/40 bg-emerald-500/10 text-emerald-300";
    case "bullish": return "border-emerald-500/30 bg-emerald-500/5 text-emerald-300/90";
    case "bearish": return "border-rose-500/40 bg-rose-500/10 text-rose-300";
    default: return "border-muted-foreground/30 bg-muted-foreground/10 text-muted-foreground";
  }
}

const ALL_SCOPE = "__all__";
const CHART_STUDIES = ["STD;RSI", "STD;MACD"];

type SortKey = "symbol" | "price" | "changePct" | "rsi14" | "macd" | "composite";
type SortDir = "asc" | "desc";

// Same two-state (always-active) asc/desc pattern as screener-view.tsx's
// SortableHeader — no unsorted state, one column is always active.
function SortableHeader({
  label,
  active,
  dir,
  align,
  onClick,
}: {
  label: string;
  active: boolean;
  dir: SortDir;
  align: "left" | "right" | "center";
  onClick: () => void;
}) {
  return (
    <th
      onClick={onClick}
      className={cn(
        "cursor-pointer select-none whitespace-nowrap px-2 py-2 hover:text-foreground",
        align === "right" ? "text-right" : align === "center" ? "text-center" : "text-left",
      )}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        {active &&
          (dir === "asc" ? (
            <ArrowUp className="h-3 w-3" />
          ) : (
            <ArrowDown className="h-3 w-3" />
          ))}
      </span>
    </th>
  );
}

// On-demand insider + catalyst research, keyed by symbol — fetched
// only when "Research" is clicked, cached in UI state for the
// session so re-expanding/re-opening an already-researched row
// doesn't re-fetch. Shared by the Buy Zone page and the dashboard's
// modal so both get the exact same fetch/cache behavior from one
// implementation.
export function useBuyZoneResearch() {
  const [research, setResearch] = useState<Record<string, ResearchData>>({});
  const [researchLoading, setResearchLoading] = useState<Set<string>>(new Set());
  const [researchError, setResearchError] = useState<Record<string, string>>({});

  async function loadResearch(symbol: string) {
    if (research[symbol]) return;
    if (researchLoading.has(symbol)) return;
    setResearchLoading((prev) => new Set(prev).add(symbol));
    setResearchError((prev) => {
      const next = { ...prev };
      delete next[symbol];
      return next;
    });
    try {
      const res = await fetch(`/api/analysis/buy-zone/research?symbol=${encodeURIComponent(symbol)}`, {
        cache: "no-store",
      });
      const json = (await res.json()) as ResearchData & { error?: string };
      if (!res.ok || json.error) throw new Error(json.error ?? `HTTP ${res.status}`);
      setResearch((prev) => ({ ...prev, [symbol]: { insider: json.insider, catalyst: json.catalyst } }));
    } catch (e) {
      setResearchError((prev) => ({ ...prev, [symbol]: e instanceof Error ? e.message : "Research failed" }));
    } finally {
      setResearchLoading((prev) => {
        const next = new Set(prev);
        next.delete(symbol);
        return next;
      });
    }
  }

  return { research, researchLoading, researchError, loadResearch };
}

export function BuyZoneView() {
  const [watchlists, setWatchlists] = useState<WatchlistMeta[] | null>(null);
  const [scope, setScope] = useState<string>(ALL_SCOPE);
  const [rows, setRows] = useState<BuyZoneRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<Date | null>(null);
  // Default sort is Buy Zone score descending; stays that way until
  // the person clicks a different header.
  const [sortKey, setSortKey] = useState<SortKey>("composite");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const { research, researchLoading, researchError, loadResearch } = useBuyZoneResearch();

  function onSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "symbol" ? "asc" : "desc");
    }
  }

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/watchlists", { cache: "no-store" });
        const json = (await res.json()) as { watchlists?: WatchlistMeta[] };
        setWatchlists(json.watchlists ?? []);
      } catch {
        setWatchlists([]);
      }
    })();
  }, []);

  const load = useCallback(async (watchlistId: string, force: boolean) => {
    if (force) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (watchlistId !== ALL_SCOPE) params.set("watchlistId", watchlistId);
      if (force) params.set("force", "1");
      const qs = params.toString();
      const res = await fetch(`/api/analysis/buy-zone${qs ? `?${qs}` : ""}`, { cache: "no-store" });
      const json = (await res.json()) as { rows?: BuyZoneRow[]; error?: string };
      if (!res.ok || json.error) throw new Error(json.error ?? `HTTP ${res.status}`);
      setRows(json.rows ?? []);
      setLastRefreshedAt(new Date());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
      setRows([]);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load(scope, false);
  }, [scope, load]);

  const sortedRows = useMemo<BuyZoneRow[] | null>(() => {
    if (!rows) return rows;
    const getter = (r: BuyZoneRow): number | string | null => {
      switch (sortKey) {
        case "symbol": return r.symbol;
        case "price": return r.price;
        case "changePct": return r.changePct;
        case "rsi14": return r.rsi14;
        case "macd": return r.buyZoneMacdScore;
        case "composite": return r.buyZoneComposite;
      }
    };
    const copy = [...rows];
    copy.sort((a, b) => {
      const av = getter(a);
      const bv = getter(b);
      if (typeof av === "string" || typeof bv === "string") {
        const cmp = String(av ?? "").localeCompare(String(bv ?? ""));
        return sortDir === "asc" ? cmp : -cmp;
      }
      // Nulls sink to the bottom regardless of direction.
      if (av === null && bv === null) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      return sortDir === "asc" ? av - bv : bv - av;
    });
    return copy;
  }, [rows, sortKey, sortDir]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Buy Zone</h1>
          <p className="text-base text-muted-foreground">
            Names closest to an oversold bullish turnaround — RSI approaching oversold plus a
            MACD bullish cross out of negative territory. Click any column to sort, click a row
            to expand.
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <button
            type="button"
            onClick={() => void load(scope, true)}
            disabled={refreshing}
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-2 text-base font-medium transition-colors hover:border-foreground/40 hover:text-foreground disabled:opacity-60"
          >
            <RefreshCw className={cn("h-4 w-4", refreshing && "animate-spin")} />
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
          {lastRefreshedAt && (
            <span className="text-[11px] text-muted-foreground">
              Last refreshed{" "}
              {lastRefreshedAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
            </span>
          )}
        </div>
      </div>

      <Tabs value={scope} onValueChange={setScope}>
        <TabsList>
          <TabsTrigger value={ALL_SCOPE}>All watchlists</TabsTrigger>
          {(watchlists ?? []).map((w) => (
            <TabsTrigger key={w.id} value={w.id}>
              {w.name}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {error && (
        <div className="rounded border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
          {error}
        </div>
      )}

      <div className="overflow-x-auto rounded-md border border-border bg-background/40">
        <table className="w-full min-w-[1000px] text-sm">
          <thead className="border-b border-border bg-background/60 text-[11px] uppercase tracking-wider text-muted-foreground">
            <tr>
              <SortableHeader label="Symbol" active={sortKey === "symbol"} dir={sortDir} align="left" onClick={() => onSort("symbol")} />
              <th className="px-2 py-2 text-left">Name</th>
              <SortableHeader label="Price" active={sortKey === "price"} dir={sortDir} align="right" onClick={() => onSort("price")} />
              <SortableHeader label="Change%" active={sortKey === "changePct"} dir={sortDir} align="right" onClick={() => onSort("changePct")} />
              <SortableHeader label="RSI" active={sortKey === "rsi14"} dir={sortDir} align="right" onClick={() => onSort("rsi14")} />
              <SortableHeader label="MACD" active={sortKey === "macd"} dir={sortDir} align="center" onClick={() => onSort("macd")} />
              <SortableHeader label="Buy Zone" active={sortKey === "composite"} dir={sortDir} align="center" onClick={() => onSort("composite")} />
              <th className="px-2 py-2 text-left">Lists</th>
            </tr>
          </thead>
          <tbody>
            {loading && rows === null && (
              <tr>
                <td colSpan={8} className="px-2 py-8 text-center">
                  <Loader2 className="mx-auto h-4 w-4 animate-spin text-muted-foreground" />
                </td>
              </tr>
            )}
            {!loading && rows && rows.length === 0 && (
              <tr>
                <td colSpan={8} className="px-2 py-8 text-center text-muted-foreground">
                  No symbols yet. Add some in Watchlists.
                </td>
              </tr>
            )}
            {sortedRows?.map((r) => (
              <BuyZoneRowItem
                key={r.symbol}
                row={r}
                research={research[r.symbol] ?? null}
                loading={researchLoading.has(r.symbol)}
                error={researchError[r.symbol] ?? null}
                onResearch={() => void loadResearch(r.symbol)}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function BuyZoneRowItem({
  row,
  research,
  loading,
  error,
  onResearch,
}: {
  row: BuyZoneRow;
  research: ResearchData | null;
  loading: boolean;
  error: string | null;
  onResearch: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const changeColor =
    row.changePct === null
      ? "text-muted-foreground"
      : row.changePct >= 0
        ? "text-emerald-300"
        : "text-rose-300";

  return (
    <>
      <tr
        onClick={() => setExpanded((s) => !s)}
        className="cursor-pointer border-b border-border/40 hover:bg-background/60"
      >
        <td className="px-2 py-1.5 font-mono font-semibold">
          <span className="inline-flex items-center gap-1">
            {expanded ? (
              <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
            )}
            {row.symbol}
          </span>
        </td>
        <td className="px-2 py-1.5 text-muted-foreground">{row.companyName ?? "—"}</td>
        <td className="px-2 py-1.5 text-right font-mono">{fmtMoney(row.price)}</td>
        <td className={cn("px-2 py-1.5 text-right font-mono", changeColor)}>
          {fmtPct(row.changePct)}
        </td>
        <td className="px-2 py-1.5 text-right">
          <div className={cn("font-mono", rsiColor(row.rsi14))}>
            {row.rsi14 !== null && Number.isFinite(row.rsi14) ? row.rsi14.toFixed(0) : "—"}
          </div>
          <div className="text-[10px] text-muted-foreground">{row.buyZoneRsiScore.toFixed(1)}/5</div>
        </td>
        <td className="px-2 py-1.5 text-center">
          <div className={cn("text-[11px] font-medium capitalize", macdStatusColor(row.buyZoneMacdStatus))}>
            {row.buyZoneMacdStatus}
          </div>
          <div className="text-[10px] text-muted-foreground">{row.buyZoneMacdScore.toFixed(1)}/5</div>
        </td>
        <td className="px-2 py-1.5 text-center">
          <span
            className={cn(
              "inline-block rounded border px-2 py-0.5 font-mono text-[12px] font-semibold",
              buyZoneBadgeColor(row.buyZoneComposite),
            )}
            title={`RSI ${row.buyZoneRsiScore.toFixed(1)} + MACD ${row.buyZoneMacdScore.toFixed(1)} = ${row.buyZoneComposite.toFixed(1)}`}
          >
            {row.buyZoneComposite.toFixed(1)}/10
          </span>
        </td>
        <td className="px-2 py-1.5">
          <span className="inline-flex flex-wrap items-center gap-1">
            {row.watchlistNames.map((name) => (
              <span
                key={name}
                className="rounded border border-border bg-background px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground"
              >
                {name}
              </span>
            ))}
          </span>
        </td>
      </tr>
      {expanded && (
        <tr className="border-b border-border/40 bg-background/30">
          <td colSpan={8} className="px-3 py-3">
            <BuyZoneDetailContent row={row} research={research} loading={loading} error={error} onResearch={onResearch} />
          </td>
        </tr>
      )}
    </>
  );
}

// The full expanded-row content: TradingView chart with RSI/MACD
// panes, the always-shown analyst read, and the on-demand Research
// panel. Exported so the dashboard's "Buy Zone" card can reuse this
// exact component inside a modal instead of a second copy.
export function BuyZoneDetailContent({
  row,
  research,
  loading,
  error,
  onResearch,
}: {
  row: BuyZoneRow;
  research: ResearchData | null;
  loading: boolean;
  error: string | null;
  onResearch: () => void;
}) {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[2fr_1fr]">
        {/* The public embed widget has no per-pane height config (checked
            its recognized config keys directly — no ratio/percentage
            option exists for price vs. study panes), so the only lever
            is total container height. RSI/MACD panes have a fixed-ish
            comfortable height regardless of total space, so growing the
            total gives that extra room almost entirely to price. */}
        {/* showDateRangeSelector={false}, no range passed: two interval-
            value fixes ("1D", then "D") both failed to change the
            rendered chart from an auto-picked 2H, which points at
            withdateranges (the interactive date-range button UI) as the
            real override — see PriceChart's showDateRangeSelector doc.
            Interval matching the RSI/MACD score (computed on daily
            bars) matters more than the 6M default zoom, so this drops
            the range selector rather than guessing at the interval
            value again. Not independently verified from this dev
            environment (no browser/screenshot tool) — check the live
            chart's own interval label and RSI reading against the
            row's RSI for the same symbol. */}
        <PriceChart
          symbol={row.symbol}
          studies={CHART_STUDIES}
          height={720}
          showDateRangeSelector={false}
        />
        <AnalystReadPanel row={row} />
      </div>
      <ResearchPanel row={row} research={research} loading={loading} error={error} onResearch={onResearch} />
    </div>
  );
}

// Analyst target/consensus — always shown on expand, no button. Data
// is already fetched as part of the same snapshot refresh the row's
// price/RSI/MACD come from, so this is zero additional cost.
function AnalystReadPanel({ row }: { row: BuyZoneRow }) {
  const hasRange = row.fiftyTwoWeekLow !== null && row.fiftyTwoWeekHigh !== null;
  return (
    <div className="space-y-3 rounded-md border border-border bg-background/40 p-3">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        Analyst read
      </div>
      {row.analystTarget === null ? (
        <p className="text-sm text-muted-foreground">No analyst target available.</p>
      ) : (
        <div className="space-y-1 text-sm">
          <div className="flex items-baseline justify-between">
            <span className="text-muted-foreground">Mean target</span>
            <span className="font-mono font-semibold">{fmtMoney(row.analystTarget)}</span>
          </div>
          <div className="flex items-baseline justify-between">
            <span className="text-muted-foreground">Upside to target</span>
            <span
              className={cn(
                "font-mono font-semibold",
                row.upsideToTarget !== null && row.upsideToTarget >= 0
                  ? "text-emerald-300"
                  : "text-rose-300",
              )}
            >
              {fmtPct(row.upsideToTarget)}
            </span>
          </div>
        </div>
      )}
      {hasRange && (
        <div className="flex items-baseline justify-between text-sm">
          <span className="text-muted-foreground">52-week range</span>
          <span className="font-mono">
            {fmtMoney(row.fiftyTwoWeekLow)} – {fmtMoney(row.fiftyTwoWeekHigh)}
          </span>
        </div>
      )}
    </div>
  );
}

// Insider activity + upcoming catalyst — collapsed until "Research"
// is clicked. Button visual states mirror the "FETCH EM HISTORY"
// pattern (idle / fetching / error / done).
function ResearchPanel({
  row,
  research,
  loading,
  error,
  onResearch,
}: {
  row: BuyZoneRow;
  research: ResearchData | null;
  loading: boolean;
  error: string | null;
  onResearch: () => void;
}) {
  return (
    <div className="space-y-3 rounded-md border border-border bg-background/40 p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Insider activity + upcoming catalyst
        </div>
        {!research && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onResearch();
            }}
            disabled={loading}
            className="inline-flex items-center gap-1 rounded border border-border bg-background/60 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-foreground/90 hover:bg-background disabled:opacity-60"
          >
            {loading ? (
              <>
                <Loader2 className="h-3 w-3 animate-spin" />
                Researching…
              </>
            ) : error ? (
              <>↻ Retry</>
            ) : (
              <>
                <Search className="h-3 w-3" />
                Research
              </>
            )}
          </button>
        )}
      </div>

      {error && !research && (
        <div className="rounded border border-rose-500/40 bg-rose-500/10 px-2 py-1.5 text-[11px] text-rose-200">
          {error}
        </div>
      )}

      {!research && !error && (
        <p className="text-sm text-muted-foreground">
          Click Research to pull insider transactions and an upcoming-catalyst read for {row.symbol}.
        </p>
      )}

      {research && (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Insider signal
              </span>
              <span
                className={cn(
                  "rounded border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider",
                  insiderSignalColor(research.insider.signal),
                )}
              >
                {research.insider.signal.replace("_", " ")}
              </span>
            </div>
            {research.insider.transactions.length === 0 ? (
              <p className="text-sm text-muted-foreground">No insider transactions in the last 90 days.</p>
            ) : (
              <ul className="space-y-1 text-[12px]">
                {research.insider.transactions.map((t, i) => (
                  <li key={i} className="flex items-center justify-between gap-2 text-muted-foreground">
                    <span className="truncate">
                      {t.name} · {t.action}
                    </span>
                    <span
                      className={cn(
                        "shrink-0 font-mono",
                        t.type === "buy" ? "text-emerald-300" : "text-rose-300",
                      )}
                    >
                      {t.dollarValue > 0 ? `$${(t.dollarValue / 1000).toFixed(0)}k` : "—"}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {research.catalyst.isExpired ? "Catalyst" : "Upcoming catalyst"}
              </span>
              {research.catalyst.date && (
                <span
                  className={cn(
                    "rounded border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider",
                    research.catalyst.isExpired
                      ? "border-muted-foreground/30 bg-muted-foreground/10 text-muted-foreground"
                      : "border-sky-500/40 bg-sky-500/10 text-sky-300",
                  )}
                >
                  {research.catalyst.isExpired ? "Expired" : "Upcoming"} · {research.catalyst.date}
                </span>
              )}
            </div>
            {research.catalyst.analysis ? (
              <MarkdownBody text={stripCitations(research.catalyst.analysis)} />
            ) : (
              <p className="text-sm text-muted-foreground">No catalyst read available.</p>
            )}
            {research.catalyst.fetched_at && (
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground/70">
                {research.catalyst.cached ? "cached · " : ""}
                {new Date(research.catalyst.fetched_at).toLocaleString()}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

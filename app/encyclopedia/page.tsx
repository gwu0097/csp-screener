"use client";

import { useEffect, useMemo, useState } from "react";
import { Loader2, RefreshCw, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

type StockEncyclopedia = {
  id: string;
  symbol: string;
  last_historical_pull_date: string | null;
  total_earnings_records: number;
  crush_rate: number | null;
  avg_move_ratio: number | null;
  beat_rate: number | null;
  recovery_rate_after_breach: number | null;
  avg_iv_crush_magnitude: number | null;
  created_at: string;
  updated_at: string;
};

type EarningsHistory = {
  id: string;
  symbol: string;
  earnings_date: string;
  eps_estimate: number | null;
  eps_actual: number | null;
  eps_surprise_pct: number | null;
  actual_move_pct: number | null;
  implied_move_pct: number | null;
  move_ratio: number | null;
  iv_crushed: boolean | null;
  iv_crush_magnitude: number | null;
  two_x_em_strike: number | null;
  breached_two_x_em: boolean | null;
  recovered_by_expiry: boolean | null;
  analyst_sentiment: string | null;
  is_complete: boolean;
};

function fmtPct(v: number | null, digits = 1): string {
  if (v === null || !Number.isFinite(v)) return "—";
  return `${(v * 100).toFixed(digits)}%`;
}

function fmt(v: number | null, digits = 2): string {
  if (v === null || !Number.isFinite(v)) return "—";
  return v.toFixed(digits);
}

function fmtBool(v: boolean | null): string {
  if (v === null) return "—";
  return v ? "✓" : "—";
}

export default function EncyclopediaPage() {
  const [entries, setEntries] = useState<StockEncyclopedia[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<{
    encyclopedia: StockEncyclopedia | null;
    history: EarningsHistory[];
  } | null>(null);
  const [search, setSearch] = useState("");
  const [loadingList, setLoadingList] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function loadList() {
    setLoadingList(true);
    setError(null);
    try {
      const res = await fetch("/api/encyclopedia", { cache: "no-store" });
      const json = (await res.json()) as { entries?: StockEncyclopedia[]; error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setEntries(json.entries ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "load failed");
    } finally {
      setLoadingList(false);
    }
  }

  async function loadDetail(symbol: string) {
    setLoadingDetail(true);
    setError(null);
    try {
      const res = await fetch(`/api/encyclopedia/${encodeURIComponent(symbol)}`, {
        cache: "no-store",
      });
      const json = (await res.json()) as {
        encyclopedia: StockEncyclopedia | null;
        history: EarningsHistory[];
        error?: string;
      };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setDetail({ encyclopedia: json.encyclopedia, history: json.history });
    } catch (e) {
      setError(e instanceof Error ? e.message : "load failed");
      setDetail(null);
    } finally {
      setLoadingDetail(false);
    }
  }

  async function refreshSymbol(symbol: string) {
    setRefreshing(true);
    setMessage(null);
    setError(null);
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
      setMessage(
        u
          ? `Refreshed ${u.symbol}: ${u.newRecords} new, ${u.updatedRecords} updated`
          : `Errors: ${(json.errors ?? []).map((e) => `${e.symbol}: ${e.error}`).join("; ")}`,
      );
      await loadDetail(symbol);
      await loadList();
    } catch (e) {
      setError(e instanceof Error ? e.message : "refresh failed");
    } finally {
      setRefreshing(false);
    }
  }

  useEffect(() => {
    loadList();
  }, []);

  useEffect(() => {
    if (selected) loadDetail(selected);
    else setDetail(null);
  }, [selected]);

  const filteredEntries = useMemo(() => {
    if (!entries) return [];
    const q = search.trim().toUpperCase();
    if (!q) return entries;
    return entries.filter((e) => e.symbol.includes(q));
  }, [entries, search]);

  function handleSearchSubmit(e: React.FormEvent) {
    e.preventDefault();
    const q = search.trim().toUpperCase();
    if (!q) return;
    // If the symbol exists in the list, select it; otherwise treat it as a
    // fresh lookup — refresh/backfill will populate the row.
    setSelected(q);
  }

  return (
    <div className="container mx-auto max-w-6xl py-6 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Stock Encyclopedia</h1>
        <form onSubmit={handleSearchSubmit} className="flex items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value.toUpperCase())}
              placeholder="Symbol (e.g. NOW)"
              className="w-48 rounded border border-border bg-background py-1 pl-8 pr-2 text-sm"
            />
          </div>
          <Button type="submit" size="sm">Lookup</Button>
          {selected && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                setSelected(null);
                setSearch("");
              }}
            >
              Clear
            </Button>
          )}
        </form>
      </div>

      {error && <div className="rounded border border-rose-500/40 bg-rose-500/10 p-2 text-sm text-rose-300">{error}</div>}
      {message && !error && <div className="text-sm text-emerald-300">{message}</div>}

      {selected ? (
        <DetailView
          symbol={selected}
          detail={detail}
          loading={loadingDetail}
          refreshing={refreshing}
          onRefresh={() => refreshSymbol(selected)}
        />
      ) : (
        <ListView entries={filteredEntries} loading={loadingList} onSelect={setSelected} />
      )}
    </div>
  );
}

function ListView({
  entries,
  loading,
  onSelect,
}: {
  entries: StockEncyclopedia[];
  loading: boolean;
  onSelect: (symbol: string) => void;
}) {
  if (loading && entries.length === 0) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading encyclopedia…
      </div>
    );
  }
  if (entries.length === 0) {
    return (
      <div className="rounded border border-border p-6 text-sm text-muted-foreground">
        No encyclopedia entries yet. Search a symbol above and click{" "}
        <span className="font-medium text-foreground">Lookup</span> to create
        one, then use the Refresh button inside the detail view to backfill.
      </div>
    );
  }
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {entries.map((e) => (
        <button
          key={e.id}
          onClick={() => onSelect(e.symbol)}
          className="rounded border border-border bg-background/40 p-3 text-left hover:border-primary/60"
        >
          <div className="flex items-center justify-between">
            <span className="font-semibold">{e.symbol}</span>
            <span className="text-xs text-muted-foreground">
              {e.total_earnings_records} earnings
            </span>
          </div>
          <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
            <div>Crush: <span className="text-foreground">{fmtPct(e.crush_rate, 0)}</span></div>
            <div>Avg ratio: <span className="text-foreground">{fmt(e.avg_move_ratio, 2)}</span></div>
            <div>Beat rate: <span className="text-foreground">{fmtPct(e.beat_rate, 0)}</span></div>
            <div>
              Breach recovery:{" "}
              <span className="text-foreground">{fmtPct(e.recovery_rate_after_breach, 0)}</span>
            </div>
          </div>
        </button>
      ))}
    </div>
  );
}

function DetailView({
  symbol,
  detail,
  loading,
  refreshing,
  onRefresh,
}: {
  symbol: string;
  detail: { encyclopedia: StockEncyclopedia | null; history: EarningsHistory[] } | null;
  loading: boolean;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  if (loading && !detail) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading {symbol}…
      </div>
    );
  }
  const enc = detail?.encyclopedia;
  const history = detail?.history ?? [];
  const hasData = enc !== null && enc !== undefined;
  const earliest = history.length > 0 ? history[history.length - 1].earnings_date : null;
  const latest = history.length > 0 ? history[0].earnings_date : null;

  return (
    <div className="space-y-4">
      <div className="rounded border border-border bg-background/40 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="text-2xl font-semibold">{symbol}</div>
            {hasData ? (
              <div className="mt-1 flex flex-wrap gap-4 text-xs text-muted-foreground">
                <span>
                  Events: <span className="text-foreground">{enc.total_earnings_records}</span>
                </span>
                <span>
                  Crush rate: <span className="text-foreground">{fmtPct(enc.crush_rate, 0)}</span>
                </span>
                <span>
                  Avg move ratio: <span className="text-foreground">{fmt(enc.avg_move_ratio, 2)}</span>
                </span>
                <span>
                  Beat rate: <span className="text-foreground">{fmtPct(enc.beat_rate, 0)}</span>
                </span>
                <span>
                  Breach recovery:{" "}
                  <span className="text-foreground">{fmtPct(enc.recovery_rate_after_breach, 0)}</span>
                </span>
              </div>
            ) : (
              <div className="mt-1 text-xs text-muted-foreground">
                No encyclopedia entry yet — click Refresh to backfill from Finnhub + Yahoo.
              </div>
            )}
          </div>
          <Button onClick={onRefresh} disabled={refreshing} size="sm">
            {refreshing ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
            <span className="ml-1">Refresh data</span>
          </Button>
        </div>
      </div>

      {history.length === 0 ? (
        <div className="rounded border border-border p-6 text-sm text-muted-foreground">
          No history rows for {symbol}. Click Refresh to pull from Finnhub.
        </div>
      ) : (
        <>
          <div className="overflow-x-auto rounded border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead className="text-right">EPS Surprise</TableHead>
                  <TableHead className="text-right">Move %</TableHead>
                  <TableHead className="text-right">Ratio</TableHead>
                  <TableHead className="text-center">Crushed</TableHead>
                  <TableHead className="text-center">Breached 2×EM</TableHead>
                  <TableHead className="text-center">Recovered</TableHead>
                  <TableHead>Analyst</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {history.map((r) => {
                  const rowClass = rowColor(r);
                  return (
                    <TableRow key={r.id} className={rowClass}>
                      <TableCell className="font-mono text-xs">{r.earnings_date}</TableCell>
                      <TableCell className="text-right">{fmtPct(r.eps_surprise_pct, 1)}</TableCell>
                      <TableCell className="text-right">{fmtPct(r.actual_move_pct, 2)}</TableCell>
                      <TableCell className="text-right">{fmt(r.move_ratio, 2)}</TableCell>
                      <TableCell className="text-center">{fmtBool(r.iv_crushed)}</TableCell>
                      <TableCell className="text-center">{fmtBool(r.breached_two_x_em)}</TableCell>
                      <TableCell className="text-center">{fmtBool(r.recovered_by_expiry)}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {r.analyst_sentiment ?? "—"}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
          <div className="text-xs text-muted-foreground">
            Data coverage: {history.length} earnings events from{" "}
            <span className="text-foreground">{earliest ?? "—"}</span> to{" "}
            <span className="text-foreground">{latest ?? "—"}</span>. Last updated:{" "}
            <span className="text-foreground">
              {enc?.updated_at ? new Date(enc.updated_at).toLocaleString() : "—"}
            </span>
          </div>
        </>
      )}
    </div>
  );
}

function rowColor(r: EarningsHistory): string {
  if (r.breached_two_x_em === true) return "bg-rose-500/10";
  if (r.iv_crushed === true && (r.move_ratio ?? Infinity) < 1.0) return "bg-emerald-500/10";
  if ((r.move_ratio ?? 0) > 1.0) return "bg-amber-500/10";
  return "";
}

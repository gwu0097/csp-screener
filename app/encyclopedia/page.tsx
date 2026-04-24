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
  news_summary: string | null;
  perplexity_pulled_at: string | null;
  is_complete: boolean;
};

type PerplexityPayload = {
  analyst_sentiment?: string;
  primary_reason_for_move?: string;
  sector_context?: string;
  guidance_assessment?: string;
  key_risks?: string[];
  recovery_likelihood?: string;
  summary?: string;
};

function parsePerplexity(raw: string | null): PerplexityPayload | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PerplexityPayload;
  } catch {
    return null;
  }
}

function sentimentColor(s: string | null | undefined): string {
  switch (s) {
    case "positive":
      return "bg-emerald-500/20 text-emerald-300 border-emerald-500/40";
    case "negative":
      return "bg-rose-500/20 text-rose-300 border-rose-500/40";
    case "mixed":
      return "bg-amber-500/20 text-amber-300 border-amber-500/40";
    default:
      return "bg-muted/40 text-muted-foreground border-border";
  }
}

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

  async function reingestSymbol(symbol: string) {
    setRefreshing(true);
    setMessage(null);
    setError(null);
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
        setMessage(
          r.already_clean
            ? `${r.symbol}: already clean — no quarter-end rows.`
            : `Re-ingested ${r.symbol}: ${r.reingested} re-keyed, ${r.merged_with_existing} merged${unmatched}`,
        );
      } else {
        setMessage(
          `Errors: ${(json.errors ?? []).map((e) => `${e.symbol}: ${e.error}`).join("; ")}`,
        );
      }
      await loadDetail(symbol);
      await loadList();
    } catch (e) {
      setError(e instanceof Error ? e.message : "re-ingest failed");
    } finally {
      setRefreshing(false);
    }
  }

  useEffect(() => {
    loadList();
  }, []);

  // Deep-link: /encyclopedia?symbol=NOW auto-selects that ticker on
  // mount so "View in Encyclopedia" buttons on other pages navigate
  // straight to the detail view instead of the list.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const sym = params.get("symbol");
    if (sym) {
      const upper = sym.toUpperCase();
      setSearch(upper);
      setSelected(upper);
    }
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
          onReingest={() => reingestSymbol(selected)}
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
  onReingest,
}: {
  symbol: string;
  detail: { encyclopedia: StockEncyclopedia | null; history: EarningsHistory[] } | null;
  loading: boolean;
  refreshing: boolean;
  onRefresh: () => void;
  onReingest: () => void;
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
          <div className="flex flex-wrap gap-2">
            <Button onClick={onRefresh} disabled={refreshing} size="sm">
              {refreshing ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
              <span className="ml-1">Refresh data</span>
            </Button>
            <Button onClick={onReingest} disabled={refreshing} size="sm" variant="outline">
              {refreshing ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
              <span className="ml-1">Re-ingest historical dates</span>
            </Button>
          </div>
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
                  <TableHead className="w-8" />
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
                {history.map((r) => (
                  <HistoryRowView key={r.id} row={r} />
                ))}
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

function HistoryRowView({ row }: { row: EarningsHistory }) {
  const [expanded, setExpanded] = useState(false);
  const payload = parsePerplexity(row.news_summary);
  const rowClass = rowColor(row);
  const hasDetail = payload !== null;
  return (
    <>
      <TableRow
        className={`${rowClass} ${hasDetail ? "cursor-pointer" : ""}`}
        onClick={hasDetail ? () => setExpanded((v) => !v) : undefined}
      >
        <TableCell className="text-xs text-muted-foreground">
          {hasDetail ? (expanded ? "▾" : "▸") : ""}
        </TableCell>
        <TableCell className="font-mono text-xs">{row.earnings_date}</TableCell>
        <TableCell className="text-right">{fmtPct(row.eps_surprise_pct, 1)}</TableCell>
        <TableCell className="text-right">{fmtPct(row.actual_move_pct, 2)}</TableCell>
        <TableCell className="text-right">{fmt(row.move_ratio, 2)}</TableCell>
        <TableCell className="text-center">{fmtBool(row.iv_crushed)}</TableCell>
        <TableCell className="text-center">{fmtBool(row.breached_two_x_em)}</TableCell>
        <TableCell className="text-center">{fmtBool(row.recovered_by_expiry)}</TableCell>
        <TableCell>
          {row.perplexity_pulled_at === null ? (
            <span className="text-xs text-muted-foreground">—</span>
          ) : (
            <span
              className={`inline-block rounded border px-2 py-0.5 text-[11px] font-medium ${sentimentColor(row.analyst_sentiment)}`}
            >
              {row.analyst_sentiment ?? "neutral"}
            </span>
          )}
        </TableCell>
      </TableRow>
      {expanded && payload && (
        <TableRow className="bg-background/40">
          <TableCell />
          <TableCell colSpan={8}>
            <div className="space-y-2 py-2 text-xs">
              {payload.summary && (
                <div>
                  <span className="font-semibold text-foreground">Summary:</span>{" "}
                  <span className="text-muted-foreground">{payload.summary}</span>
                </div>
              )}
              {payload.primary_reason_for_move && (
                <div>
                  <span className="font-semibold text-foreground">Why it moved:</span>{" "}
                  <span className="text-muted-foreground">{payload.primary_reason_for_move}</span>
                </div>
              )}
              {payload.sector_context && (
                <div>
                  <span className="font-semibold text-foreground">Sector:</span>{" "}
                  <span className="text-muted-foreground">{payload.sector_context}</span>
                </div>
              )}
              {payload.recovery_likelihood && (
                <div>
                  <span className="font-semibold text-foreground">Recovery likelihood:</span>{" "}
                  <span className="text-muted-foreground">{payload.recovery_likelihood}</span>
                </div>
              )}
              {payload.guidance_assessment && payload.guidance_assessment !== "not_mentioned" && (
                <div>
                  <span className="font-semibold text-foreground">Guidance:</span>{" "}
                  <span className="text-muted-foreground">{payload.guidance_assessment}</span>
                </div>
              )}
              {payload.key_risks && payload.key_risks.length > 0 && (
                <div>
                  <span className="font-semibold text-foreground">Key risks:</span>
                  <ul className="ml-4 list-disc text-muted-foreground">
                    {payload.key_risks.map((k, i) => (
                      <li key={i}>{k}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

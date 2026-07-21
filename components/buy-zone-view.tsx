"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Loader2 } from "lucide-react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

type WatchlistMeta = {
  id: string;
  name: string;
  isPortfolio: boolean;
};

type BuyZoneRow = {
  symbol: string;
  companyName: string | null;
  price: number | null;
  changePct: number | null;
  rsi14: number | null;
  buyZoneRsiScore: number;
  buyZoneMacdScore: number;
  buyZoneComposite: number;
  buyZoneMacdStatus: string;
  watchlistNames: string[];
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

const ALL_SCOPE = "__all__";

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

export function BuyZoneView() {
  const [watchlists, setWatchlists] = useState<WatchlistMeta[] | null>(null);
  const [scope, setScope] = useState<string>(ALL_SCOPE);
  const [rows, setRows] = useState<BuyZoneRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Default sort is Buy Zone score descending; stays that way until
  // the person clicks a different header.
  const [sortKey, setSortKey] = useState<SortKey>("composite");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

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

  const load = useCallback(async (watchlistId: string) => {
    setLoading(true);
    setError(null);
    try {
      const url =
        watchlistId === ALL_SCOPE
          ? "/api/analysis/buy-zone"
          : `/api/analysis/buy-zone?watchlistId=${encodeURIComponent(watchlistId)}`;
      const res = await fetch(url, { cache: "no-store" });
      const json = (await res.json()) as { rows?: BuyZoneRow[]; error?: string };
      if (!res.ok || json.error) throw new Error(json.error ?? `HTTP ${res.status}`);
      setRows(json.rows ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(scope);
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
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Buy Zone</h1>
        <p className="text-base text-muted-foreground">
          Names closest to an oversold bullish turnaround — RSI approaching oversold plus a
          MACD bullish cross out of negative territory. Click any column to sort.
        </p>
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
            {sortedRows?.map((r) => {
              const changeColor =
                r.changePct === null
                  ? "text-muted-foreground"
                  : r.changePct >= 0
                    ? "text-emerald-300"
                    : "text-rose-300";
              return (
                <tr key={r.symbol} className="border-b border-border/40 hover:bg-background/60">
                  <td className="px-2 py-1.5 font-mono font-semibold">{r.symbol}</td>
                  <td className="px-2 py-1.5 text-muted-foreground">{r.companyName ?? "—"}</td>
                  <td className="px-2 py-1.5 text-right font-mono">{fmtMoney(r.price)}</td>
                  <td className={cn("px-2 py-1.5 text-right font-mono", changeColor)}>
                    {fmtPct(r.changePct)}
                  </td>
                  <td className="px-2 py-1.5 text-right">
                    <div className={cn("font-mono", rsiColor(r.rsi14))}>
                      {r.rsi14 !== null && Number.isFinite(r.rsi14) ? r.rsi14.toFixed(0) : "—"}
                    </div>
                    <div className="text-[10px] text-muted-foreground">{r.buyZoneRsiScore.toFixed(1)}/5</div>
                  </td>
                  <td className="px-2 py-1.5 text-center">
                    <div className={cn("text-[11px] font-medium capitalize", macdStatusColor(r.buyZoneMacdStatus))}>
                      {r.buyZoneMacdStatus}
                    </div>
                    <div className="text-[10px] text-muted-foreground">{r.buyZoneMacdScore.toFixed(1)}/5</div>
                  </td>
                  <td className="px-2 py-1.5 text-center">
                    <span
                      className={cn(
                        "inline-block rounded border px-2 py-0.5 font-mono text-[12px] font-semibold",
                        buyZoneBadgeColor(r.buyZoneComposite),
                      )}
                      title={`RSI ${r.buyZoneRsiScore.toFixed(1)} + MACD ${r.buyZoneMacdScore.toFixed(1)} = ${r.buyZoneComposite.toFixed(1)}`}
                    >
                      {r.buyZoneComposite.toFixed(1)}/10
                    </span>
                  </td>
                  <td className="px-2 py-1.5">
                    <span className="inline-flex flex-wrap items-center gap-1">
                      {r.watchlistNames.map((name) => (
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
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

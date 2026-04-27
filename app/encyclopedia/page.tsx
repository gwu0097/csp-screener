"use client";

// Encyclopedia index — directory of every stock with an encyclopedia
// entry. Per-stock detail lives at /encyclopedia/[symbol] (multi-tab
// view). This page is search + a grid of stat-tile links.
//
// Backward-compat: /encyclopedia?symbol=NOW deep links from older
// callers redirect to /encyclopedia/NOW on mount, so old "View in
// Encyclopedia" buttons keep working until they're updated.

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Loader2, Search } from "lucide-react";
import { Button } from "@/components/ui/button";

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

function fmtPct(v: number | null, digits = 1): string {
  if (v === null || !Number.isFinite(v)) return "—";
  return `${(v * 100).toFixed(digits)}%`;
}
function fmtNum(v: number | null, digits = 2): string {
  if (v === null || !Number.isFinite(v)) return "—";
  return v.toFixed(digits);
}

export default function EncyclopediaPage() {
  const router = useRouter();
  const [entries, setEntries] = useState<StockEncyclopedia[] | null>(null);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadList() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/encyclopedia", { cache: "no-store" });
      const json = (await res.json()) as {
        entries?: StockEncyclopedia[];
        error?: string;
      };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setEntries(json.entries ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "load failed");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadList();
  }, []);

  // Backward-compat redirect for legacy ?symbol=X deep links — older
  // "View in Encyclopedia" buttons used querystring routing before
  // /encyclopedia/[symbol] existed.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const sym = params.get("symbol");
    if (sym && /^[A-Za-z][A-Za-z0-9.-]{0,9}$/.test(sym)) {
      router.replace(`/encyclopedia/${encodeURIComponent(sym.toUpperCase())}`);
    }
  }, [router]);

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
    router.push(`/encyclopedia/${encodeURIComponent(q)}`);
  }

  return (
    <div className="container mx-auto max-w-6xl py-6 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Stock Encyclopedia</h1>
        <form
          onSubmit={handleSearchSubmit}
          className="flex items-center gap-2"
        >
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
          <Button type="submit" size="sm">
            Lookup
          </Button>
        </form>
      </div>

      {error && (
        <div className="rounded border border-rose-500/40 bg-rose-500/10 p-2 text-sm text-rose-300">
          {error}
        </div>
      )}

      {loading && !entries ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading encyclopedia…
        </div>
      ) : filteredEntries.length === 0 ? (
        <div className="rounded border border-border p-6 text-sm text-muted-foreground">
          No encyclopedia entries yet. Search a symbol above and press{" "}
          <span className="font-medium text-foreground">Lookup</span> to open
          its detail page, then use Refresh inside the detail view to backfill
          from Finnhub.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {filteredEntries.map((e) => (
            <Link
              key={e.id}
              href={`/encyclopedia/${encodeURIComponent(e.symbol)}`}
              className="rounded border border-border bg-background/40 p-3 text-left hover:border-primary/60"
            >
              <div className="flex items-center justify-between">
                <span className="font-semibold">{e.symbol}</span>
                <span className="text-xs text-muted-foreground">
                  {e.total_earnings_records} earnings
                </span>
              </div>
              <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                <div>
                  Crush:{" "}
                  <span className="text-foreground">
                    {fmtPct(e.crush_rate, 0)}
                  </span>
                </div>
                <div>
                  Avg ratio:{" "}
                  <span className="text-foreground">
                    {fmtNum(e.avg_move_ratio, 2)}
                  </span>
                </div>
                <div>
                  Beat rate:{" "}
                  <span className="text-foreground">
                    {fmtPct(e.beat_rate, 0)}
                  </span>
                </div>
                <div>
                  Breach recovery:{" "}
                  <span className="text-foreground">
                    {fmtPct(e.recovery_rate_after_breach, 0)}
                  </span>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

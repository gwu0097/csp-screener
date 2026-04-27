"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowDown, ArrowUp, ArrowUpDown, Search } from "lucide-react";

type ModuleCounts = {
  business_overview: number;
  fundamental_health: number;
  catalyst_scanner: number;
  valuation_model: number;
  "10k_deep_read": number;
  risk_assessment: number;
  sentiment: number;
  technical: number;
};

type RecentStock = {
  symbol: string;
  company_name: string | null;
  overall_grade: string | null;
  last_researched_at: string | null;
  modules: ModuleCounts;
  valuation_base_target: number | null;
  catalyst_score: "rich" | "moderate" | "sparse" | null;
  current_price: number | null;
  change_percent: number | null;
};

const RECENT_KEY = "research_recent_searches";
const COMMON_TICKERS = [
  "AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA", "AMD", "PLTR",
  "CRM", "ORCL", "AVGO", "NFLX", "ADBE", "INTC", "QCOM", "MU", "DIS",
  "JPM", "BAC", "GS", "V", "MA", "BRK.B", "WMT", "COST", "PG", "KO",
  "PEP", "JNJ", "LLY", "MRK", "PFE", "UNH", "XOM", "CVX", "BA", "GE",
  "CAT", "DE", "F", "GM", "LULU", "NKE", "ONON", "CROX", "VFC", "RL",
];

// ---------- Formatters ----------

function fmtResearchedAt(iso: string | null): string {
  if (!iso) return "never";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "unknown";
  const date = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return `${date}, ${time}`;
}

function gradeClasses(g: string | null): string {
  if (g === "A") return "border-emerald-500/40 bg-emerald-500/15 text-emerald-300";
  if (g === "B") return "border-blue-500/40 bg-blue-500/15 text-blue-300";
  if (g === "C") return "border-amber-500/40 bg-amber-500/15 text-amber-300";
  if (g === "D") return "border-rose-500/40 bg-rose-500/15 text-rose-300";
  return "border-zinc-500/40 bg-zinc-500/15 text-zinc-400";
}

function catalystClasses(s: RecentStock["catalyst_score"]): string {
  if (s === "rich") return "border-emerald-500/40 bg-emerald-500/15 text-emerald-300";
  if (s === "moderate") return "border-amber-500/40 bg-amber-500/15 text-amber-300";
  if (s === "sparse") return "border-zinc-500/40 bg-zinc-500/15 text-zinc-400";
  return "";
}

// Numeric grade ranking — A best (4), D worst (1), null lowest (0).
function gradeRank(g: string | null): number {
  if (g === "A") return 4;
  if (g === "B") return 3;
  if (g === "C") return 2;
  if (g === "D") return 1;
  return 0;
}
function catalystRank(s: RecentStock["catalyst_score"]): number {
  if (s === "rich") return 3;
  if (s === "moderate") return 2;
  if (s === "sparse") return 1;
  return 0;
}

// ---------- Sort ----------

type SortKey = "grade" | "valuation" | "catalyst" | "researched";
type SortDir = "asc" | "desc";

function compare(a: RecentStock, b: RecentStock, key: SortKey): number {
  switch (key) {
    case "grade":
      return gradeRank(a.overall_grade) - gradeRank(b.overall_grade);
    case "valuation":
      return (a.valuation_base_target ?? -Infinity) - (b.valuation_base_target ?? -Infinity);
    case "catalyst":
      return catalystRank(a.catalyst_score) - catalystRank(b.catalyst_score);
    case "researched": {
      const at = a.last_researched_at ? new Date(a.last_researched_at).getTime() : 0;
      const bt = b.last_researched_at ? new Date(b.last_researched_at).getTime() : 0;
      return at - bt;
    }
  }
}

// ---------- Module-badge config (compact initials) ----------

type Badge = { tab: string; label: string; count: (m: ModuleCounts) => number };
const BADGES: Badge[] = [
  { tab: "overview", label: "OV", count: (m) => Math.max(m.business_overview, m.fundamental_health) },
  { tab: "catalysts", label: "CA", count: (m) => m.catalyst_scanner },
  { tab: "valuation", label: "VA", count: (m) => m.valuation_model },
  { tab: "tenk", label: "10K", count: (m) => m["10k_deep_read"] },
  { tab: "risk", label: "RI", count: (m) => m.risk_assessment },
  { tab: "sentiment", label: "SE", count: (m) => m.sentiment },
];

// ---------- Component ----------

export function ResearchHomeView() {
  const router = useRouter();
  const [stocks, setStocks] = useState<RecentStock[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recents, setRecents] = useState<string[]>([]);
  const [sortKey, setSortKey] = useState<SortKey>("researched");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/research/recent", { cache: "no-store" });
        const json = (await res.json()) as { stocks?: RecentStock[]; error?: string };
        if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
        if (!cancelled) setStocks(json.stocks ?? []);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Failed to load");
          setStocks([]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Load + persist localStorage recents.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(RECENT_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          setRecents(parsed.filter((x): x is string => typeof x === "string"));
        }
      }
    } catch {
      /* swallow — corrupted storage, ignore */
    }
  }, []);

  function pushRecent(symbol: string) {
    setRecents((prev) => {
      const next = [symbol, ...prev.filter((s) => s !== symbol)].slice(0, 5);
      try {
        window.localStorage.setItem(RECENT_KEY, JSON.stringify(next));
      } catch {
        /* swallow */
      }
      return next;
    });
  }

  function go(symbol: string) {
    const upper = symbol.trim().toUpperCase();
    if (!upper) return;
    pushRecent(upper);
    router.push(`/research/${encodeURIComponent(upper)}`);
  }

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      // Sensible default per column: dates default desc, everything
      // else defaults desc too (best grade / highest target / richest
      // catalyst on top).
      setSortDir("desc");
    }
  }

  const sorted = useMemo(() => {
    if (!stocks) return null;
    const list = [...stocks];
    list.sort((a, b) => {
      const c = compare(a, b, sortKey);
      return sortDir === "asc" ? c : -c;
    });
    return list;
  }, [stocks, sortKey, sortDir]);

  return (
    <div className="space-y-6">
      <SearchBox
        onSubmit={go}
        researched={stocks ?? []}
      />
      <RecentPills recents={recents} onPick={go} />
      {error && (
        <div className="rounded border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-300">
          {error}
        </div>
      )}
      {sorted === null ? (
        <div className="rounded border border-border bg-background/40 p-6 text-sm text-muted-foreground">
          Loading…
        </div>
      ) : sorted.length === 0 ? (
        <div className="rounded border border-dashed border-border bg-background/40 p-6 text-center text-sm text-muted-foreground">
          No stocks researched yet. Search for a ticker above to start.
        </div>
      ) : (
        <StockTable
          stocks={sorted}
          sortKey={sortKey}
          sortDir={sortDir}
          onSort={toggleSort}
        />
      )}
    </div>
  );
}

// ---------- Search box with autocomplete ----------

function SearchBox({
  onSubmit,
  researched,
}: {
  onSubmit: (sym: string) => void;
  researched: RecentStock[];
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Click-outside dismiss.
  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  type Suggestion = { symbol: string; label: string; tag: "researched" | "common" };

  const suggestions = useMemo<Suggestion[]>(() => {
    const q = query.trim().toUpperCase();
    if (!q) return [];
    const seen = new Set<string>();
    const out: Suggestion[] = [];
    for (const s of researched) {
      const sym = s.symbol.toUpperCase();
      const company = s.company_name ?? "";
      const matchSym = sym.includes(q);
      const matchName = company.toUpperCase().includes(q);
      if (!matchSym && !matchName) continue;
      if (seen.has(sym)) continue;
      seen.add(sym);
      out.push({ symbol: sym, label: company, tag: "researched" });
      if (out.length >= 8) break;
    }
    if (out.length < 8) {
      for (const t of COMMON_TICKERS) {
        if (seen.has(t)) continue;
        if (!t.includes(q)) continue;
        seen.add(t);
        out.push({ symbol: t, label: "", tag: "common" });
        if (out.length >= 8) break;
      }
    }
    return out;
  }, [query, researched]);

  function submit() {
    const sym = (suggestions[active]?.symbol ?? query).trim().toUpperCase();
    if (!sym) return;
    setOpen(false);
    setQuery("");
    onSubmit(sym);
  }

  return (
    <div ref={containerRef} className="relative mx-auto max-w-2xl">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="flex items-center gap-2 rounded-md border border-border bg-background/40 p-2"
      >
        <Search className="ml-1 h-4 w-4 shrink-0 text-muted-foreground" />
        <input
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value.toUpperCase());
            setOpen(true);
            setActive(0);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (!open || suggestions.length === 0) return;
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((i) => Math.min(suggestions.length - 1, i + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((i) => Math.max(0, i - 1));
            } else if (e.key === "Escape") {
              setOpen(false);
            }
          }}
          placeholder="Search or enter ticker (e.g. LULU, AMD, NVDA)"
          className="flex-1 bg-transparent text-sm focus:outline-none"
          autoFocus
        />
        <button
          type="submit"
          disabled={!query.trim()}
          className="rounded border border-border bg-emerald-500/10 px-3 py-1.5 text-sm font-medium text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-50"
        >
          Research
        </button>
      </form>
      {open && suggestions.length > 0 && (
        <div className="absolute left-0 right-0 z-20 mt-1 max-h-72 overflow-y-auto rounded-md border border-border bg-popover shadow-lg">
          {suggestions.map((s, i) => (
            <button
              key={`${s.tag}-${s.symbol}`}
              type="button"
              onMouseDown={(e) => {
                // mousedown so the input's blur doesn't close the
                // popover before the click registers.
                e.preventDefault();
                setOpen(false);
                setQuery("");
                onSubmit(s.symbol);
              }}
              onMouseEnter={() => setActive(i)}
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-white/[0.04] ${
                i === active ? "bg-white/[0.04]" : ""
              }`}
            >
              <span className="w-16 font-mono text-sm font-semibold text-foreground">
                {s.symbol}
              </span>
              <span className="flex-1 truncate text-muted-foreground">
                {s.label || (s.tag === "common" ? "common ticker" : "")}
              </span>
              {s.tag === "researched" && (
                <span className="rounded border border-emerald-500/40 bg-emerald-500/10 px-1 py-0.5 text-[9px] uppercase text-emerald-300">
                  researched
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------- Recent pills ----------

function RecentPills({
  recents,
  onPick,
}: {
  recents: string[];
  onPick: (s: string) => void;
}) {
  if (recents.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
        Recently researched:
      </span>
      {recents.map((s) => (
        <button
          key={s}
          type="button"
          onClick={() => onPick(s)}
          className="rounded border border-border bg-background/40 px-2 py-0.5 text-xs font-mono font-medium text-foreground hover:border-emerald-500/40 hover:bg-emerald-500/10"
        >
          {s}
        </button>
      ))}
    </div>
  );
}

// ---------- Sortable table ----------

function StockTable({
  stocks,
  sortKey,
  sortDir,
  onSort,
}: {
  stocks: RecentStock[];
  sortKey: SortKey;
  sortDir: SortDir;
  onSort: (k: SortKey) => void;
}) {
  return (
    <div className="overflow-x-auto rounded border border-border">
      <table className="min-w-full text-xs">
        <thead className="bg-background/60">
          <tr>
            <Th>Symbol</Th>
            <Th>Company</Th>
            <ThSortable
              label="Grade"
              sortKey="grade"
              activeKey={sortKey}
              dir={sortDir}
              onSort={onSort}
            />
            <Th>Modules</Th>
            <ThSortable
              label="Valuation"
              sortKey="valuation"
              activeKey={sortKey}
              dir={sortDir}
              onSort={onSort}
            />
            <Th>Price</Th>
            <ThSortable
              label="Catalyst Score"
              sortKey="catalyst"
              activeKey={sortKey}
              dir={sortDir}
              onSort={onSort}
            />
            <ThSortable
              label="Last Researched"
              sortKey="researched"
              activeKey={sortKey}
              dir={sortDir}
              onSort={onSort}
              align="right"
            />
          </tr>
        </thead>
        <tbody>
          {stocks.map((s) => (
            <Row key={s.symbol} s={s} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Th({
  children,
  align = "left",
}: {
  children: React.ReactNode;
  align?: "left" | "right";
}) {
  return (
    <th
      className={`px-3 py-2 font-medium uppercase tracking-wide text-[10px] text-muted-foreground ${
        align === "right" ? "text-right" : "text-left"
      }`}
    >
      {children}
    </th>
  );
}

function ThSortable({
  label,
  sortKey,
  activeKey,
  dir,
  onSort,
  align = "left",
}: {
  label: string;
  sortKey: SortKey;
  activeKey: SortKey;
  dir: SortDir;
  onSort: (k: SortKey) => void;
  align?: "left" | "right";
}) {
  const active = sortKey === activeKey;
  const Icon = !active
    ? ArrowUpDown
    : dir === "asc"
      ? ArrowUp
      : ArrowDown;
  return (
    <th
      className={`px-3 py-2 ${align === "right" ? "text-right" : "text-left"}`}
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={`inline-flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide transition-colors ${
          active ? "text-foreground" : "text-muted-foreground hover:text-foreground"
        }`}
      >
        <span>{label}</span>
        <Icon className="h-3 w-3" />
      </button>
    </th>
  );
}

function PriceCell({
  price,
  changePct,
}: {
  price: number | null;
  changePct: number | null;
}) {
  if (price === null) return <span className="text-muted-foreground">—</span>;
  // Yahoo's regularMarketChangePercent is already in percent form (e.g.
  // 1.51 means +1.51%). The arrow + colour indicate direction.
  const hasChange = changePct !== null && Number.isFinite(changePct);
  const up = hasChange && (changePct as number) >= 0;
  const cls = !hasChange
    ? "text-muted-foreground"
    : up
      ? "text-emerald-300"
      : "text-rose-300";
  return (
    <span className="inline-flex items-baseline gap-1">
      <span className="text-foreground">${price.toFixed(2)}</span>
      {hasChange && (
        <span className={`text-[10px] ${cls}`}>
          {up ? "▲" : "▼"}
          {Math.abs(changePct as number).toFixed(2)}%
        </span>
      )}
    </span>
  );
}

function Row({ s }: { s: RecentStock }) {
  return (
    <tr className="border-t border-border hover:bg-white/[0.02]">
      <td className="px-3 py-2">
        <Link
          href={`/research/${encodeURIComponent(s.symbol)}`}
          className="font-mono text-sm font-semibold text-foreground hover:text-emerald-300 hover:underline"
        >
          {s.symbol}
        </Link>
      </td>
      <td className="max-w-[14rem] truncate px-3 py-2 text-muted-foreground">
        {s.company_name ?? "—"}
      </td>
      <td className="px-3 py-2">
        <span
          className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${gradeClasses(s.overall_grade)}`}
          title={s.overall_grade ? `Grade ${s.overall_grade}` : "Not yet graded"}
        >
          {s.overall_grade ?? "Not graded"}
        </span>
      </td>
      <td className="px-3 py-2">
        <div className="flex flex-wrap gap-1">
          {BADGES.map((b) => {
            const n = b.count(s.modules);
            const has = n > 0;
            return (
              <Link
                key={b.tab}
                href={`/research/${encodeURIComponent(s.symbol)}?tab=${b.tab}`}
                title={
                  has
                    ? `${b.label}: ${n} ${n === 1 ? "version" : "versions"}`
                    : `${b.label}: not yet run`
                }
                className={`inline-flex h-5 min-w-[1.6rem] items-center justify-center rounded border px-1 text-[10px] font-mono font-semibold transition-colors ${
                  has
                    ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25"
                    : "border-border bg-background/40 text-muted-foreground/60 hover:bg-background/60"
                }`}
              >
                {b.label}
              </Link>
            );
          })}
        </div>
      </td>
      <td className="px-3 py-2 font-mono">
        {s.valuation_base_target !== null ? (
          <span className="text-foreground">
            ${Math.round(s.valuation_base_target)}
            <span className="ml-1 text-[10px] text-muted-foreground">base</span>
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </td>
      <td className="px-3 py-2 font-mono">
        <PriceCell price={s.current_price} changePct={s.change_percent} />
      </td>
      <td className="px-3 py-2">
        {s.catalyst_score ? (
          <span
            className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${catalystClasses(s.catalyst_score)}`}
          >
            {s.catalyst_score}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </td>
      <td className="px-3 py-2 text-right text-muted-foreground">
        {fmtResearchedAt(s.last_researched_at)}
      </td>
    </tr>
  );
}

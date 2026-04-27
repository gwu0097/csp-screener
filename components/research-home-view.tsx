"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Search } from "lucide-react";

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
  sector: string | null;
  overall_grade: string | null;
  last_researched_at: string | null;
  modules: ModuleCounts;
};

function fmtResearchedAt(iso: string | null): string {
  if (!iso) return "never";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "unknown";
  const date = d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const time = d.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
  return `${date} at ${time}`;
}

function gradeClasses(g: string | null): string {
  if (g === "A") return "border-emerald-500/40 bg-emerald-500/15 text-emerald-300";
  if (g === "B") return "border-teal-500/40 bg-teal-500/15 text-teal-300";
  if (g === "C") return "border-amber-500/40 bg-amber-500/15 text-amber-300";
  if (g === "D") return "border-rose-500/40 bg-rose-500/15 text-rose-300";
  return "border-zinc-500/40 bg-zinc-500/15 text-zinc-400";
}

// One badge per UI tab in the research stock view. Overview rolls up
// business_overview + fundamental_health since they share a tab.
type Badge = {
  tab: string;
  label: string;
  count: (m: ModuleCounts) => number;
  showCount: boolean; // only modules that accumulate across runs benefit
};

const BADGES: Badge[] = [
  {
    tab: "overview",
    label: "Overview",
    count: (m) => Math.max(m.business_overview, m.fundamental_health),
    showCount: false,
  },
  {
    tab: "catalysts",
    label: "Catalysts",
    count: (m) => m.catalyst_scanner,
    showCount: true,
  },
  {
    tab: "valuation",
    label: "Valuation",
    count: (m) => m.valuation_model,
    showCount: true,
  },
  {
    tab: "tenk",
    label: "10-K",
    count: (m) => m["10k_deep_read"],
    showCount: false,
  },
  {
    tab: "risk",
    label: "Risk",
    count: (m) => m.risk_assessment,
    showCount: false,
  },
  {
    tab: "sentiment",
    label: "Sentiment",
    count: (m) => m.sentiment,
    showCount: false,
  },
];

export function ResearchHomeView() {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [recent, setRecent] = useState<RecentStock[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/research/recent", { cache: "no-store" });
        const json = (await res.json()) as { stocks?: RecentStock[]; error?: string };
        if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
        if (!cancelled) setRecent(json.stocks ?? []);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Failed to load");
          setRecent([]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const symbol = query.trim().toUpperCase();
    if (!symbol) return;
    router.push(`/research/${encodeURIComponent(symbol)}`);
  }

  return (
    <div className="space-y-6">
      <form
        onSubmit={submit}
        className="mx-auto flex max-w-2xl items-center gap-2 rounded-md border border-border bg-background/40 p-2"
      >
        <Search className="ml-1 h-4 w-4 shrink-0 text-muted-foreground" />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value.toUpperCase())}
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

      <div className="space-y-2">
        <div className="flex items-baseline justify-between">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Researched stocks
          </div>
          {recent && recent.length > 0 && (
            <div className="text-[11px] text-muted-foreground">
              {recent.length} {recent.length === 1 ? "stock" : "stocks"}
            </div>
          )}
        </div>
        {error && (
          <div className="rounded border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-300">
            {error}
          </div>
        )}
        {recent === null ? (
          <div className="rounded border border-border bg-background/40 p-6 text-sm text-muted-foreground">
            Loading…
          </div>
        ) : recent.length === 0 ? (
          <div className="rounded border border-dashed border-border bg-background/40 p-6 text-center text-sm text-muted-foreground">
            No stocks researched yet. Search for a ticker above to start.
          </div>
        ) : (
          <div className="space-y-2">
            {recent.map((s) => (
              <StockRow key={s.symbol} stock={s} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function StockRow({ stock: s }: { stock: RecentStock }) {
  // Memoise the badges so a parent rerender doesn't churn child Link
  // components unnecessarily.
  const badges = useMemo(
    () =>
      BADGES.map((b) => ({
        ...b,
        n: b.count(s.modules),
      })),
    [s.modules],
  );

  return (
    <div className="rounded-md border border-border bg-background/30 p-3 hover:bg-white/[0.02]">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <Link
          href={`/research/${encodeURIComponent(s.symbol)}`}
          className="flex items-baseline gap-3 hover:underline"
        >
          <span className="font-mono text-sm font-semibold text-foreground">
            {s.symbol}
          </span>
          <span className="truncate text-xs text-muted-foreground">
            {s.company_name ?? "—"}
          </span>
        </Link>
        <div className="flex items-center gap-2">
          {s.sector && (
            <span className="text-[10px] text-muted-foreground/80">
              {s.sector}
            </span>
          )}
          <span
            className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${gradeClasses(
              s.overall_grade,
            )}`}
            title={s.overall_grade ? `Grade ${s.overall_grade}` : "Not yet graded"}
          >
            {s.overall_grade ?? "—"}
          </span>
        </div>
      </div>
      <div className="mt-1 text-[11px] text-muted-foreground">
        Last researched: {fmtResearchedAt(s.last_researched_at)}
        {!s.overall_grade && (
          <span className="ml-2 italic">· Not yet graded</span>
        )}
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {badges.map((b) => (
          <ModuleBadge
            key={b.tab}
            symbol={s.symbol}
            tab={b.tab}
            label={b.label}
            count={b.n}
            showCount={b.showCount}
          />
        ))}
      </div>
    </div>
  );
}

function ModuleBadge({
  symbol,
  tab,
  label,
  count,
  showCount,
}: {
  symbol: string;
  tab: string;
  label: string;
  count: number;
  showCount: boolean;
}) {
  const hasData = count > 0;
  const cls = hasData
    ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/20"
    : "border-border bg-background/40 text-muted-foreground hover:bg-background/60";
  return (
    <Link
      href={`/research/${encodeURIComponent(symbol)}?tab=${tab}`}
      className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium transition-colors ${cls}`}
      title={hasData ? `Open ${label} tab` : `Generate ${label} module`}
    >
      <span>{hasData ? "✅" : "⬜"}</span>
      <span>{label}</span>
      {showCount && count > 1 && (
        <span className="text-emerald-300/70">×{count}</span>
      )}
    </Link>
  );
}

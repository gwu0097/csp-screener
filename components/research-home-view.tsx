"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Search } from "lucide-react";

type RecentStock = {
  symbol: string;
  company_name: string | null;
  sector: string | null;
  overall_grade: string | null;
  last_researched_at: string | null;
};

function fmtRelDate(iso: string | null): string {
  if (!iso) return "never";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "unknown";
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function gradeClasses(g: string | null): string {
  if (g === "A") return "border-emerald-500/40 bg-emerald-500/15 text-emerald-300";
  if (g === "B") return "border-teal-500/40 bg-teal-500/15 text-teal-300";
  if (g === "C") return "border-amber-500/40 bg-amber-500/15 text-amber-300";
  if (g === "D") return "border-rose-500/40 bg-rose-500/15 text-rose-300";
  return "border-zinc-500/40 bg-zinc-500/15 text-zinc-400";
}

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
        <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Recently researched
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
            No research yet. Search for a ticker above to get started.
          </div>
        ) : (
          <div className="space-y-1">
            {recent.map((s) => (
              <Link
                key={s.symbol}
                href={`/research/${encodeURIComponent(s.symbol)}`}
                className="flex items-center gap-3 rounded-md border border-border bg-background/30 px-3 py-2 text-xs hover:bg-white/[0.03]"
              >
                <span className="w-16 truncate font-mono text-sm font-semibold text-foreground">
                  {s.symbol}
                </span>
                <span className="flex-1 truncate text-muted-foreground">
                  {s.company_name ?? "—"}
                </span>
                {s.sector && (
                  <span className="hidden truncate text-[11px] text-muted-foreground md:inline">
                    {s.sector}
                  </span>
                )}
                <span
                  className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold ${gradeClasses(
                    s.overall_grade,
                  )}`}
                >
                  {s.overall_grade ?? "—"}
                </span>
                <span className="hidden text-[11px] text-muted-foreground md:inline">
                  {fmtRelDate(s.last_researched_at)}
                </span>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

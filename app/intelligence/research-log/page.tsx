"use client";

// Research Log — every saved filing analysis across every symbol, in
// one searchable table. filing_analyses is shared knowledge (Deep
// Research has no per-user siloing), so this shows all analyses
// regardless of who saved them. Rows deep-link to that symbol's Deep
// Research 10-K tab where the full analysis renders.

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Loader2, StickyNote } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

type LogRow = {
  id: string;
  symbol: string;
  company_name: string | null;
  filing_type: string | null;
  period: string | null;
  filing_date: string | null;
  reviewed_at: string | null;
  preview: string;
  analysis_text: string;
  has_notes: boolean;
};

const FILTER_CHIPS = ["All", "8-K", "10-Q", "10-K"] as const;
type FilterChip = (typeof FILTER_CHIPS)[number];

type SortKey = "reviewed_at" | "symbol" | "filing_date";

function relativeTime(iso: string | null): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "—";
  const mins = Math.floor((Date.now() - then) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months === 1 ? "" : "s"} ago`;
  const years = Math.floor(months / 12);
  return `${years} year${years === 1 ? "" : "s"} ago`;
}

function filingBadgeClass(t: string | null): string {
  if (t === "8-K") return "border-sky-500/40 bg-sky-500/10 text-sky-300";
  if (t === "10-Q") return "border-amber-500/40 bg-amber-500/10 text-amber-300";
  if (t === "10-K") return "border-emerald-500/40 bg-emerald-500/10 text-emerald-300";
  return "border-border bg-muted/20 text-muted-foreground";
}

export default function ResearchLogPage() {
  const router = useRouter();
  const [rows, setRows] = useState<LogRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [chip, setChip] = useState<FilterChip>("All");
  const [sortKey, setSortKey] = useState<SortKey>("reviewed_at");
  const [sortAsc, setSortAsc] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/intelligence/research-log", { cache: "no-store" });
        const json = (await res.json()) as { analyses?: LogRow[]; error?: string };
        if (!res.ok || json.error) throw new Error(json.error ?? `HTTP ${res.status}`);
        if (!cancelled) setRows(json.analyses ?? []);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Load failed");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = useMemo(() => {
    if (!rows) return [];
    const q = search.trim().toLowerCase();
    let out = rows.filter((r) => {
      if (chip !== "All" && r.filing_type !== chip) return false;
      if (q === "") return true;
      return (
        r.symbol.toLowerCase().includes(q) ||
        (r.company_name ?? "").toLowerCase().includes(q) ||
        r.analysis_text.toLowerCase().includes(q)
      );
    });
    const dir = sortAsc ? 1 : -1;
    out = [...out].sort((a, b) => {
      if (sortKey === "symbol") return dir * a.symbol.localeCompare(b.symbol);
      const av = (sortKey === "filing_date" ? a.filing_date : a.reviewed_at) ?? "";
      const bv = (sortKey === "filing_date" ? b.filing_date : b.reviewed_at) ?? "";
      return dir * av.localeCompare(bv);
    });
    return out;
  }, [rows, search, chip, sortKey, sortAsc]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortAsc((v) => !v);
    else {
      setSortKey(key);
      setSortAsc(key === "symbol");
    }
  }
  const sortMark = (key: SortKey) =>
    sortKey === key ? (sortAsc ? " ↑" : " ↓") : "";

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Research Log</h1>
        <p className="text-sm text-muted-foreground">
          All saved filing analyses across all symbols
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search symbol or keyword…"
          className="w-full max-w-sm rounded border border-border bg-background px-3 py-1.5 text-base placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-foreground/40"
        />
        <div className="flex gap-1.5">
          {FILTER_CHIPS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setChip(c)}
              className={
                "rounded-full border px-3 py-1 text-sm " +
                (chip === c
                  ? "border-foreground/60 bg-foreground/10 text-foreground"
                  : "border-border text-muted-foreground hover:bg-muted/20")
              }
            >
              {c}
            </button>
          ))}
        </div>
      </div>

      {error ? (
        <div className="rounded border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
          {error}
        </div>
      ) : rows === null ? (
        <div className="flex items-center gap-2 py-10 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading research log…
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded border border-border bg-background/40 p-6 text-base text-muted-foreground">
          No filing analyses yet — export a filing from Deep Research and paste
          Claude&apos;s analysis to save it.
        </div>
      ) : (
        <>
          <div className="max-h-[640px] overflow-y-auto rounded border border-border">
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-background">
                <TableRow>
                  <TableHead
                    className="cursor-pointer select-none"
                    onClick={() => toggleSort("symbol")}
                  >
                    Symbol{sortMark("symbol")}
                  </TableHead>
                  <TableHead>Company</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Period</TableHead>
                  <TableHead
                    className="cursor-pointer select-none"
                    onClick={() => toggleSort("filing_date")}
                  >
                    Filed{sortMark("filing_date")}
                  </TableHead>
                  <TableHead
                    className="cursor-pointer select-none"
                    onClick={() => toggleSort("reviewed_at")}
                  >
                    Reviewed{sortMark("reviewed_at")}
                  </TableHead>
                  <TableHead>Preview</TableHead>
                  <TableHead className="w-8"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={8}
                      className="py-6 text-center text-base text-muted-foreground"
                    >
                      No analyses match.
                    </TableCell>
                  </TableRow>
                ) : (
                  filtered.map((r) => (
                    <TableRow
                      key={r.id}
                      className="cursor-pointer hover:bg-muted/20"
                      onClick={() =>
                        router.push(`/research/${encodeURIComponent(r.symbol)}?tab=tenk`)
                      }
                    >
                      <TableCell className="font-mono font-semibold">
                        <Link
                          href={`/research/${encodeURIComponent(r.symbol)}?tab=tenk`}
                          onClick={(e) => e.stopPropagation()}
                          className="hover:underline"
                        >
                          {r.symbol}
                        </Link>
                      </TableCell>
                      <TableCell className="max-w-[180px] truncate text-muted-foreground">
                        {r.company_name ?? "—"}
                      </TableCell>
                      <TableCell>
                        <span
                          className={`inline-block rounded border px-2 py-0.5 text-[11px] font-medium ${filingBadgeClass(r.filing_type)}`}
                        >
                          {r.filing_type ?? "—"}
                        </span>
                      </TableCell>
                      <TableCell className="whitespace-nowrap">{r.period ?? "—"}</TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        {r.filing_date ?? "—"}
                      </TableCell>
                      <TableCell
                        className="whitespace-nowrap text-muted-foreground"
                        title={r.reviewed_at ?? undefined}
                      >
                        {relativeTime(r.reviewed_at)}
                      </TableCell>
                      <TableCell className="max-w-[360px] truncate text-sm text-muted-foreground">
                        {r.preview}
                        {r.analysis_text.length > 120 ? "…" : ""}
                      </TableCell>
                      <TableCell>
                        {r.has_notes && (
                          <StickyNote
                            className="h-3.5 w-3.5 text-amber-300"
                            aria-label="Has notes"
                          />
                        )}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
          <div className="text-sm text-muted-foreground">
            Showing {filtered.length} of {rows.length} analyses · shared across
            all users
          </div>
        </>
      )}
    </div>
  );
}

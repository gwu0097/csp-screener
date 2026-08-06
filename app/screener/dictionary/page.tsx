"use client";

// Observation Dictionary — read-only browse of CANDIDATE_OBSERVATIONS
// terms (research analysis template v4+, lib/analysis-dump-template.ts).
// Fed entirely by /api/screener/observation-dictionary; no writes happen
// from this page. Setup observations and app defects have different
// lifecycles (a recurring setup observation is a candidate for
// promotion into the checklist; a recurring app defect is a bug to fix)
// so they're kept in two separately-labeled sections, never merged into
// one sorted list.

import { useEffect, useMemo, useState } from "react";
import { Fragment } from "react";
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { ObservationDictionaryEntry, ObservationUsage } from "@/lib/observation-dictionary";

type SortKey = "use_count" | "last_used_at";

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function KindSection({
  title,
  entries,
  usagesByTerm,
  expanded,
  onToggle,
}: {
  title: string;
  entries: ObservationDictionaryEntry[];
  usagesByTerm: Map<string, ObservationUsage[]>;
  expanded: Set<string>;
  onToggle: (term: string) => void;
}) {
  return (
    <div className="space-y-2">
      <h2 className="text-base font-semibold">
        {title} <span className="text-sm font-normal text-muted-foreground">({entries.length})</span>
      </h2>
      {entries.length === 0 ? (
        <div className="rounded border border-border bg-background/40 p-4 text-sm text-muted-foreground">
          None yet.
        </div>
      ) : (
        <div className="overflow-x-auto rounded border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-6" />
                <TableHead>Term</TableHead>
                <TableHead>Definition</TableHead>
                <TableHead className="text-right">Uses</TableHead>
                <TableHead>First used</TableHead>
                <TableHead>Last used</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map((e) => {
                const usages = (usagesByTerm.get(e.term) ?? [])
                  .slice()
                  .sort((a, b) => b.earnings_date.localeCompare(a.earnings_date));
                const isOpen = expanded.has(e.term);
                return (
                  <Fragment key={e.term}>
                    <TableRow className="cursor-pointer" onClick={() => onToggle(e.term)}>
                      <TableCell>
                        {isOpen ? (
                          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                        ) : (
                          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                        )}
                      </TableCell>
                      <TableCell className="font-mono font-medium">{e.term}</TableCell>
                      <TableCell className="max-w-[420px] text-muted-foreground">{e.definition}</TableCell>
                      <TableCell className="text-right">{e.use_count}</TableCell>
                      <TableCell className="text-muted-foreground">{fmtDate(e.first_used_at)}</TableCell>
                      <TableCell className="text-muted-foreground">{fmtDate(e.last_used_at)}</TableCell>
                    </TableRow>
                    {isOpen && (
                      <TableRow>
                        <TableCell />
                        <TableCell colSpan={5} className="bg-muted/10 text-xs">
                          {usages.length === 0 ? (
                            <span className="text-muted-foreground">No usages recorded.</span>
                          ) : (
                            <div className="flex flex-wrap gap-x-3 gap-y-1 py-1">
                              {usages.map((u, i) => (
                                <span key={`${u.symbol}-${u.earnings_date}-${i}`} className="font-mono">
                                  {u.symbol} <span className="text-muted-foreground">({u.earnings_date})</span>
                                </span>
                              ))}
                            </div>
                          )}
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

export default function ObservationDictionaryPage() {
  const [entries, setEntries] = useState<ObservationDictionaryEntry[] | null>(null);
  const [usages, setUsages] = useState<ObservationUsage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("use_count");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/screener/observation-dictionary", { cache: "no-store" });
        const json = (await res.json()) as {
          entries?: ObservationDictionaryEntry[];
          usages?: ObservationUsage[];
          error?: string;
        };
        if (!res.ok || json.error) throw new Error(json.error ?? `HTTP ${res.status}`);
        if (!cancelled) {
          setEntries(json.entries ?? []);
          setUsages(json.usages ?? []);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Load failed");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const usagesByTerm = useMemo(() => {
    const m = new Map<string, ObservationUsage[]>();
    for (const u of usages) {
      const list = m.get(u.term);
      if (list) list.push(u);
      else m.set(u.term, [u]);
    }
    return m;
  }, [usages]);

  const filteredSorted = useMemo(() => {
    if (!entries) return [];
    const q = search.trim().toLowerCase();
    const filtered =
      q === ""
        ? entries
        : entries.filter(
            (e) => e.term.toLowerCase().includes(q) || e.definition.toLowerCase().includes(q),
          );
    return filtered.slice().sort((a, b) => {
      if (sortKey === "use_count") return b.use_count - a.use_count;
      return (b.last_used_at ?? "").localeCompare(a.last_used_at ?? "");
    });
  }, [entries, search, sortKey]);

  const setupObservations = filteredSorted.filter((e) => e.kind === "setup_observation");
  const appDefects = filteredSorted.filter((e) => e.kind === "app_defect");

  function toggle(term: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(term)) next.delete(term);
      else next.add(term);
      return next;
    });
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Observation Dictionary</h1>
        <p className="text-sm text-muted-foreground">
          Terms proposed in research analysis CANDIDATE_OBSERVATIONS blocks — read-only. A recurring setup
          observation is a candidate for promotion into the checklist; a recurring app defect is a bug to
          fix.
        </p>
      </div>

      {error ? (
        <div className="rounded border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
          {error}
        </div>
      ) : entries === null ? (
        <div className="flex items-center gap-2 py-10 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading dictionary…
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search term or definition…"
              className="w-full max-w-sm rounded border border-border bg-background px-3 py-1.5 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-foreground/40"
            />
            <div className="flex items-center gap-1 text-sm">
              <span className="text-muted-foreground">Sort:</span>
              <button
                type="button"
                onClick={() => setSortKey("use_count")}
                className={`rounded border px-2 py-1 ${
                  sortKey === "use_count"
                    ? "border-foreground/50 bg-foreground/5"
                    : "border-border text-muted-foreground hover:bg-muted/20"
                }`}
              >
                Most used
              </button>
              <button
                type="button"
                onClick={() => setSortKey("last_used_at")}
                className={`rounded border px-2 py-1 ${
                  sortKey === "last_used_at"
                    ? "border-foreground/50 bg-foreground/5"
                    : "border-border text-muted-foreground hover:bg-muted/20"
                }`}
              >
                Recently used
              </button>
            </div>
          </div>

          {entries.length === 0 ? (
            <div className="rounded border border-border bg-background/40 p-6 text-base text-muted-foreground">
              No observations recorded yet.
            </div>
          ) : (
            <div className="space-y-6">
              <KindSection
                title="Setup Observations"
                entries={setupObservations}
                usagesByTerm={usagesByTerm}
                expanded={expanded}
                onToggle={toggle}
              />
              <KindSection
                title="App Defects"
                entries={appDefects}
                usagesByTerm={usagesByTerm}
                expanded={expanded}
                onToggle={toggle}
              />
            </div>
          )}
        </>
      )}
    </div>
  );
}

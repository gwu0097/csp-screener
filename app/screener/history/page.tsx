"use client";

// Screener History — browsable log of past screener runs (append-only
// since 2026-07-06). Left panel lists runs (newest first, ticker + date
// filterable); right panel shows the selected run's full candidate
// table, read-only. Uses /api/screener/results/history: list mode for
// the left panel, ?id= detail mode for the right.

import { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

type SlimCandidate = { symbol: string; grade: string | null };

type RunSummary = {
  id: string;
  screenedAt: string | null;
  vix: number | null;
  pass1Count: number | null;
  pass2Count: number | null;
  graded: boolean;
  candidateCount: number;
  candidates: SlimCandidate[];
};

type DetailCandidate = {
  symbol: string;
  grade: string | null;
  price: number | null;
  em_pct: number | null;
  crush: string | null;
  strike: number | null;
  premium: number | null;
  yield_pct: number | null;
  recommendation: string | null;
};

type RunDetail = {
  id: string;
  screenedAt: string | null;
  vix: number | null;
  pass1Count: number | null;
  pass2Count: number | null;
  graded: boolean;
  candidates: DetailCandidate[];
};

const PAGE_SIZE = 20;

function fmtRunTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).replace(",", " ·");
}

function gradeClass(g: string | null): string {
  if (g === "A") return "text-emerald-300";
  if (g === "B") return "text-emerald-200/80";
  if (g === "C") return "text-amber-300";
  if (g === "F" || g === "D") return "text-rose-300";
  return "text-muted-foreground";
}

export default function ScreenerHistoryPage() {
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [visible, setVisible] = useState(PAGE_SIZE);

  // Load the run list once.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/screener/results/history?limit=100", {
          cache: "no-store",
        });
        const json = (await res.json()) as { runs?: RunSummary[]; error?: string };
        if (!res.ok || json.error) throw new Error(json.error ?? `HTTP ${res.status}`);
        if (!cancelled) {
          // 0-candidate rows are pre-analysis auto-saves (Screen Today
          // fired with nothing passing, or background snapshot writes)
          // — nothing to browse, so they're dropped from the list.
          const list = (json.runs ?? []).filter((r) => r.candidateCount > 0);
          setRuns(list);
          // Most recent run selected by default.
          if (list.length > 0) setSelectedId(list[0].id);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Load failed");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Load the selected run's detail.
  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    (async () => {
      try {
        const res = await fetch(
          `/api/screener/results/history?id=${encodeURIComponent(selectedId)}`,
          { cache: "no-store" },
        );
        const json = (await res.json()) as { run?: RunDetail; error?: string };
        if (!res.ok || json.error) throw new Error(json.error ?? `HTTP ${res.status}`);
        if (!cancelled) setDetail(json.run ?? null);
      } catch {
        if (!cancelled) setDetail(null);
      } finally {
        if (!cancelled) setDetailLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  const filteredRuns = useMemo(() => {
    if (!runs) return [];
    const q = search.trim().toUpperCase();
    return runs.filter((r) => {
      if (q !== "" && !r.candidates.some((c) => c.symbol.includes(q))) return false;
      const day = (r.screenedAt ?? "").slice(0, 10);
      if (fromDate && day < fromDate) return false;
      if (toDate && day > toDate) return false;
      return true;
    });
  }, [runs, search, fromDate, toDate]);

  // Keep the selection inside the filtered set so search doesn't leave
  // a hidden run loaded in the right panel.
  useEffect(() => {
    if (!runs || filteredRuns.length === 0) return;
    if (!filteredRuns.some((r) => r.id === selectedId)) {
      setSelectedId(filteredRuns[0].id);
    }
  }, [filteredRuns, runs, selectedId]);

  const shown = filteredRuns.slice(0, visible);
  const filtersActive = search.trim() !== "" || fromDate !== "" || toDate !== "";

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Screener History</h1>
        <p className="text-sm text-muted-foreground">
          Every saved screener run — search a ticker to find the runs it appeared in
        </p>
      </div>

      {error ? (
        <div className="rounded border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
          {error}
        </div>
      ) : runs === null ? (
        <div className="flex items-center gap-2 py-10 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading run history…
        </div>
      ) : runs.length === 0 ? (
        <div className="rounded border border-border bg-background/40 p-6 text-base text-muted-foreground">
          No screener runs saved yet — run Screen Today on the Candidates page.
          Runs are kept from 2026-07-06 onward.
        </div>
      ) : (
        <div className="flex flex-col gap-4 lg:flex-row">
          {/* -------- Left panel: run list -------- */}
          <div className="w-full shrink-0 space-y-2 lg:w-[300px]">
            <input
              type="text"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setVisible(PAGE_SIZE);
              }}
              placeholder="Search ticker across runs…"
              className="w-full rounded border border-border bg-background px-3 py-1.5 text-base placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-foreground/40"
            />
            <div className="flex items-center gap-1.5 text-sm">
              <input
                type="date"
                value={fromDate}
                onChange={(e) => setFromDate(e.target.value)}
                className="w-full rounded border border-border bg-background px-2 py-1 text-sm"
              />
              <span className="text-muted-foreground">→</span>
              <input
                type="date"
                value={toDate}
                onChange={(e) => setToDate(e.target.value)}
                className="w-full rounded border border-border bg-background px-2 py-1 text-sm"
              />
              {filtersActive && (
                <button
                  type="button"
                  onClick={() => {
                    setSearch("");
                    setFromDate("");
                    setToDate("");
                    setVisible(PAGE_SIZE);
                  }}
                  className="whitespace-nowrap rounded border border-border px-2 py-1 text-sm text-muted-foreground hover:bg-muted/20"
                >
                  Clear
                </button>
              )}
            </div>

            <div className="max-h-[600px] space-y-1.5 overflow-y-auto pr-1">
              {shown.length === 0 ? (
                <div className="rounded border border-border bg-background/40 p-4 text-sm text-muted-foreground">
                  No runs match{search.trim() !== "" ? ` “${search.trim().toUpperCase()}”` : ""}.
                </div>
              ) : (
                shown.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => setSelectedId(r.id)}
                    className={
                      "w-full rounded-md border px-3 py-2 text-left " +
                      (r.id === selectedId
                        ? "border-foreground/50 bg-foreground/5"
                        : "border-border bg-background/40 hover:bg-muted/10")
                    }
                  >
                    <div className="flex items-baseline justify-between">
                      <span className="text-sm font-medium">
                        {fmtRunTime(r.screenedAt)}
                      </span>
                      <span className="text-[11px] text-muted-foreground">
                        {r.vix !== null ? `VIX ${Number(r.vix).toFixed(1)}` : "VIX —"}
                      </span>
                    </div>
                    <div className="mt-0.5 flex items-baseline justify-between">
                      <span className="text-[11px] text-muted-foreground">
                        {r.candidateCount} candidate{r.candidateCount === 1 ? "" : "s"}
                        {!r.graded && r.candidateCount > 0 ? " · ungraded" : ""}
                      </span>
                    </div>
                    {r.candidates.length > 0 && (
                      <div className="mt-1 truncate font-mono text-[11px]">
                        {r.candidates.slice(0, 3).map((c, i) => (
                          <span key={`${c.symbol}${i}`}>
                            {i > 0 && <span className="text-muted-foreground"> · </span>}
                            {c.symbol}
                            {c.grade && (
                              <span className={` ${gradeClass(c.grade)}`}> {c.grade}</span>
                            )}
                          </span>
                        ))}
                      </div>
                    )}
                  </button>
                ))
              )}
              {filteredRuns.length > visible && (
                <button
                  type="button"
                  onClick={() => setVisible((v) => v + PAGE_SIZE)}
                  className="w-full rounded border border-border px-3 py-1.5 text-sm text-muted-foreground hover:bg-muted/20"
                >
                  Load {Math.min(PAGE_SIZE, filteredRuns.length - visible)} more (
                  {filteredRuns.length - visible} older)
                </button>
              )}
            </div>
          </div>

          {/* -------- Right panel: run detail -------- */}
          <div className="min-w-0 flex-1">
            {detailLoading ? (
              <div className="flex items-center gap-2 py-10 text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading run…
              </div>
            ) : !detail ? (
              <div className="rounded border border-border bg-background/40 p-6 text-base text-muted-foreground">
                Select a run to view its candidates.
              </div>
            ) : (
              <div className="space-y-3">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="text-base font-semibold">
                    {fmtRunTime(detail.screenedAt)}
                  </span>
                  <span className="text-sm text-muted-foreground">
                    {detail.vix !== null ? `VIX ${Number(detail.vix).toFixed(1)}` : "VIX —"}
                  </span>
                  <span className="text-sm text-muted-foreground">
                    {detail.candidates.length} candidate
                    {detail.candidates.length === 1 ? "" : "s"}
                    {detail.pass1Count !== null ? ` from ${detail.pass1Count} screened` : ""}
                  </span>
                  {!detail.graded && (
                    <span className="rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[11px] text-amber-300">
                      pre-analysis run
                    </span>
                  )}
                </div>

                {detail.candidates.length === 0 ? (
                  <div className="rounded border border-border bg-background/40 p-6 text-base text-muted-foreground">
                    This run produced no candidates.
                  </div>
                ) : (
                  <div className="max-h-[600px] overflow-y-auto rounded border border-border">
                    <Table>
                      <TableHeader className="sticky top-0 z-10 bg-background">
                        <TableRow>
                          <TableHead>Symbol</TableHead>
                          <TableHead>Grade</TableHead>
                          <TableHead className="text-right">Price</TableHead>
                          <TableHead className="text-right">EM%</TableHead>
                          <TableHead>Crush</TableHead>
                          <TableHead className="text-right">Strike</TableHead>
                          <TableHead className="text-right">Premium</TableHead>
                          <TableHead className="text-right">Yield</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {detail.candidates.map((c, i) => (
                          <TableRow key={`${c.symbol}${i}`}>
                            <TableCell className="font-mono font-semibold">
                              {c.symbol}
                            </TableCell>
                            <TableCell className={`font-medium ${gradeClass(c.grade)}`}>
                              {c.grade ?? "—"}
                            </TableCell>
                            <TableCell className="text-right">
                              {c.price !== null ? `$${c.price.toFixed(2)}` : "—"}
                            </TableCell>
                            <TableCell className="text-right">
                              {c.em_pct !== null ? `${(c.em_pct * 100).toFixed(1)}%` : "—"}
                            </TableCell>
                            <TableCell className={gradeClass(c.crush)}>
                              {c.crush ?? "—"}
                            </TableCell>
                            <TableCell className="text-right">
                              {c.strike !== null ? `$${c.strike}` : "—"}
                            </TableCell>
                            <TableCell className="text-right">
                              {c.premium !== null ? `$${c.premium.toFixed(2)}` : "—"}
                            </TableCell>
                            <TableCell className="text-right">
                              {c.yield_pct !== null ? `${c.yield_pct.toFixed(2)}%` : "—"}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

"use client";

// Screener History — reorganized by earnings event (2026-09-04), was
// previously organized by scan run. One row per (symbol, earnings_date);
// a ticker screened 3x in one day appears once. Backed by
// /api/screener/history-by-event, which reconstructs "grade at scan"
// from the last screener run before earnings_date per event (not the
// last scan overall — see that route's header comment) and sources
// EM/actual move from earnings_history, never from a candidate's live
// stageThree.details.expectedMovePct.
//
// Grouped by day (2026-09-04) with the date folded into a sticky day
// header instead of a per-row column — rows only need Symbol/Timing
// once the header carries the date. Search bypasses the date range
// entirely (server-side ?symbol= query, not a client-side filter of
// the loaded window) since a ticker lookup and a date-range browse are
// two different questions, not one narrowing the other.
//
// The old scan-centric browser still exists at
// /api/screener/results/history and isn't deleted — this page's "N
// scans" affordance surfaces the same underlying runs per event instead
// of replacing that data.

import { Fragment, useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ExpandedDetail } from "@/components/screener-view";
import type { ScreenerResult } from "@/lib/screener";

type ScanVerdict = "pre" | "post" | "unknown";
type EventScan = { runId: string; screenedAt: string; grade: string | null; verdict: ScanVerdict };

type GradeAtScanStatus = "resolved" | "post_print_only" | "timing_unknown" | "not_scanned";

type EventRow = {
  eventId: string;
  symbol: string;
  earningsDate: string;
  timing: string | null;
  impliedMovePct: number | null;
  actualMovePct: number | null;
  ratio: number | null;
  gradeAtScan: string | null;
  // "resolved": gradeAtScan is a real pre-event read. "post_print_only":
  // every scan is confirmed post-event (session-aware). "timing_unknown":
  // a same-day scan exists but this row's own BMO/AMC timing isn't known,
  // so it can't be classified either way — not the same as confirmed
  // post-print. "not_scanned": zero scans at all.
  gradeAtScanStatus: GradeAtScanStatus;
  hasPosition: boolean;
  scans: EventScan[];
  drilldownCandidate: Record<string, unknown> | null;
  drilldownScreenedAt: string | null;
};

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}
function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

function gradeAtScanLabel(status: GradeAtScanStatus): string {
  if (status === "post_print_only") return "post-print only";
  if (status === "timing_unknown") return "timing unknown";
  return "not scanned";
}

function gradeClass(g: string | null): string {
  if (g === "A") return "text-emerald-300";
  if (g === "B") return "text-emerald-200/80";
  if (g === "C") return "text-amber-300";
  if (g === "F" || g === "D") return "text-rose-300";
  return "text-muted-foreground";
}

function fmtPct(n: number | null, digits = 1): string {
  if (n === null || !Number.isFinite(n)) return "—";
  return `${(Math.abs(n) * 100).toFixed(digits)}%`;
}
function fmtSignedPct(n: number | null, digits = 1): string {
  if (n === null || !Number.isFinite(n)) return "—";
  const pct = n * 100;
  return pct > 0 ? `+${pct.toFixed(digits)}%` : `${pct.toFixed(digits)}%`;
}
function fmtRatio(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  return `${n.toFixed(2)}x`;
}
function fmtScanTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
// "Wed Sep 3" — the sticky day header; carries what the old per-row
// Earnings column used to.
function fmtDayHeader(iso: string): string {
  const d = new Date(iso + "T12:00:00Z"); // noon UTC — never rolls to the adjacent day locally
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

// EM/actual are null for two structurally different reasons — "hasn't
// happened yet" and "should have been captured and wasn't" — and
// collapsing both to a blank cell hides exactly the distinction this
// view exists to preserve (see the build request this route was written
// for). today/tomorrow always reads as pending; further out without a
// value is a real gap worth a different label.
function emState(impliedMovePct: number | null, earningsDate: string, today: string): string {
  if (impliedMovePct !== null) return fmtPct(impliedMovePct);
  return earningsDate >= today ? "pending" : "not captured";
}
function actualState(actualMovePct: number | null, earningsDate: string, today: string): string {
  if (actualMovePct !== null) return fmtSignedPct(actualMovePct);
  const daysSince = Math.round(
    (Date.parse(today + "T00:00:00Z") - Date.parse(earningsDate + "T00:00:00Z")) / 86_400_000,
  );
  if (daysSince <= 1) return "pending";
  return "not captured";
}

const COLSPAN = 8; // Symbol, Timing, Grade, EM, Actual, Ratio, Position, Scans

export default function ScreenerHistoryPage() {
  const [fromDate, setFromDate] = useState(daysAgoIso(7));
  const [toDate, setToDate] = useState(todayIso());
  const [search, setSearch] = useState("");
  const [events, setEvents] = useState<EventRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [expandedScansKey, setExpandedScansKey] = useState<string | null>(null);
  // Explicit per-day expand/collapse — seeded once events first load
  // (today + yesterday open, everything older collapsed) and freely
  // toggled after that. A Set of expanded days, not collapsed ones, so
  // a NEW day appearing after a refetch defaults to whatever the
  // seeding effect below decides, not silently expanded.
  const [expandedDays, setExpandedDays] = useState<Set<string> | null>(null);

  const today = todayIso();
  const yesterday = daysAgoIso(1);
  const searchQuery = search.trim().toUpperCase();

  // Search bypasses the date range entirely — a ticker lookup and a
  // date-range browse are different questions. Debounced so every
  // keystroke doesn't fire a request.
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      setLoading(true);
      setError(null);
      const url =
        searchQuery !== ""
          ? `/api/screener/history-by-event?symbol=${encodeURIComponent(searchQuery)}`
          : `/api/screener/history-by-event?from=${encodeURIComponent(fromDate)}&to=${encodeURIComponent(toDate)}`;
      (async () => {
        try {
          const res = await fetch(url, { cache: "no-store" });
          const json = (await res.json()) as { events?: EventRow[]; error?: string };
          if (!res.ok || json.error) throw new Error(json.error ?? `HTTP ${res.status}`);
          if (!cancelled) {
            setEvents(json.events ?? []);
            setExpandedDays(null); // reseed default expand state for the new set
          }
        } catch (e) {
          if (!cancelled) setError(e instanceof Error ? e.message : "Load failed");
        } finally {
          if (!cancelled) setLoading(false);
        }
      })();
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [fromDate, toDate, searchQuery]);

  const groupedByDay = useMemo(() => {
    if (!events) return [];
    const byDay = new Map<string, EventRow[]>();
    for (const e of events) {
      const list = byDay.get(e.earningsDate) ?? [];
      list.push(e);
      byDay.set(e.earningsDate, list);
    }
    return Array.from(byDay.entries()).sort((a, b) => b[0].localeCompare(a[0]));
  }, [events]);

  // Seed default expand state once per fresh load: today + yesterday
  // open, older collapsed.
  useEffect(() => {
    if (expandedDays !== null || groupedByDay.length === 0) return;
    const initial = new Set<string>();
    for (const [day] of groupedByDay) {
      if (day === today || day === yesterday) initial.add(day);
    }
    setExpandedDays(initial);
  }, [groupedByDay, expandedDays, today, yesterday]);

  function toggleDay(day: string) {
    setExpandedDays((prev) => {
      const next = new Set(prev ?? []);
      if (next.has(day)) next.delete(day);
      else next.add(day);
      return next;
    });
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Screener History</h1>
        <p className="text-sm text-muted-foreground">
          One row per earnings event, not per scan — grade at scan is from the last run before the print.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search ticker (whole history)…"
          className="w-52 rounded border border-border bg-background px-3 py-1.5 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-foreground/40"
        />
        <input
          type="date"
          value={fromDate}
          onChange={(e) => setFromDate(e.target.value)}
          disabled={searchQuery !== ""}
          className="rounded border border-border bg-background px-2 py-1 text-sm disabled:opacity-40"
        />
        <span className="text-muted-foreground">→</span>
        <input
          type="date"
          value={toDate}
          onChange={(e) => setToDate(e.target.value)}
          disabled={searchQuery !== ""}
          className="rounded border border-border bg-background px-2 py-1 text-sm disabled:opacity-40"
        />
        <button
          type="button"
          onClick={() => {
            setFromDate(daysAgoIso(7));
            setToDate(todayIso());
          }}
          disabled={searchQuery !== ""}
          className="rounded border border-border px-2 py-1 text-sm text-muted-foreground hover:bg-muted/20 disabled:opacity-40"
        >
          Last 7 days
        </button>
        {searchQuery !== "" && (
          <span className="text-[11px] text-muted-foreground">
            Searching all of history for &quot;{searchQuery}&quot; — date range paused.
          </span>
        )}
      </div>

      {error ? (
        <div className="rounded border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
          {error}
        </div>
      ) : loading || events === null ? (
        <div className="flex items-center gap-2 py-10 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : groupedByDay.length === 0 ? (
        <div className="rounded border border-border bg-background/40 p-6 text-base text-muted-foreground">
          {searchQuery !== ""
            ? `No earnings events found for "${searchQuery}".`
            : "No earnings events in this range."}
        </div>
      ) : (
        <div className="overflow-x-auto rounded border border-border">
          <Table>
            {/* One real <thead> for the whole table — column headers stay
                sticky at the very top; per-day headers (below) stick just
                beneath them via a matching top offset. HTML allows only
                one <thead> per <table>, unlike <tbody> (one per day). */}
            <TableHeader className="sticky top-0 z-20 bg-background">
              <TableRow>
                <TableHead>Symbol</TableHead>
                <TableHead>Timing</TableHead>
                <TableHead>Grade at scan</TableHead>
                <TableHead className="text-right">EM</TableHead>
                <TableHead className="text-right">Actual</TableHead>
                <TableHead className="text-right">Ratio</TableHead>
                <TableHead>Position</TableHead>
                <TableHead>Scans</TableHead>
              </TableRow>
            </TableHeader>
            {groupedByDay.map(([day, dayEvents]) => {
              const isDayOpen = expandedDays?.has(day) ?? false;
              return (
                <TableBody key={day}>
                  <TableRow className="hover:bg-transparent">
                    <TableCell colSpan={COLSPAN} className="sticky top-12 z-10 bg-background p-0">
                      <button
                        type="button"
                        onClick={() => toggleDay(day)}
                        className="flex w-full items-center gap-2 border-y border-border bg-muted/40 px-3 py-1.5 text-left text-sm font-semibold hover:bg-muted/60"
                      >
                        {isDayOpen ? (
                          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                        ) : (
                          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                        )}
                        {fmtDayHeader(day)}
                        <span className="font-normal text-muted-foreground">
                          · {dayEvents.length} event{dayEvents.length === 1 ? "" : "s"}
                        </span>
                      </button>
                    </TableCell>
                  </TableRow>
                  {isDayOpen &&
                      dayEvents.map((e) => {
                        const key = e.eventId;
                        const isOpen = expandedKey === key;
                        const isScansOpen = expandedScansKey === key;
                        return (
                          <Fragment key={key}>
                            <TableRow
                              className="cursor-pointer hover:bg-muted/10"
                              onClick={() => setExpandedKey(isOpen ? null : key)}
                            >
                              <TableCell className="font-mono font-semibold">
                                <span className="inline-flex items-center gap-1">
                                  {isOpen ? (
                                    <ChevronDown className="h-3 w-3 text-muted-foreground" />
                                  ) : (
                                    <ChevronRight className="h-3 w-3 text-muted-foreground" />
                                  )}
                                  {e.symbol}
                                </span>
                              </TableCell>
                              <TableCell className="text-[11px] uppercase text-muted-foreground">
                                {e.timing ?? "unknown"}
                              </TableCell>
                              <TableCell className={gradeClass(e.gradeAtScan)}>
                                {e.gradeAtScan ?? gradeAtScanLabel(e.gradeAtScanStatus)}
                              </TableCell>
                              <TableCell className="text-right font-mono">
                                {emState(e.impliedMovePct, e.earningsDate, today)}
                              </TableCell>
                              <TableCell
                                className={`text-right font-mono ${e.actualMovePct !== null && e.actualMovePct !== 0 ? (e.actualMovePct > 0 ? "text-emerald-300" : "text-rose-300") : ""}`}
                              >
                                {actualState(e.actualMovePct, e.earningsDate, today)}
                              </TableCell>
                              <TableCell className="text-right font-mono">{fmtRatio(e.ratio)}</TableCell>
                              <TableCell>
                                {e.hasPosition ? (
                                  <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-300">
                                    traded
                                  </span>
                                ) : (
                                  <span className="text-[11px] text-muted-foreground">—</span>
                                )}
                              </TableCell>
                              <TableCell onClick={(evt) => evt.stopPropagation()}>
                                {e.scans.length > 0 ? (
                                  <button
                                    type="button"
                                    onClick={() => setExpandedScansKey(isScansOpen ? null : key)}
                                    className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted/20"
                                  >
                                    {e.scans.length} scan{e.scans.length === 1 ? "" : "s"}
                                  </button>
                                ) : (
                                  <span className="text-[11px] text-muted-foreground">0 scans</span>
                                )}
                              </TableCell>
                            </TableRow>

                            {isScansOpen && (
                              <TableRow key={`${key}-scans`}>
                                <TableCell colSpan={COLSPAN} className="bg-muted/20 py-2">
                                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px]">
                                    {e.scans.map((s) => (
                                      <span key={s.runId} className="font-mono">
                                        {fmtScanTime(s.screenedAt)}{" "}
                                        <span className={gradeClass(s.grade)}>{s.grade ?? "—"}</span>
                                        {s.verdict === "post" && (
                                          <span className="ml-1 text-amber-400" title="Confirmed post-event scan">
                                            ⚠
                                          </span>
                                        )}
                                        {s.verdict === "unknown" && (
                                          <span
                                            className="ml-1 text-sky-400"
                                            title="Same-day scan, session (BMO/AMC) unknown — can't classify"
                                          >
                                            ?
                                          </span>
                                        )}
                                      </span>
                                    ))}
                                  </div>
                                </TableCell>
                              </TableRow>
                            )}

                            {isOpen && (
                              <TableRow key={`${key}-detail`}>
                                <TableCell colSpan={COLSPAN} className="bg-muted/30">
                                  {e.drilldownCandidate ? (
                                    <>
                                      {e.gradeAtScanStatus === "post_print_only" && (
                                        <div className="mb-2 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-300">
                                          No pre-event scan exists for this event — showing the nearest
                                          available scan ({fmtScanTime(e.drilldownScreenedAt ?? "")}),
                                          confirmed to have run after the print and may reflect a
                                          post-print situation.
                                        </div>
                                      )}
                                      {e.gradeAtScanStatus === "timing_unknown" && (
                                        <div className="mb-2 rounded border border-sky-500/40 bg-sky-500/10 px-2 py-1 text-[11px] text-sky-300">
                                          This event&apos;s BMO/AMC timing isn&apos;t known, and its only
                                          scan ran the same day as the print — showing it (
                                          {fmtScanTime(e.drilldownScreenedAt ?? "")}), but whether it&apos;s
                                          pre- or post-event can&apos;t be determined without the real
                                          session.
                                        </div>
                                      )}
                                      <ExpandedDetail
                                        r={e.drilldownCandidate as unknown as ScreenerResult}
                                        analyzing={false}
                                        onAnalyze={null}
                                        strikeOverride={null}
                                        onSelectStrike={() => {}}
                                        onResetStrike={() => {}}
                                        screenedAt={e.drilldownScreenedAt ? new Date(e.drilldownScreenedAt) : null}
                                      />
                                    </>
                                  ) : (
                                    <div className="p-4 text-sm text-muted-foreground">
                                      No scan data available for this event — it was never screened (e.g. a
                                      manually-tracked position).
                                    </div>
                                  )}
                                </TableCell>
                              </TableRow>
                            )}
                          </Fragment>
                        );
                      })}
                </TableBody>
              );
            })}
          </Table>
        </div>
      )}
    </div>
  );
}

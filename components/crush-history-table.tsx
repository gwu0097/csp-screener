"use client";

// Per-quarter crush history surfaced in the screener expanded row.
// Reads stageThree.details.crushHistory which is stamped server-side
// by runStagesThreeFour. ★ marks events within ±2pp of today's IV-
// implied move (today's EM is the only fair comparison set).

import { Fragment, useEffect, useState, type ReactNode } from "react";
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Loader2, XCircle } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { quarterLabel as computeQuarterLabel } from "@/lib/quarter-label";

// Advisory-only research analysis (research_analyses table) — pasted
// back from an external LLM conversation seeded by the Analysis Dump
// tab. Never feeds any calculation here; this is a read-only indicator
// + expandable detail per quarter.
type ResearchAnalysisRow = {
  symbol: string;
  earnings_date: string;
  flags_fired: string[];
  // Absent (undefined) on rows fetched before the flags_na column
  // existed is not possible here — select("*") always returns it,
  // defaulted to '{}' by the migration — but typed optional anyway so
  // a stale cached response shape can't crash the .length reads below.
  flags_na?: string[];
  flags_unknown: string[];
  candidate_flags: string[];
  checklist_version: string | null;
  template_version: string | null;
  analysis_prose: string | null;
  parse_status: "parsed" | "prose_only" | "partial";
  reference_strike: number | null;
  max_downside_ratio: number | null;
};

// Shared by both the pinned row (today's/most-recent event, rendered
// separately from the historical rows below it — see the `sorted`
// filter that excludes it) and the regular displayRows loop. Analyses
// get written the day of the print, so the pinned row is the primary
// place one needs to show — this was previously wired into displayRows
// only, which is why a same-day paste never appeared.
function ResearchAnalysisDetailRow({ rowKey, analysis }: { rowKey: string; analysis: ResearchAnalysisRow }) {
  return (
    <tr key={`${rowKey}-analysis`} className="border-t border-violet-500/20 bg-violet-500/[0.04]">
      <td colSpan={6} className="px-2 py-2 text-xs">
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
            <span>
              parse: <span className="font-mono">{analysis.parse_status}</span>
            </span>
            {analysis.checklist_version && (
              <span>
                checklist: <span className="font-mono">{analysis.checklist_version}</span>
              </span>
            )}
            {analysis.template_version && (
              <span>
                template: <span className="font-mono">{analysis.template_version}</span>
              </span>
            )}
            {analysis.reference_strike !== null && (
              <span>
                ref strike: <span className="font-mono">${analysis.reference_strike.toFixed(2)}</span>
              </span>
            )}
            {analysis.max_downside_ratio !== null && (
              <span>
                max downside ratio: <span className="font-mono">{analysis.max_downside_ratio.toFixed(3)}</span>
              </span>
            )}
          </div>
          {analysis.flags_fired.length > 0 && (
            <div>
              <span className="font-semibold text-violet-300">Fired: </span>
              {analysis.flags_fired.join(", ")}
            </div>
          )}
          {(analysis.flags_na?.length ?? 0) > 0 && (
            <div>
              <span className="font-semibold text-sky-300">N/A: </span>
              {(analysis.flags_na ?? []).join(", ")}
            </div>
          )}
          {analysis.flags_unknown.length > 0 && (
            <div>
              <span className="font-semibold text-muted-foreground">Unknown: </span>
              {analysis.flags_unknown.join(", ")}
            </div>
          )}
          {analysis.candidate_flags.length > 0 && (
            <div>
              <span className="font-semibold text-amber-300">Candidate flags: </span>
              {analysis.candidate_flags.join(", ")}
            </div>
          )}
          {analysis.analysis_prose ? (
            <div className="whitespace-pre-wrap rounded border border-border bg-background/60 p-2 font-sans text-xs leading-relaxed">
              {analysis.analysis_prose}
            </div>
          ) : (
            <div className="text-muted-foreground">No prose stored for this analysis.</div>
          )}
        </div>
      </td>
    </tr>
  );
}

type CrushContext = {
  outlier_analyses: Array<{
    quarter: string;
    date: string;
    cause: string;
    similar_today: boolean;
    similarity_explanation: string;
  }>;
  overall_risk: "high" | "medium" | "low";
  key_metric_to_watch: string;
  current_setup_resembles: "outlier" | "normal";
  verdict: string;
  safe_to_trade: boolean;
  confidence: "high" | "medium" | "low";
};

type CrushHistoryEvent = {
  earningsDate: string;
  qtrLabel: string;
  fiscalQuarter: number | null;
  fiscalYear: number | null;
  periodEnd: string | null;
  fiscalKnown: boolean;
  impliedMovePct: number | null;
  actualMovePct: number | null;
  ratio: number | null;
  grade: "A" | "B" | "C" | "D" | "F" | null;
  impliedMoveSource: string | null;
};

const SIMILAR_EM_TOLERANCE = 0.02; // ±2pp from today's EM

// Calendar-quarter SLOT bucketing (report-date, ~1-month-lag heuristic)
// used only to decide which of the 8 padded row slots an event belongs
// in — a separate concern from the DISPLAYED label, which comes from
// lib/quarter-label.ts's fiscal-aware quarterLabel (imported above as
// computeQuarterLabel). quarterYearLabel(quarterOfDate(dateIso)) is
// byte-identical to the old local quarterLabel(dateIso) this replaced,
// so slot matching is unchanged.
// working backward from today regardless of whether any event exists
// for them yet. {q,y} arithmetic, not string parsing, so "one quarter
// back" is exact at year boundaries (Q1 -> prior year's Q4).
type QuarterYear = { q: 1 | 2 | 3 | 4; y: number };

function quarterOfDate(dateIso: string): QuarterYear {
  const [y, m] = dateIso.split("-").map(Number);
  if (m <= 3) return { q: 4, y: y - 1 };
  if (m <= 6) return { q: 1, y };
  if (m <= 9) return { q: 2, y };
  return { q: 3, y };
}

function quarterYearLabel(qy: QuarterYear): string {
  return `Q${qy.q} ${qy.y}`;
}

function previousQuarter(qy: QuarterYear): QuarterYear {
  return qy.q === 1 ? { q: 4, y: qy.y - 1 } : { q: ((qy.q - 1) as 1 | 2 | 3), y: qy.y };
}

// A stable, deterministic report-date for a quarter with no real event
// yet — used only as the placeholder row's key (and the date a manual
// entry lands on if the user fills it in before a real fetch ever
// finds the actual date). Mirrors quarterLabel's own date->label
// mapping in reverse (Q1 reports Apr-Jun, Q2 Jul-Sep, Q3 Oct-Dec, Q4
// Jan-Mar of the following year) so quarterLabel(representativeDate(qy))
// always round-trips back to qy — the placeholder always lands in the
// slot it was built for.
function representativeDate(qy: QuarterYear): string {
  const byQuarter: Record<1 | 2 | 3 | 4, { y: number; m: number }> = {
    1: { y: qy.y, m: 5 },
    2: { y: qy.y, m: 8 },
    3: { y: qy.y, m: 11 },
    4: { y: qy.y + 1, m: 2 },
  };
  const { y, m } = byQuarter[qy.q];
  return `${y}-${String(m).padStart(2, "0")}-15`;
}

function todayEasternIso(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

// Badge + note wording for the pinned upcoming-event row.
function upcomingTiming(earningsIso: string, todayIso: string): {
  badge: string;
  note: string;
} {
  if (!earningsIso || earningsIso === todayIso) {
    return { badge: "TODAY", note: "pending · reports today" };
  }
  const days = Math.round(
    (Date.parse(earningsIso + "T00:00:00Z") - Date.parse(todayIso + "T00:00:00Z")) /
      86_400_000,
  );
  if (days === 1) return { badge: "TOMORROW", note: "pending · reports tomorrow" };
  if (days > 1) {
    const label = new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    }).format(new Date(earningsIso + "T00:00:00Z"));
    return { badge: label.toUpperCase(), note: `pending · reports ${label}` };
  }
  // Report already happened but the actual move hasn't landed yet
  // (T1 capture runs the morning after).
  return { badge: "LATEST", note: "pending · awaiting post-earnings price" };
}

// Em-dash on missing data — communicates "not available" rather than
// "?" which previously looked like a parse failure. Per-cell tooltips
// in the table explain the specific reason (no implied-move data, etc.).
function fmtPct(n: number | null, digits = 1): string {
  if (n === null || !Number.isFinite(n)) return "—";
  return `${(Math.abs(n) * 100).toFixed(digits)}%`;
}

// Signed version for the Actual column. Direction is encoded in the
// sign of actualMovePct (positive = up, negative = down). Returns
// "+14.8%" / "-11.6%" / "0.0%" / "—".
function fmtSignedPct(n: number | null, digits = 1): string {
  if (n === null || !Number.isFinite(n)) return "—";
  const pct = n * 100;
  if (pct > 0) return `+${pct.toFixed(digits)}%`;
  if (pct < 0) return `${pct.toFixed(digits)}%`; // already has the minus
  return `${pct.toFixed(digits)}%`;
}

// Tailwind color class keyed on the sign of actualMovePct.
function signedPctCls(n: number | null): string {
  if (n === null || !Number.isFinite(n) || n === 0) return "";
  return n > 0 ? "text-emerald-300" : "text-rose-300";
}

function fmtRatio(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  return n.toFixed(2);
}

// Short, unambiguous date next to the calendar-quarter label — for
// matching a ThinkorSwim row (which shows the real earnings date, not
// a calendar quarter) without needing to know the company's fiscal
// year offset. "Apr 27 '26", not the ISO string — ToS-recognizable at
// a glance.
function fmtEarningsDateShort(dateIso: string): string {
  const [y, m, d] = dateIso.split("-").map(Number);
  if (!y || !m || !d) return "";
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${MONTHS[m - 1]} ${d} '${String(y).slice(2)}`;
}

// EM values come from sources of very different reliability -- schwab/
// schwab_t0 are the real straddle formula, manual is hand-entered,
// perplexity is an LLM recalling a number (confirmed wrong at least
// once: GLW Q2 2025 read 11.8% against a true ~6%), and polygon has no
// reproducible code path anywhere in this repo. Surfacing the source
// inline is what lets a wrong perplexity/polygon value be told apart
// from a trustworthy schwab one at a glance instead of looking
// identical. "?" for a populated EM with no recorded source (doesn't
// happen in current data, but an unknown-provenance number is exactly
// the kind you'd want to notice, not silently omit).
function emSourceTag(source: string | null): string {
  if (source === "schwab") return "schwab";
  if (source === "schwab_t0") return "schwab_t0";
  if (source === "perplexity") return "perp";
  if (source === "polygon") return "polygon";
  if (source === "manual") return "manual";
  return "?";
}

function gradeBadgeCls(g: CrushHistoryEvent["grade"]): string {
  if (g === "A") return "bg-emerald-500/15 text-emerald-300";
  if (g === "B") return "bg-teal-500/15 text-teal-300";
  if (g === "C") return "bg-amber-500/15 text-amber-300";
  if (g === "D") return "bg-orange-500/15 text-orange-300";
  if (g === "F") return "bg-rose-500/15 text-rose-300";
  return "bg-zinc-500/10 text-muted-foreground";
}

// Click-to-edit EM/Actual cell. Percent in, percent out (e.g. typing
// "4.5" means 4.5%) — the caller converts to/from the fraction the API
// and the rest of this table use. Ratio/Grade are never editable here;
// they're recomputed server-side from whatever EM/Actual land after a
// save (see saveField below), so there's no path to an independently-
// wrong Ratio.
function EditableMoveCell({
  value,
  onSave,
  formatDisplay,
  colorCls,
  nullTooltip,
  allowNegative,
  editHint,
  warnAbovePct,
  trailingTag,
}: {
  value: number | null; // fraction
  onSave: (percentValue: number | null) => Promise<void>;
  formatDisplay: (v: number | null) => string;
  colorCls?: string;
  nullTooltip?: string;
  allowNegative?: boolean;
  // Shown (forced open, not hover-only — the input is only on screen
  // for a few seconds) the moment the cell enters edit mode. Guidance
  // only, no bearing on what gets saved.
  editHint?: string;
  // Soft sanity check, in percent (e.g. 40 for "warn above 40%"), not
  // a fraction — matches the units `commit` already works in below.
  // Warn-and-confirm only: never blocks a save, some names genuinely
  // have huge earnings moves.
  warnAbovePct?: number;
  // Rendered inside the trigger button, right after the formatted
  // value, same line — e.g. a small muted source tag. Trigger-only (not
  // shown while editing); caller decides when to pass one (e.g. omit
  // for a null value).
  trailingTag?: ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState("");
  const [saving, setSaving] = useState(false);

  async function commit() {
    const trimmed = val.trim();
    if (trimmed === "") {
      setSaving(true);
      await onSave(null);
      setSaving(false);
      setEditing(false);
      return;
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) {
      setEditing(false);
      return;
    }
    const finalPct = allowNegative ? parsed : Math.abs(parsed);
    if (warnAbovePct !== undefined && Math.abs(finalPct) >= warnAbovePct) {
      const proceed = window.confirm(
        `${Math.abs(finalPct).toFixed(1)}% is unusually large for an earnings move — this looks like it could be the Implied Volatility % rather than the ATM Straddle %. Save it anyway?`,
      );
      if (!proceed) return; // stays in edit mode with the typed value so it can be fixed or re-confirmed
    }
    setSaving(true);
    await onSave(finalPct);
    setSaving(false);
    setEditing(false);
  }

  if (editing) {
    const input = (
      <input
        autoFocus
        type="number"
        step="0.1"
        value={val}
        disabled={saving}
        onChange={(e) => setVal(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            commit();
          } else if (e.key === "Escape") {
            setEditing(false);
          }
        }}
        onBlur={commit}
        className="w-16 rounded border border-border bg-background px-1 py-0.5 text-right font-mono text-[11px] outline-none focus:border-primary"
      />
    );
    if (editHint) {
      return (
        <TooltipProvider delayDuration={0}>
          <Tooltip open>
            <TooltipTrigger asChild>{input}</TooltipTrigger>
            <TooltipContent className="max-w-xs text-sm">{editHint}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      );
    }
    return input;
  }

  const trigger = (
    <button
      type="button"
      onClick={() => {
        setVal(value === null ? "" : (value * 100).toFixed(2));
        setEditing(true);
      }}
      title="Click to edit"
      className={`inline-flex w-full cursor-text items-center justify-end gap-1 font-mono decoration-dotted hover:underline ${colorCls ?? ""}`}
    >
      {formatDisplay(value)}
      {trailingTag}
    </button>
  );

  if (value === null && nullTooltip) {
    return (
      <TooltipProvider delayDuration={200}>
        <Tooltip>
          <TooltipTrigger asChild>{trigger}</TooltipTrigger>
          <TooltipContent className="max-w-xs text-sm">{nullTooltip}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }
  return trigger;
}

export function CrushHistoryTable({
  events,
  todayEmPct,
  todaySymbol,
  todayEarningsDate,
}: {
  events: CrushHistoryEvent[] | undefined | null;
  todayEmPct: number | null;
  todaySymbol: string;
  todayEarningsDate: string;
}) {
  const [refreshed, setRefreshed] = useState<CrushHistoryEvent[] | null>(null);
  const [fetchStatus, setFetchStatus] = useState<"idle" | "fetching" | "done" | "error">("idle");
  // Two-count tracking: actual moves come from the seed step (Finnhub /
  // Yahoo backfill). Implied moves are live-only (stamped by screener
  // runs from the Schwab chain) — the historical backfill source was
  // discontinued, so coverage is surfaced rather than fetched.
  const [actualPopulated, setActualPopulated] = useState(0);
  const [eventsWithEm, setEventsWithEm] = useState(0);
  const [eventsWithActual, setEventsWithActual] = useState(0);
  const [fetchError, setFetchError] = useState<string | null>(null);
  // Per-row save errors for the inline EM/Actual editor, keyed by
  // earningsDate — independent of fetchError so a failed manual edit
  // doesn't get lost/overwritten by the next Fetch EM History run.
  const [editErrors, setEditErrors] = useState<Record<string, string>>({});

  // Placeholder rows have no real earnings_date yet — saving EM/Actual
  // against one first needs the real date. Previously resolved via
  // window.prompt() + a strict YYYY-MM-DD regex: any other format (a
  // very natural thing to type — "5/15/26", "May 15 2026") silently
  // discarded the whole edit with no inline feedback, which is what
  // "typed input does not register" actually was (2026-08-12 audit) —
  // not an uncontrolled input, a native dialog with no forgiving format
  // handling and no visible retry state. A controlled <input type="date">
  // in a real dialog can't produce a malformed value at all.
  const [pendingResolve, setPendingResolve] = useState<{
    event: CrushHistoryEvent;
    field: "em" | "actual";
    rawPercent: number | null;
    dateInput: string;
    error: string | null;
    saving: boolean;
  } | null>(null);

  // Advisory-only research analyses for this symbol, keyed by
  // earnings_date. null = not yet loaded; {} = loaded, none exist.
  const [researchAnalyses, setResearchAnalyses] = useState<Record<string, ResearchAnalysisRow> | null>(null);
  const [expandedAnalysisDate, setExpandedAnalysisDate] = useState<string | null>(null);

  // On mount: read the latest events for this symbol from the DB so
  // a re-expand never shows stale stageThree.details.crushHistory
  // baked into the screener_results cache (which can be hours old).
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch(
          `/api/screener/crush-history?symbol=${encodeURIComponent(todaySymbol)}`,
          { cache: "no-store" },
        );
        if (!res.ok) return;
        const json = (await res.json()) as { events?: CrushHistoryEvent[] };
        if (!cancelled && Array.isArray(json.events)) {
          setRefreshed(json.events);
        }
      } catch {
        /* fall back to props.events */
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [todaySymbol]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch(
          `/api/screener/research-analysis?symbol=${encodeURIComponent(todaySymbol)}`,
          { cache: "no-store" },
        );
        if (!res.ok) return;
        const json = (await res.json()) as { analyses?: ResearchAnalysisRow[] };
        if (!cancelled && Array.isArray(json.analyses)) {
          const byDate: Record<string, ResearchAnalysisRow> = {};
          for (const a of json.analyses) byDate[a.earnings_date] = a;
          setResearchAnalyses(byDate);
        }
      } catch {
        /* indicator just won't show — non-critical */
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [todaySymbol]);

  const liveEvents = refreshed ?? events ?? [];

  // The upcoming event now exists in earnings_history too (seeded by the
  // screener / T0 capture with a live EM), so it must NOT render as a
  // second history row alongside the pinned row — match it by the
  // screener's earnings date (fallback: any not-yet-past event) and merge
  // it into the pinned row instead.
  const todayIso = todayEasternIso();
  const upcoming =
    liveEvents.find((e) => e.earningsDate === todayEarningsDate) ??
    liveEvents.find((e) => e.earningsDate >= todayIso) ??
    null;

  // Sort newest first; the merged upcoming row is pinned above these.
  const sorted = liveEvents
    .filter((e) => e !== upcoming && e.earningsDate < todayIso)
    .sort((a, b) => b.earningsDate.localeCompare(a.earningsDate));

  const pinnedDate = todayEarningsDate || upcoming?.earningsDate || todayIso;
  // Analyses are written the day of the print — the pinned row (today's
  // event, excluded from displayRows below) is the primary place one
  // needs to show, not a secondary case.
  const pinnedAnalysis = researchAnalyses?.[pinnedDate] ?? null;
  const isPinnedAnalysisExpanded = expandedAnalysisDate === pinnedDate;
  const pinnedFiscalKnown = upcoming?.fiscalKnown ?? false;
  const pinnedQtr =
    upcoming?.qtrLabel ??
    computeQuarterLabel({
      earningsDate: pinnedDate,
      fiscalQuarter: null,
      fiscalYear: null,
      periodEnd: null,
    }).combined;
  // (year, quarter) struct, not the label string — the pinned row's own
  // quarter needs to be excluded from the generated slots below by
  // identity, not by re-deriving and string-comparing a label that
  // could (in principle) drift from quarterYearLabel's formatting.
  const pinnedQY = quarterOfDate(pinnedDate);

  // Always render 8 quarter slots working backward from today's
  // calendar quarter, whether or not a fetched event exists for each
  // one — a missing quarter still needs a row to receive a manual
  // entry, or there's nowhere to type it. The newest quarter is the
  // one case that can exist on BOTH sides at once: as the pinned row
  // above (merged from `upcoming`/todayEarningsDate) AND as a slot this
  // loop would otherwise generate, because `sorted` — the only source
  // this loop used to check — has already had the pinned quarter's
  // event filtered OUT of it (see the `sorted` filter above). Checking
  // only `sorted` for "does this quarter already have a row" can never
  // see the pinned quarter, so it always looked empty and always
  // duplicated. Skipping any slot whose (year, quarter) matches the
  // pinned quarter's is what actually closes that gap — matching by
  // struct identity, not by date (the pinned row's real date and this
  // loop's synthetic placeholder date are never equal) and not by
  // whether the slot happens to have data (an empty pinned quarter must
  // still be skipped, not just a filled one).
  const HISTORY_QUARTER_COUNT = 8;
  const byQuarter = new Map<string, CrushHistoryEvent>();
  for (const e of sorted) {
    const label = quarterYearLabel(quarterOfDate(e.earningsDate));
    if (!byQuarter.has(label)) byQuarter.set(label, e);
  }
  const displayRows: CrushHistoryEvent[] = [];
  // Dates from representativeDate() are synthetic — no real
  // earnings_history row exists for that quarter yet. Tracked
  // explicitly (not inferred from the date shape, e.g. "day === 15")
  // so a manual edit against one of these rows can be caught and
  // redirected before it writes a fake date as if it were real — see
  // saveField below. This is the fix for the exact bug that produced
  // 23 wrong-dated rows (22 with real EM data on a fabricated date, 1
  // fully empty) across BA/CDNS/ELF/GLW/SOFI/SPGI/TER/TSEM, repaired
  // 2026-08-06.
  const placeholderDates = new Set<string>();
  {
    let cursor = quarterOfDate(todayIso);
    for (let i = 0; i < HISTORY_QUARTER_COUNT; i += 1) {
      if (cursor.q !== pinnedQY.q || cursor.y !== pinnedQY.y) {
        const label = quarterYearLabel(cursor);
        const real = byQuarter.get(label);
        const repDate = representativeDate(cursor);
        if (!real) placeholderDates.add(repDate);
        displayRows.push(
          real ?? {
            earningsDate: repDate,
            qtrLabel: computeQuarterLabel({
              earningsDate: repDate,
              fiscalQuarter: null,
              fiscalYear: null,
              periodEnd: null,
            }).combined,
            fiscalQuarter: null,
            fiscalYear: null,
            periodEnd: null,
            fiscalKnown: false,
            impliedMovePct: null,
            actualMovePct: null,
            ratio: null,
            grade: null,
            impliedMoveSource: null,
          },
        );
      }
      cursor = previousQuarter(cursor);
    }
  }
  const pinnedEm = todayEmPct ?? upcoming?.impliedMovePct ?? null;
  const pinnedActual = upcoming?.actualMovePct ?? null;
  const pinnedRatio = upcoming?.ratio ?? null;
  const pinnedGrade = upcoming?.grade ?? null;
  const timing = upcomingTiming(pinnedDate, todayIso);

  async function handleFetchEmHistory() {
    console.log("[fetch-em] starting for:", todaySymbol);
    setFetchStatus("fetching");
    setFetchError(null);
    setActualPopulated(0);
    setEventsWithEm(0);
    setEventsWithActual(0);
    try {
      const res = await fetch("/api/screener/fetch-em-history", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol: todaySymbol }),
        cache: "no-store",
      });
      const json = (await res.json()) as
        | {
            seedAdded: number;
            eventsWithActual: number;
            eventsWithEm: number;
            events: CrushHistoryEvent[];
            messages: string[];
          }
        | { error: string };
      console.log("[fetch-em] response:", { status: res.status, json });
      if (!res.ok || !("events" in json)) {
        const msg = "error" in json ? json.error : `HTTP ${res.status}`;
        console.error("[fetch-em] error:", msg);
        setFetchStatus("error");
        setFetchError(`Failed to fetch history — ${msg}`);
        return;
      }
      setActualPopulated(json.seedAdded);
      setEventsWithActual(json.eventsWithActual);
      setEventsWithEm(json.eventsWithEm);
      setRefreshed(json.events);
      setFetchStatus("done");
    } catch (e) {
      console.error("[fetch-em] error:", e);
      setFetchStatus("error");
      setFetchError(
        `Failed to fetch history — ${e instanceof Error ? e.message : "network error"}. Try again.`,
      );
    }
  }

  // Merges a saved/edited row back into whichever array is currently
  // driving the render (refreshed if the on-mount load already landed,
  // otherwise props.events) — normalizes to `refreshed` either way so
  // this is the source of truth for the rest of the row's lifetime.
  function applyEditedEvent(updated: CrushHistoryEvent) {
    setRefreshed((prev) => {
      const base = prev ?? events ?? [];
      const exists = base.some((e) => e.earningsDate === updated.earningsDate);
      return exists
        ? base.map((e) => (e.earningsDate === updated.earningsDate ? updated : e))
        : [...base, updated];
    });
  }

  // Shared save path for both placeholder and real rows — sends BOTH
  // current EM/Actual values (the API always recomputes Ratio/Grade
  // from the pair), targeting whichever earningsDate the caller
  // resolves (the row's own date for a real row, or the just-picked
  // date for a placeholder). Errors are keyed by the row's ORIGINAL
  // earningsDate (placeholder or real) so a failure surfaces on the
  // row the user was actually editing, not the new date it would have
  // moved to.
  // Returns null on success, or the error message on failure — the
  // caller needs the message synchronously (e.g. to show it inline in
  // the date-resolve dialog), and reading it back out of editErrors
  // state right after the setEditErrors call above would see the
  // pre-update value, since state updates don't apply until the next
  // render.
  async function commitSave(
    targetEarningsDate: string,
    sourceEvent: CrushHistoryEvent,
    field: "em" | "actual",
    rawPercent: number | null,
  ): Promise<string | null> {
    const impliedMovePct =
      field === "em" ? (rawPercent === null ? null : rawPercent / 100) : sourceEvent.impliedMovePct;
    const actualMovePct =
      field === "actual" ? (rawPercent === null ? null : rawPercent / 100) : sourceEvent.actualMovePct;
    try {
      const res = await fetch("/api/screener/earnings-history/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol: todaySymbol,
          earningsDate: targetEarningsDate,
          impliedMovePct,
          actualMovePct,
        }),
        cache: "no-store",
      });
      const json = (await res.json()) as { event: CrushHistoryEvent } | { error: string };
      if (!res.ok || !("event" in json)) {
        const msg = "error" in json ? json.error : `HTTP ${res.status}`;
        setEditErrors((prev) => ({ ...prev, [sourceEvent.earningsDate]: msg }));
        return msg;
      }
      setEditErrors((prev) => {
        if (!(sourceEvent.earningsDate in prev)) return prev;
        const next = { ...prev };
        delete next[sourceEvent.earningsDate];
        return next;
      });
      applyEditedEvent(json.event);
      return null;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "network error";
      setEditErrors((prev) => ({ ...prev, [sourceEvent.earningsDate]: msg }));
      return msg;
    }
  }

  // A manual edit on a placeholder row must never write
  // representativeDate()'s synthetic date as if it were real — that's
  // exactly the bug that produced 23 wrong-dated rows (repaired
  // 2026-08-06). Resolving the real date here (rather than blocking the
  // edit outright) keeps the routine ThinkorSwim EM backfill workflow
  // intact: the user is already looking at the real print date on ToS
  // when they do this, so asking costs one extra step, not a blocked
  // workflow. Opens the dialog and returns immediately — commitSave
  // runs once the user confirms a date, not from here. Previously this
  // resolved via window.prompt() + a strict YYYY-MM-DD regex: typing
  // any other format (very natural — "5/15/26", "May 15 2026") silently
  // discarded the whole edit with no inline retry, which is what
  // "typed input does not register" actually was (2026-08-12 audit) —
  // not an uncontrolled input, a native dialog with no forgiving format
  // handling. A controlled <input type="date"> can't produce a
  // malformed value at all.
  async function saveField(
    e: CrushHistoryEvent,
    field: "em" | "actual",
    rawPercent: number | null,
  ): Promise<void> {
    if (placeholderDates.has(e.earningsDate)) {
      // Opens the dialog and returns immediately, without awaiting a
      // save — commitSave only runs once the user confirms a date.
      setPendingResolve({ event: e, field, rawPercent, dateInput: "", error: null, saving: false });
      return;
    }
    await commitSave(e.earningsDate, e, field, rawPercent);
  }

  async function confirmPendingResolve() {
    if (!pendingResolve) return;
    if (!pendingResolve.dateInput) {
      setPendingResolve((prev) => (prev ? { ...prev, error: "Pick a date first." } : prev));
      return;
    }
    setPendingResolve((prev) => (prev ? { ...prev, saving: true, error: null } : prev));
    const { event, field, rawPercent, dateInput } = pendingResolve;
    const errorMsg = await commitSave(dateInput, event, field, rawPercent);
    if (errorMsg === null) {
      setPendingResolve(null);
    } else {
      setPendingResolve((prev) => (prev ? { ...prev, saving: false, error: errorMsg } : prev));
    }
  }

  function cancelPendingResolve() {
    setPendingResolve(null);
  }

  const similar: CrushHistoryEvent[] = [];
  if (todayEmPct !== null) {
    for (const e of sorted) {
      if (e.impliedMovePct === null) continue;
      if (Math.abs(e.impliedMovePct - todayEmPct) <= SIMILAR_EM_TOLERANCE) {
        similar.push(e);
      }
    }
  }
  // Trigger Trade Decision Context on F or D similar-EM quarters per
  // spec — "at least one is grade F or D".
  const outliers = similar.filter((e) => e.grade === "F" || e.grade === "D");

  const gradeCounts = (() => {
    const out: Record<string, number> = { A: 0, B: 0, C: 0, D: 0, F: 0 };
    for (const e of similar) {
      if (e.grade) out[e.grade] = (out[e.grade] ?? 0) + 1;
    }
    return out;
  })();
  const summaryGrades = (() => {
    const buckets: string[] = [];
    if (gradeCounts.A + gradeCounts.B > 0) {
      buckets.push(`${gradeCounts.A + gradeCounts.B}× A/B`);
    }
    if (gradeCounts.C > 0) buckets.push(`${gradeCounts.C}× C`);
    if (gradeCounts.D > 0) buckets.push(`${gradeCounts.D}× D`);
    if (gradeCounts.F > 0) buckets.push(`${gradeCounts.F}× F ⚠️`);
    return buckets.join(", ");
  })();
  const mostRecentSimilar = similar[0] ?? null;

  return (
    <div className="rounded-md border border-border bg-background/40 p-3 text-sm">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Earnings history
        </div>
        {fetchStatus !== "done" && (
          <button
            type="button"
            onClick={handleFetchEmHistory}
            disabled={fetchStatus === "fetching"}
            className="inline-flex items-center gap-1 rounded border border-border bg-background/60 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-foreground/90 hover:bg-background disabled:opacity-60"
          >
            {fetchStatus === "fetching" ? (
              <>
                <Loader2 className="h-3 w-3 animate-spin" />
                Fetching…
              </>
            ) : fetchStatus === "error" ? (
              <>↻ Retry</>
            ) : (
              <>
                📊 Fetch EM history
                {sorted.length > 0 ? ` (${sorted.length})` : ""}
              </>
            )}
          </button>
        )}
        {fetchStatus === "done" && (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] font-semibold uppercase tracking-wide">
            <span className="text-emerald-300">
              {actualPopulated > 0
                ? `✓ ${actualPopulated} actual ${actualPopulated === 1 ? "move" : "moves"} populated`
                : "✓ history up to date"}
            </span>
            {eventsWithActual > 0 && (
              eventsWithEm < eventsWithActual ? (
                <span className="text-amber-300">
                  · ⚠️ {eventsWithEm}/{eventsWithActual} implied moves (historical backfill discontinued)
                </span>
              ) : (
                <span className="text-emerald-300">
                  · ✓ {eventsWithEm}/{eventsWithActual} implied moves
                </span>
              )
            )}
          </div>
        )}
      </div>
      {fetchStatus === "error" && fetchError && (
        <div className="mb-2 flex items-start gap-1 rounded border border-rose-500/40 bg-rose-500/10 p-1.5 text-[10px] text-rose-200">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
          <span>{fetchError}</span>
        </div>
      )}
      <div className="overflow-x-auto rounded border border-border">
        <table className="min-w-full text-[11px]">
          <thead className="bg-background/60">
            <tr>
              <th className="px-2 py-1 text-left font-medium text-muted-foreground">
                Qtr
              </th>
              <th className="px-2 py-1 text-right font-medium text-muted-foreground">
                EM
              </th>
              <th className="px-2 py-1 text-right font-medium text-muted-foreground">
                Actual
              </th>
              <th className="px-2 py-1 text-right font-medium text-muted-foreground">
                Ratio
              </th>
              <th className="px-2 py-1 text-center font-medium text-muted-foreground">
                Grade
              </th>
              <th className="px-2 py-1 text-left font-medium text-muted-foreground">
                Note
              </th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-t border-border bg-amber-500/[0.04]">
              <td className="px-2 py-1 font-mono font-semibold">
                {pinnedFiscalKnown ? (
                  pinnedQtr
                ) : (
                  <TooltipProvider delayDuration={200}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="cursor-help italic text-foreground/70">{pinnedQtr}</span>
                      </TooltipTrigger>
                      <TooltipContent className="max-w-xs text-sm">
                        Fiscal quarter not yet known for this event — showing calendar quarter only.
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                )}
                <span className="ml-1.5 font-normal text-muted-foreground">
                  {fmtEarningsDateShort(pinnedDate)}
                </span>
                <span className="ml-1.5 rounded bg-amber-500/15 px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-amber-200">
                  {timing.badge}
                </span>
                {pinnedAnalysis && (
                  <TooltipProvider delayDuration={200}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          onClick={() => setExpandedAnalysisDate(isPinnedAnalysisExpanded ? null : pinnedDate)}
                          className="ml-1.5 inline-flex cursor-pointer items-center gap-0.5 rounded bg-violet-500/15 px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-violet-300 hover:bg-violet-500/25"
                        >
                          {isPinnedAnalysisExpanded ? (
                            <ChevronDown className="h-2.5 w-2.5" />
                          ) : (
                            <ChevronRight className="h-2.5 w-2.5" />
                          )}
                          research
                        </button>
                      </TooltipTrigger>
                      <TooltipContent className="max-w-xs text-sm">
                        Advisory-only research analysis exists for this quarter — click to expand. Never feeds the
                        numeric grade.
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                )}
              </td>
              <td className="px-2 py-1 text-right font-mono text-amber-200">
                {fmtPct(pinnedEm)}
              </td>
              <td
                className={`px-2 py-1 text-right font-mono ${pinnedActual === null ? "text-muted-foreground" : signedPctCls(pinnedActual)}`}
              >
                {pinnedActual === null ? "???" : fmtSignedPct(pinnedActual)}
              </td>
              <td className="px-2 py-1 text-right font-mono text-muted-foreground">
                {pinnedRatio === null ? "???" : fmtRatio(pinnedRatio)}
              </td>
              <td className="px-2 py-1 text-center text-muted-foreground">
                {pinnedGrade === null ? (
                  "???"
                ) : (
                  <span
                    className={`inline-flex items-center gap-0.5 rounded px-1 py-0.5 font-mono font-semibold ${gradeBadgeCls(pinnedGrade)}`}
                  >
                    {pinnedGrade}
                  </span>
                )}
              </td>
              <td className="px-2 py-1 text-[10px] text-muted-foreground">
                {pinnedActual === null ? timing.note : "just reported"}
              </td>
            </tr>
            {isPinnedAnalysisExpanded && pinnedAnalysis && (
              <ResearchAnalysisDetailRow rowKey={pinnedDate} analysis={pinnedAnalysis} />
            )}
            {displayRows.map((e) => {
              const isSimilar =
                todayEmPct !== null &&
                e.impliedMovePct !== null &&
                Math.abs(e.impliedMovePct - todayEmPct) <= SIMILAR_EM_TOLERANCE;
              const isF = e.grade === "F";
              const isManual = e.impliedMoveSource === "manual";
              const isPlaceholder = placeholderDates.has(e.earningsDate);
              const rowError = editErrors[e.earningsDate];
              const analysis = researchAnalyses?.[e.earningsDate] ?? null;
              const isExpanded = expandedAnalysisDate === e.earningsDate;
              return (
                <Fragment key={e.earningsDate}>
                <tr
                  className={`border-t border-border ${isSimilar ? "bg-emerald-500/[0.04]" : ""}`}
                >
                  <td className="px-2 py-1 font-mono">
                    {e.fiscalKnown ? (
                      e.qtrLabel
                    ) : (
                      <TooltipProvider delayDuration={200}>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="cursor-help italic text-foreground/70">{e.qtrLabel}</span>
                          </TooltipTrigger>
                          <TooltipContent className="max-w-xs text-sm">
                            Fiscal quarter not yet known for this event — showing calendar quarter only.
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    )}
                    {isPlaceholder ? (
                      <TooltipProvider delayDuration={200}>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="ml-1.5 cursor-help italic text-muted-foreground/60">
                              {fmtEarningsDateShort(e.earningsDate)}?
                            </span>
                          </TooltipTrigger>
                          <TooltipContent className="max-w-xs text-sm">
                            No confirmed earnings date for this quarter yet — this is a placeholder, not a real
                            announcement date. Editing EM/Actual will prompt for the real date first.
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    ) : (
                      <span className="ml-1.5 text-muted-foreground">
                        {fmtEarningsDateShort(e.earningsDate)}
                      </span>
                    )}
                    {isManual && (
                      <TooltipProvider delayDuration={200}>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="ml-1.5 cursor-help rounded bg-sky-500/15 px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-sky-300">
                              manual
                            </span>
                          </TooltipTrigger>
                          <TooltipContent className="max-w-xs text-sm">
                            Hand-entered — Fetch EM History will never overwrite this row. Click EM/Actual to re-edit.
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    )}
                    {analysis && (
                      <TooltipProvider delayDuration={200}>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              onClick={() => setExpandedAnalysisDate(isExpanded ? null : e.earningsDate)}
                              className="ml-1.5 inline-flex cursor-pointer items-center gap-0.5 rounded bg-violet-500/15 px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-violet-300 hover:bg-violet-500/25"
                            >
                              {isExpanded ? (
                                <ChevronDown className="h-2.5 w-2.5" />
                              ) : (
                                <ChevronRight className="h-2.5 w-2.5" />
                              )}
                              research
                            </button>
                          </TooltipTrigger>
                          <TooltipContent className="max-w-xs text-sm">
                            Advisory-only research analysis exists for this quarter — click to expand. Never feeds the
                            numeric grade.
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    )}
                  </td>
                  <td className="px-2 py-1 text-right font-mono">
                    <EditableMoveCell
                      value={e.impliedMovePct}
                      formatDisplay={fmtPct}
                      nullTooltip="Implied move not available for this quarter — no historical options-data source (backfill discontinued). Click to enter it by hand."
                      editHint="Enter the ATM Straddle % from ThinkorSwim's earnings view (not the Implied Volatility % shown above it)."
                      warnAbovePct={40}
                      trailingTag={
                        e.impliedMovePct !== null ? (
                          <span className="font-sans text-[9px] text-muted-foreground">
                            ({emSourceTag(e.impliedMoveSource)})
                          </span>
                        ) : undefined
                      }
                      onSave={(pct) => saveField(e, "em", pct)}
                    />
                  </td>
                  <td
                    className={`px-2 py-1 text-right font-mono ${signedPctCls(e.actualMovePct)}`}
                  >
                    <EditableMoveCell
                      value={e.actualMovePct}
                      formatDisplay={fmtSignedPct}
                      allowNegative
                      onSave={(pct) => saveField(e, "actual", pct)}
                    />
                  </td>
                  <td className="px-2 py-1 text-right font-mono">
                    {e.ratio === null && e.actualMovePct !== null && e.impliedMovePct === null ? (
                      <TooltipProvider delayDuration={200}>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="cursor-help text-right text-muted-foreground">—</span>
                          </TooltipTrigger>
                          <TooltipContent className="max-w-xs text-sm">
                            Ratio needs both actual and implied move. Implied move not available for this quarter.
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    ) : (
                      fmtRatio(e.ratio)
                    )}
                  </td>
                  <td className="px-2 py-1 text-center">
                    {e.grade === null && e.actualMovePct !== null && e.impliedMovePct === null ? (
                      <TooltipProvider delayDuration={200}>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span
                              className={`inline-flex cursor-help items-center gap-0.5 rounded px-1 py-0.5 font-mono font-semibold ${gradeBadgeCls(null)}`}
                            >
                              —
                            </span>
                          </TooltipTrigger>
                          <TooltipContent className="max-w-xs text-sm">
                            Grade requires the implied/actual ratio. Implied move not available for this quarter.
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    ) : (
                      <span
                        className={`inline-flex items-center gap-0.5 rounded px-1 py-0.5 font-mono font-semibold ${gradeBadgeCls(e.grade)}`}
                      >
                        {e.grade ?? "—"}
                        {isF && <span title="Stock overshot implied move">⚠️</span>}
                      </span>
                    )}
                  </td>
                  <td className="px-2 py-1 text-[10px] text-muted-foreground">
                    {rowError ? (
                      <span className="text-rose-300" title={rowError}>
                        ⚠ save failed
                      </span>
                    ) : (
                      <>
                        {isSimilar && (
                          <span className="text-emerald-300/80">
                            ★ similar EM
                            {e.actualMovePct !== null && (
                              <span
                                className={`ml-1 ${signedPctCls(e.actualMovePct)}`}
                                title={e.actualMovePct >= 0 ? "Moved up" : "Moved down"}
                              >
                                {e.actualMovePct >= 0 ? "▲" : "▼"}
                              </span>
                            )}
                          </span>
                        )}
                        {!isSimilar && e.impliedMovePct === null && (
                          <span>EM not available</span>
                        )}
                      </>
                    )}
                  </td>
                </tr>
                {isExpanded && analysis && <ResearchAnalysisDetailRow rowKey={e.earningsDate} analysis={analysis} />}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Summary line */}
      <div className="mt-2 text-[11px] text-muted-foreground">
        {todayEmPct === null ? (
          <span>No live EM available — similar-EM comparisons disabled.</span>
        ) : similar.length === 0 ? (
          <span>
            No prior quarters within ±2pp of today&apos;s implied move
            ({fmtPct(todayEmPct)}). Run the backfill to fill historical EM.
          </span>
        ) : (
          <span>
            <span className="text-emerald-300">★ similar-EM quarters:</span>{" "}
            {similar.length} found · Results: {summaryGrades || "n/a"}
            {mostRecentSimilar && (
              <>
                {" "}· Most recent: {mostRecentSimilar.qtrLabel} →{" "}
                <span className="font-semibold text-foreground">
                  {mostRecentSimilar.grade ?? "?"}
                </span>
              </>
            )}
          </span>
        )}
      </div>

      {outliers.length > 0 && (
        <TradeDecisionContext
          symbol={todaySymbol}
          earningsDate={todayEarningsDate}
          outliers={outliers}
          todayEmPct={todayEmPct ?? null}
        />
      )}

      <Dialog
        open={pendingResolve !== null}
        onOpenChange={(open) => {
          if (!open) cancelPendingResolve();
        }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Confirm the real earnings date</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            This quarter has no confirmed earnings date yet. Enter the real announcement date from
            ThinkorSwim before saving {pendingResolve?.field === "em" ? "the implied move" : "the actual move"}.
          </p>
          <input
            autoFocus
            type="date"
            value={pendingResolve?.dateInput ?? ""}
            disabled={pendingResolve?.saving}
            onChange={(ev) =>
              setPendingResolve((prev) => (prev ? { ...prev, dateInput: ev.target.value, error: null } : prev))
            }
            onKeyDown={(ev) => {
              if (ev.key === "Enter") void confirmPendingResolve();
            }}
            className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm outline-none focus:border-primary"
          />
          {pendingResolve?.error && (
            <div className="flex items-start gap-1 text-xs text-rose-300">
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
              <span>{pendingResolve.error}</span>
            </div>
          )}
          <DialogFooter>
            <button
              type="button"
              onClick={cancelPendingResolve}
              disabled={pendingResolve?.saving}
              className="rounded border border-border bg-background/60 px-3 py-1.5 text-sm hover:bg-background disabled:opacity-60"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void confirmPendingResolve()}
              disabled={pendingResolve?.saving}
              className="inline-flex items-center gap-1.5 rounded bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
            >
              {pendingResolve?.saving && <Loader2 className="h-3 w-3 animate-spin" />}
              Save
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ---------- Trade Decision Context ----------

// Auto-fetches /api/screener/crush-context on mount whenever the
// caller has at least one F/D similar-EM quarter to explain. Cache
// behaviour lives in the route — first call hits Perplexity, same-day
// re-renders read from screener_crush_context. The UI shows a loading
// spinner during the fetch so the user knows research is in flight.
function TradeDecisionContext({
  symbol,
  earningsDate,
  outliers,
  todayEmPct,
}: {
  symbol: string;
  earningsDate: string;
  outliers: CrushHistoryEvent[];
  todayEmPct: number | null;
}) {
  const [status, setStatus] = useState<"loading" | "loaded" | "error">("loading");
  const [context, setContext] = useState<CrushContext | null>(null);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  // Stable signature of the input list so the effect doesn't re-fire
  // whenever the parent re-renders with the same data.
  const sig = outliers
    .map((o) => `${o.earningsDate}|${o.actualMovePct}|${o.impliedMovePct}|${o.grade}`)
    .join(",");

  useEffect(() => {
    let cancelled = false;
    async function run() {
      setStatus("loading");
      setErrMsg(null);
      // Build the route's expected payload from our local rows. We
      // only forward F/D quarters (the actual outliers) — non-outlier
      // similar quarters are useful in the table but irrelevant here.
      const outlierQuarters = outliers
        .filter(
          (o) =>
            o.actualMovePct !== null &&
            o.impliedMovePct !== null &&
            o.ratio !== null,
        )
        .map((o) => ({
          date: o.earningsDate,
          qtrLabel: o.qtrLabel,
          actualMove: o.actualMovePct as number,
          direction: ((o.actualMovePct as number) >= 0
            ? "up"
            : "down") as "up" | "down",
          ratio: o.ratio as number,
          impliedMove: o.impliedMovePct as number,
        }));
      if (outlierQuarters.length === 0) {
        if (!cancelled) {
          setStatus("error");
          setErrMsg("No outlier quarters with full data — cannot research.");
        }
        return;
      }
      try {
        const res = await fetch("/api/screener/crush-context", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            symbol,
            companyName: "",
            currentEM: todayEmPct ?? 0,
            earningsDate,
            outlierQuarters,
          }),
          cache: "no-store",
        });
        const json = (await res.json()) as
          | { context: CrushContext; cached: boolean }
          | { error: string };
        if (cancelled) return;
        if (!res.ok || !("context" in json)) {
          setStatus("error");
          setErrMsg(
            "error" in json ? json.error : `HTTP ${res.status}`,
          );
          return;
        }
        setContext(json.context);
        setStatus("loaded");
      } catch (e) {
        if (cancelled) return;
        setStatus("error");
        setErrMsg(e instanceof Error ? e.message : "Network error");
      }
    }
    run();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, sig]);

  if (status === "loading") {
    return (
      <div className="mt-2 flex items-center gap-2 rounded border border-border bg-background/40 p-3 text-[11px] text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        <span>
          🔍 <span className="font-semibold uppercase tracking-wide">Trade
            decision context</span> — researching outlier quarters…
        </span>
      </div>
    );
  }

  if (status === "error" || !context) {
    return (
      <div className="mt-2 flex items-start gap-2 rounded border border-rose-500/40 bg-rose-500/10 p-2 text-[11px] text-rose-200">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <div>
          <div className="font-medium">Trade decision context unavailable</div>
          <div className="mt-0.5 text-[10px] text-rose-200/80">
            {errMsg ?? "Could not reach Perplexity."}
          </div>
        </div>
      </div>
    );
  }

  const riskCls =
    context.overall_risk === "low"
      ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-300"
      : context.overall_risk === "medium"
        ? "border-amber-500/40 bg-amber-500/15 text-amber-300"
        : "border-rose-500/40 bg-rose-500/15 text-rose-300";

  return (
    <div className="mt-3 space-y-2 rounded-md border border-border bg-background/30 p-3">
      <div className="flex items-center justify-between">
        <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          🔍 Trade decision context
        </div>
        <span
          className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${riskCls}`}
          title="Overall risk of another outsized move based on current conditions"
        >
          {context.overall_risk} risk
        </span>
      </div>

      <div className="space-y-2">
        {context.outlier_analyses.map((a, i) => {
          const cls = a.similar_today
            ? "border-rose-500/40 bg-rose-500/[0.05]"
            : "border-emerald-500/40 bg-emerald-500/[0.05]";
          return (
            <div key={i} className={`rounded border p-2 text-[11px] ${cls}`}>
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-foreground">
                {a.quarter}
                {a.date ? ` — ${a.date}` : ""}
              </div>
              <div className="mb-1">
                <div className="text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Cause
                </div>
                <div className="text-foreground/90">{a.cause}</div>
              </div>
              <div>
                <div className="text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Similar today?
                </div>
                <div className="flex items-start gap-1 text-foreground/90">
                  {a.similar_today ? (
                    <span className="text-rose-300">⚠️ YES —</span>
                  ) : (
                    <span className="text-emerald-300">✅ NO —</span>
                  )}
                  <span>{a.similarity_explanation}</span>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="rounded border border-border bg-background/40 p-2 text-[11px]">
        <div className="text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
          Key metric to watch
        </div>
        <div className="text-foreground/90 italic">{context.key_metric_to_watch}</div>
      </div>

      <div className="rounded border border-border bg-background/40 p-2 text-[11px]">
        <div className="text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
          Verdict
        </div>
        <div className="text-foreground/90">{context.verdict}</div>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-2 text-[11px]">
        {context.safe_to_trade ? (
          <span className="inline-flex items-center gap-1 rounded border border-emerald-500/40 bg-emerald-500/15 px-1.5 py-0.5 font-semibold text-emerald-300">
            <CheckCircle2 className="h-3 w-3" /> SAFE TO TRADE
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 rounded border border-rose-500/40 bg-rose-500/15 px-1.5 py-0.5 font-semibold text-rose-300">
            <XCircle className="h-3 w-3" /> NOT SAFE TO TRADE
          </span>
        )}
        <span className="text-muted-foreground">
          confidence:{" "}
          <span className="font-mono uppercase text-foreground">
            {context.confidence}
          </span>
        </span>
        <span className="text-muted-foreground">
          setup resembles:{" "}
          <span className="font-mono uppercase text-foreground">
            {context.current_setup_resembles}
          </span>
        </span>
      </div>
    </div>
  );
}

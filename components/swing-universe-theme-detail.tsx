"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Star, StarOff, Trash2, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";

type Theme = {
  id: string;
  name: string;
  description: string | null;
  theme_type: string | null;
  expansion_prompt: string | null;
  // Optional per-theme expansion ceiling -- null = no ceiling (every
  // existing theme, today's unchanged behavior). Applies to future
  // expansion runs only; never retroactively removes existing members.
  market_cap_ceiling: number | null;
  is_active: boolean;
};

type Member = {
  id: string;
  symbol: string;
  is_anchor: boolean;
  source: string;
  added_at: string;
  is_active: boolean;
  notes: string | null;
  review_status: string;
  companyName: string | null;
  price: number | null;
  marketCap: number | null;
  sector: string | null;
  adr20Pct: number | null;
  avgDollarVolume20d: number | null;
};

// Only these theme_types have an expansion prompt (see
// lib/theme-expansion.ts's PROMPT_TEMPLATES) — 'custom' and any
// unrecognized value have no structured relationship to expand from.
const EXPANDABLE_THEME_TYPES = ["supply_chain", "sector_comparable", "policy_driven", "macro_sensitive"];

// Client-chunked so /expand/filter never has to hard-filter more than a
// handful of suggestions per call (each does a live Yahoo profile fetch
// plus a bar backfill per survivor) — same sequential-chunking
// discipline as the RS Pullback enrichment pipeline.
const FILTER_CHUNK_SIZE = 8;

type Rejection = {
  id: string;
  symbol: string;
  reason: string | null;
  rejected_at: string;
  theme_type: string | null;
  is_current_scope: boolean;
};

type Suggestion = { symbol: string; companyName: string; rationale: string };
type FilterVerdict = {
  symbol: string;
  companyName: string;
  rationale: string;
  status: "pending" | "rejected";
  rejectReason: string | null;
  price: number | null;
  marketCap: number | null;
  sector: string | null;
  avgDollarVolume20d: number | null;
  adr20Pct: number | null;
};

function bucketReason(reason: string): string {
  if (reason.includes("already a member")) return "Already a member";
  if (reason.includes("previously rejected")) return "Previously rejected on this theme";
  if (reason.includes("did not resolve")) return "Symbol did not resolve";
  if (reason.includes("not a common stock")) return "Not a common stock (ETF/fund)";
  if (reason.includes("foreign-primary-listing")) return "Foreign-listing heuristic";
  if (reason.includes("price") && reason.includes("floor")) return "Price below $5";
  // Checked before the floor bucket below -- both reasons contain
  // "market cap", distinguished by "ceiling" (only the new, optional
  // per-theme check produces that word; the floor's message never does).
  if (reason.includes("market cap") && reason.includes("ceiling")) return "Market cap above ceiling";
  if (reason.includes("market cap")) return "Market cap below $500M";
  if (reason.includes("$ volume")) return "20d $ volume below $10M";
  return "Other";
}

type SortKey =
  | "symbol"
  | "companyName"
  | "sector"
  | "marketCap"
  | "adr20Pct"
  | "price"
  | "avgDollarVolume20d"
  | "is_anchor"
  | "source"
  | "added_at";

// Columns a threshold select can act on — always numeric (or null), never
// the string columns, so "ADR% < 4.0" is a plain numeric comparison.
type ThresholdColumn = "marketCap" | "price" | "adr20Pct" | "avgDollarVolume20d";
const THRESHOLD_COLUMNS: Array<{ key: ThresholdColumn; label: string }> = [
  { key: "adr20Pct", label: "ADR%" },
  { key: "marketCap", label: "Mkt Cap" },
  { key: "price", label: "Price" },
  { key: "avgDollarVolume20d", label: "20d $ Vol" },
];

const SORT_VALUE: Record<SortKey, { get: (m: Member) => number | string | null; defaultDir: "asc" | "desc" }> = {
  symbol: { get: (m) => m.symbol, defaultDir: "asc" },
  companyName: { get: (m) => m.companyName ?? "", defaultDir: "asc" },
  sector: { get: (m) => m.sector ?? "", defaultDir: "asc" },
  marketCap: { get: (m) => m.marketCap, defaultDir: "desc" },
  adr20Pct: { get: (m) => m.adr20Pct, defaultDir: "desc" },
  price: { get: (m) => m.price, defaultDir: "desc" },
  avgDollarVolume20d: { get: (m) => m.avgDollarVolume20d, defaultDir: "desc" },
  is_anchor: { get: (m) => (m.is_anchor ? 1 : 0), defaultDir: "desc" },
  source: { get: (m) => m.source, defaultDir: "asc" },
  added_at: { get: (m) => m.added_at, defaultDir: "desc" },
};

function compareValues(a: number | string | null, b: number | string | null, dir: "asc" | "desc"): number {
  const mul = dir === "asc" ? 1 : -1;
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  if (typeof a === "string" || typeof b === "string") {
    return mul * String(a).localeCompare(String(b));
  }
  return mul * (a - b);
}

function fmtMoney(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  return `$${n.toFixed(2)}`;
}

function fmtPct(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  return `${n.toFixed(1)}%`;
}

function fmtMarketCap(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  if (n >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(0)}M`;
  return `$${n.toFixed(0)}`;
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function SortTh({
  label,
  sortKey,
  sort,
  onSort,
  align = "left",
}: {
  label: string;
  sortKey: SortKey;
  sort: { key: SortKey; dir: "asc" | "desc" };
  onSort: (k: SortKey) => void;
  align?: "left" | "right" | "center";
}) {
  const isActive = sort.key === sortKey;
  const justify = align === "right" ? "justify-end" : align === "center" ? "justify-center" : "justify-start";
  return (
    <th className={`px-2 py-1.5 text-${align}`}>
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={`flex w-full items-center gap-1 ${justify} ${isActive ? "text-foreground" : "hover:text-foreground"}`}
      >
        {label}
        {isActive && <span className="text-[9px]">{sort.dir === "asc" ? "▲" : "▼"}</span>}
      </button>
    </th>
  );
}

export function SwingUniverseThemeDetail({ themeId }: { themeId: string }) {
  const [theme, setTheme] = useState<Theme | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "is_anchor", dir: "desc" });

  const [addText, setAddText] = useState("");
  const [adding, setAdding] = useState(false);
  const [addResult, setAddResult] = useState<{
    added: string[];
    reactivated: string[];
    promoted: string[];
    alreadyActive: string[];
    invalid: string[];
  } | null>(null);

  // ---- Phase C: expansion ----
  const [promptDraft, setPromptDraft] = useState("");
  const [promptTouched, setPromptTouched] = useState(false);
  // Market cap ceiling editor -- string so an empty input cleanly means
  // "no ceiling" (null) rather than 0. Same touched-flag pattern as
  // promptDraft, so a background reload doesn't clobber an in-progress
  // edit.
  const [ceilingDraft, setCeilingDraft] = useState("");
  const [ceilingTouched, setCeilingTouched] = useState(false);
  const [ceilingSaving, setCeilingSaving] = useState(false);
  const [ceilingError, setCeilingError] = useState<string | null>(null);
  const [expanding, setExpanding] = useState<"suggest" | "filter" | null>(null);
  const [expandProgress, setExpandProgress] = useState<string | null>(null);
  const [expandError, setExpandError] = useState<string | null>(null);
  const [lastRun, setLastRun] = useState<{
    rawCount: number;
    truncated: boolean;
    verdicts: FilterVerdict[];
  } | null>(null);

  // ---- Phase C: pending review ----
  const [selectedPending, setSelectedPending] = useState<Set<string>>(new Set());
  const [reviewBusy, setReviewBusy] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [pendingSort, setPendingSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({
    key: "adr20Pct",
    dir: "desc",
  });
  const [lastClickedPendingIndex, setLastClickedPendingIndex] = useState<number | null>(null);
  // Captured on mousedown over the row's enlarged label (not the input
  // itself — a click landing on the label re-dispatches a synthetic
  // click to the wrapped input, and that forwarded click isn't
  // guaranteed to carry modifier keys). Read once in onChange, then
  // cleared, so shift-click range selection works from anywhere in the
  // hit target, not just the 13px input.
  const pendingShiftRef = useRef(false);
  const [thresholdColumn, setThresholdColumn] = useState<ThresholdColumn>("adr20Pct");
  const [thresholdOp, setThresholdOp] = useState<"lt" | "gt">("lt");
  const [thresholdValue, setThresholdValue] = useState("");

  // ---- Rejection scoping: visible + reversible history ----
  const [rejections, setRejections] = useState<Rejection[]>([]);
  const [undoingId, setUndoingId] = useState<string | null>(null);

  // ---- Section collapse state ----
  const [membersOpen, setMembersOpen] = useState(true);
  const [pendingOpen, setPendingOpen] = useState(true);
  const [rejectedOpen, setRejectedOpen] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/swings/universe/themes/${themeId}`, { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      const t = json.theme as Theme;
      setTheme(t);
      setMembers(json.members as Member[]);
      setRejections((json.rejections as Rejection[]) ?? []);
      if (!promptTouched) setPromptDraft(t.expansion_prompt ?? "");
      if (!ceilingTouched) setCeilingDraft(t.market_cap_ceiling !== null ? String(t.market_cap_ceiling) : "");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [themeId]);

  function onSort(key: SortKey) {
    setSort((cur) => {
      if (cur.key !== key) return { key, dir: SORT_VALUE[key].defaultDir };
      return { key, dir: cur.dir === "asc" ? "desc" : "asc" };
    });
  }

  function onPendingSort(key: SortKey) {
    setPendingSort((cur) => {
      if (cur.key !== key) return { key, dir: SORT_VALUE[key].defaultDir };
      return { key, dir: cur.dir === "asc" ? "desc" : "asc" };
    });
  }

  // The member table only ever shows approved members — a pending
  // Perplexity suggestion isn't a member of the theme yet (see the
  // pending review queue below) and must not be mixed into this list or
  // its count.
  const visible = useMemo(
    () => members.filter((m) => m.review_status === "approved" && (showInactive || m.is_active)),
    [members, showInactive],
  );
  const sorted = useMemo(() => {
    const desc = SORT_VALUE[sort.key];
    return [...visible].sort((a, b) => {
      const primary = compareValues(desc.get(a), desc.get(b), sort.dir);
      if (primary !== 0) return primary;
      return a.symbol.localeCompare(b.symbol);
    });
  }, [visible, sort]);

  const pending = useMemo(() => members.filter((m) => m.review_status === "pending"), [members]);
  const sortedPending = useMemo(() => {
    const desc = SORT_VALUE[pendingSort.key];
    return [...pending].sort((a, b) => {
      const primary = compareValues(desc.get(a), desc.get(b), pendingSort.dir);
      if (primary !== 0) return primary;
      return a.symbol.localeCompare(b.symbol);
    });
  }, [pending, pendingSort]);

  const canExpand = !!theme?.theme_type && EXPANDABLE_THEME_TYPES.includes(theme.theme_type);

  // Rejections whose theme_type/prompt no longer matches the theme's
  // current question — retained (never auto-deleted), just no longer
  // suppressing. This is the notice requirement 4 asks for: it doesn't
  // only fire right after an edit, it stays true for as long as the
  // mismatch exists, however the edit happened (this page's prompt
  // textarea, or the theme_type dropdown on the list page).
  const staleRejections = useMemo(() => rejections.filter((r) => !r.is_current_scope), [rejections]);

  async function runExpansion() {
    if (!theme) return;
    setExpandError(null);
    setLastRun(null);
    setExpanding("suggest");
    setExpandProgress("Asking Perplexity for suggestions…");
    try {
      const suggestRes = await fetch(`/api/swings/universe/themes/${themeId}/expand/suggest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ promptOverride: promptDraft }),
      });
      const suggestJson = await suggestRes.json();
      if (!suggestRes.ok) throw new Error(suggestJson.error ?? `HTTP ${suggestRes.status}`);
      const suggestions = suggestJson.suggestions as Suggestion[];
      const rawCount = suggestJson.rawCount as number;
      const truncated = suggestJson.truncated as boolean;
      setPromptTouched(false);

      if (suggestions.length === 0) {
        setLastRun({ rawCount, truncated, verdicts: [] });
        return;
      }

      setExpanding("filter");
      const verdicts: FilterVerdict[] = [];
      for (let i = 0; i < suggestions.length; i += FILTER_CHUNK_SIZE) {
        const chunk = suggestions.slice(i, i + FILTER_CHUNK_SIZE);
        setExpandProgress(
          `Filtering ${Math.min(i + FILTER_CHUNK_SIZE, suggestions.length)}/${suggestions.length}…`,
        );
        const filterRes = await fetch(`/api/swings/universe/themes/${themeId}/expand/filter`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ suggestions: chunk }),
        });
        const filterJson = await filterRes.json();
        if (!filterRes.ok) throw new Error(filterJson.error ?? `HTTP ${filterRes.status}`);
        verdicts.push(...(filterJson.verdicts as FilterVerdict[]));
      }
      setLastRun({ rawCount, truncated, verdicts });
      await load();
    } catch (e) {
      setExpandError(e instanceof Error ? e.message : "Expansion failed");
    } finally {
      setExpanding(null);
      setExpandProgress(null);
    }
  }

  // Fires from the checkbox's onChange, never onClick+preventDefault (see
  // the checkbox JSX for why: forcing a native checkbox to skip its own
  // toggle and re-drive it from onClick desyncs React's internal DOM
  // tracker from the actual screen state on some clicks — the row LOOKS
  // unchecked while selectedPending already has it, and the next
  // unrelated write can also get skipped, which is what made both plain
  // clicks and threshold-select intermittently leave rows visually
  // unchecked). `checked` here is the browser's own completed toggle,
  // read from e.target.checked — never re-derived by us.
  //
  // Shift-click extends the selection over the range between the last
  // clicked row and this one, in the CURRENT sort order — sortedPending
  // is recomputed on every sort change, so a shift-click range always
  // matches what's on screen right now, not a stale pre-sort order.
  function handlePendingCheckboxChange(id: string, index: number, checked: boolean, shiftKey: boolean) {
    if (shiftKey && lastClickedPendingIndex !== null) {
      const lo = Math.min(index, lastClickedPendingIndex);
      const hi = Math.max(index, lastClickedPendingIndex);
      const rangeIds = sortedPending.slice(lo, hi + 1).map((m) => m.id);
      setSelectedPending((prev) => {
        const next = new Set(prev);
        rangeIds.forEach((rid) => next.add(rid));
        return next;
      });
    } else {
      setSelectedPending((prev) => {
        const next = new Set(prev);
        if (checked) next.add(id);
        else next.delete(id);
        return next;
      });
    }
    setLastClickedPendingIndex(index);
  }

  // Selects every pending row where the chosen numeric column is below
  // (or above) the entered value — replaces the current selection rather
  // than adding to it, so "select where ADR% < 4" always means exactly
  // those rows, not those rows plus whatever was ticked before.
  function selectByThreshold() {
    const val = Number(thresholdValue);
    if (!Number.isFinite(val)) return;
    const getter = SORT_VALUE[thresholdColumn].get;
    const matches = sortedPending.filter((m) => {
      const v = getter(m);
      if (typeof v !== "number") return false;
      return thresholdOp === "lt" ? v < val : v > val;
    });
    setSelectedPending(new Set(matches.map((m) => m.id)));
  }

  async function acceptSelected(ids: string[]) {
    if (ids.length === 0) return;
    setReviewBusy(true);
    setActionError(null);
    try {
      const res = await fetch(`/api/swings/universe/themes/${themeId}/pending/review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "accept", memberIds: ids }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setSelectedPending(new Set());
      await load();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Accept failed");
    } finally {
      setReviewBusy(false);
    }
  }

  async function rejectSelected(ids: string[]) {
    if (ids.length === 0) return;
    setReviewBusy(true);
    setActionError(null);
    try {
      const res = await fetch(`/api/swings/universe/themes/${themeId}/pending/review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "reject",
          items: ids.map((memberId) => ({ memberId, reason: rejectReason.trim() || undefined })),
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setSelectedPending(new Set());
      setRejectReason("");
      await load();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Reject failed");
    } finally {
      setReviewBusy(false);
    }
  }

  async function undoOneRejection(rejection: Rejection) {
    setUndoingId(rejection.id);
    setActionError(null);
    try {
      const res = await fetch(`/api/swings/universe/themes/${themeId}/rejections/${rejection.id}`, {
        method: "DELETE",
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setRejections((prev) => prev.filter((r) => r.id !== rejection.id));
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Undo failed";
      setActionError(`Could not undo rejection of ${rejection.symbol}: ${msg}`);
    } finally {
      setUndoingId(null);
    }
  }

  async function patchMember(member: Member, patch: Partial<Pick<Member, "is_anchor" | "is_active">>) {
    setActionError(null);
    try {
      const res = await fetch(`/api/swings/universe/themes/${themeId}/members/${member.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      setMembers((prev) => prev.map((m) => (m.id === member.id ? { ...m, ...patch } : m)));
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to update";
      setActionError(`Could not update ${member.symbol}: ${msg}`);
    }
  }

  // Parses ceilingDraft ("" -> null/no ceiling) and PATCHes the theme.
  // Future expansion runs only -- this never touches theme_members.
  async function saveCeiling() {
    const trimmed = ceilingDraft.trim();
    let value: number | null;
    if (trimmed === "") {
      value = null;
    } else {
      const n = Number(trimmed);
      if (!Number.isFinite(n) || n <= 0) {
        setCeilingError("Ceiling must be a positive number, or blank for no ceiling");
        return;
      }
      value = n;
    }
    setCeilingSaving(true);
    setCeilingError(null);
    try {
      const res = await fetch(`/api/swings/universe/themes/${themeId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ market_cap_ceiling: value }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setTheme(json.theme as Theme);
      setCeilingTouched(false);
    } catch (e) {
      setCeilingError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setCeilingSaving(false);
    }
  }

  async function addMembers() {
    const symbols = Array.from(
      new Set(
        addText
          .split(/[\s,]+/)
          .map((s) => s.trim().toUpperCase())
          .filter((s) => s.length > 0),
      ),
    );
    if (symbols.length === 0) return;
    setAdding(true);
    setAddResult(null);
    setActionError(null);
    try {
      const res = await fetch(`/api/swings/universe/themes/${themeId}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbols }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setAddResult(json);
      setAddText("");
      await load();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to add symbols";
      setActionError(msg);
    } finally {
      setAdding(false);
    }
  }

  if (loading && !theme) {
    return <div className="text-base text-muted-foreground">Loading theme…</div>;
  }
  if (error) {
    return <div className="rounded border border-rose-500/40 bg-rose-500/10 p-3 text-base text-rose-300">{error}</div>;
  }
  if (!theme) return null;

  return (
    <div className="space-y-4">
      <div>
        <Link
          href="/swings/universe"
          className="mb-2 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3 w-3" /> Universe
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">{theme.name}</h1>
        {theme.description && <p className="text-sm text-muted-foreground">{theme.description}</p>}
        {theme.theme_type && (
          <span className="mt-1 inline-block rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-muted-foreground">
            {theme.theme_type}
          </span>
        )}
      </div>

      {actionError && (
        <div className="flex items-start justify-between gap-3 rounded border border-rose-500/40 bg-rose-500/10 p-3 text-base text-rose-300">
          <span>{actionError}</span>
          <button type="button" onClick={() => setActionError(null)} className="text-sm text-rose-200 hover:text-white">
            Dismiss
          </button>
        </div>
      )}

      {staleRejections.length > 0 && (
        <div className="rounded border border-sky-500/40 bg-sky-500/5 p-3 text-sm text-sky-200">
          <div className="font-semibold">
            {staleRejections.length} rejection{staleRejections.length === 1 ? "" : "s"} no longer apply
          </div>
          <p className="mt-0.5 text-xs text-sky-200/80">
            {theme.theme_type ? `This theme is now "${theme.theme_type}"` : "This theme's type or expansion prompt"}{" "}
            — the rejections below were made answering a different question and no longer suppress these symbols on
            expansion. They&apos;re kept in the Rejected panel below for the record; nothing was deleted or
            re-suggested automatically.
          </p>
          <p className="mt-1 text-xs">
            {Array.from(new Set(staleRejections.map((r) => r.symbol))).join(", ")}
          </p>
        </div>
      )}

      <div className="rounded border border-border bg-background/40 p-3">
        <div className="mb-2 text-sm font-semibold text-foreground">Add symbols</div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            type="text"
            value={addText}
            onChange={(e) => setAddText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") addMembers();
            }}
            placeholder="NVDA, AMD, or paste a list"
            className="flex-1 rounded border border-border bg-background px-2 py-1.5 font-mono text-base uppercase"
          />
          <Button onClick={addMembers} disabled={adding || addText.trim().length === 0}>
            {adding ? "Adding…" : "Add"}
          </Button>
        </div>
        {addResult && (
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
            {addResult.added.length > 0 && (
              <span className="text-emerald-300">Added: {addResult.added.join(", ")}</span>
            )}
            {addResult.reactivated.length > 0 && (
              <span className="text-sky-300">Reactivated: {addResult.reactivated.join(", ")}</span>
            )}
            {addResult.promoted.length > 0 && (
              <span className="text-sky-300">Promoted from pending: {addResult.promoted.join(", ")}</span>
            )}
            {addResult.alreadyActive.length > 0 && (
              <span>Already active: {addResult.alreadyActive.join(", ")}</span>
            )}
            {addResult.invalid.length > 0 && (
              <span className="text-rose-300">Invalid / no data: {addResult.invalid.join(", ")}</span>
            )}
          </div>
        )}
      </div>

      <div className="rounded border border-border bg-background/40 p-3">
        <div className="mb-2 flex items-center justify-between">
          <div className="text-sm font-semibold text-foreground">Perplexity expansion</div>
          {expandProgress && <span className="text-[11px] text-muted-foreground">{expandProgress}</span>}
        </div>

        <div className="mb-3 flex flex-wrap items-end gap-x-4 gap-y-2 border-b border-border/60 pb-3">
          <div>
            <div className="text-[11px] text-muted-foreground">Market cap floor</div>
            <div className="text-sm text-foreground">$500M (fixed)</div>
          </div>
          <div>
            <label className="block text-[11px] text-muted-foreground" htmlFor="ceiling-input">
              Market cap ceiling
            </label>
            <div className="flex items-center gap-1.5">
              <span className="text-sm text-muted-foreground">$</span>
              <input
                id="ceiling-input"
                type="number"
                min="0"
                step="any"
                value={ceilingDraft}
                onChange={(e) => {
                  setCeilingDraft(e.target.value);
                  setCeilingTouched(true);
                }}
                placeholder="No ceiling"
                className="w-32 rounded border border-border bg-background px-2 py-1 text-sm"
              />
              <Button
                onClick={saveCeiling}
                disabled={
                  ceilingSaving ||
                  (!ceilingTouched &&
                    ceilingDraft === (theme.market_cap_ceiling !== null ? String(theme.market_cap_ceiling) : ""))
                }
              >
                {ceilingSaving ? "Saving…" : "Save"}
              </Button>
            </div>
          </div>
          <span className="text-[11px] text-muted-foreground">
            Blank = no ceiling (today&apos;s behavior for every existing theme). Applies to future expansion runs
            only — changing it never removes existing members.
          </span>
        </div>
        {ceilingError && <p className="mb-2 text-xs text-rose-300">{ceilingError}</p>}

        {!canExpand ? (
          <p className="text-xs text-muted-foreground">
            {theme.theme_type === "custom" || !theme.theme_type
              ? "This theme has no structured relationship to expand from — 'custom' themes are maintained by hand. Expansion is disabled."
              : `No expansion prompt is defined for theme_type "${theme.theme_type}". Expansion is disabled.`}
          </p>
        ) : (
          <>
            <textarea
              value={promptDraft}
              onChange={(e) => {
                setPromptDraft(e.target.value);
                setPromptTouched(true);
              }}
              placeholder="Using this theme type's default prompt — edit to refine it for this theme."
              rows={3}
              className="w-full rounded border border-border bg-background px-2 py-1.5 text-xs"
            />
            <div className="mt-2 flex items-center gap-2">
              <Button onClick={runExpansion} disabled={expanding !== null}>
                {expanding ? "Running…" : "Run expansion"}
              </Button>
              <span className="text-[11px] text-muted-foreground">
                Anchors, description, and existing members are sent as context — one manual run, up to {40} suggestions.
              </span>
            </div>
          </>
        )}
        {expandError && <p className="mt-2 text-xs text-rose-300">{expandError}</p>}
        {lastRun && (
          <div className="mt-3 space-y-1 border-t border-border/60 pt-2 text-[11px]">
            <div className="text-muted-foreground">
              Perplexity returned {lastRun.rawCount} suggestion{lastRun.rawCount === 1 ? "" : "s"}
              {lastRun.truncated ? ` (truncated to 40)` : ""}. {lastRun.verdicts.filter((v) => v.status === "pending").length}{" "}
              queued for review.
            </div>
            {Object.entries(
              lastRun.verdicts
                .filter((v) => v.status === "rejected")
                .reduce<Record<string, FilterVerdict[]>>((acc, v) => {
                  const bucket = bucketReason(v.rejectReason ?? "");
                  (acc[bucket] ??= []).push(v);
                  return acc;
                }, {}),
            ).map(([bucket, items]) => (
              <div key={bucket} className="text-muted-foreground">
                <span className="text-rose-300">{bucket}</span> ({items.length}):{" "}
                {items.map((it) => it.symbol).join(", ")}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Members — the permanent artifact the screener resolves against;
          shown first, directly under the header and expansion controls. */}
      <div className="rounded border border-border bg-background/40 p-3">
        <div className="mb-2 flex items-center justify-between">
          <button
            type="button"
            onClick={() => setMembersOpen((o) => !o)}
            className="flex items-center gap-1.5 text-sm font-semibold text-foreground"
          >
            <span className="text-[10px] text-muted-foreground">{membersOpen ? "▼" : "▶"}</span>
            Members ({visible.length})
          </button>
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
            Show inactive
          </label>
        </div>

        {membersOpen &&
          (sorted.length === 0 ? (
            <div className="rounded border border-border/60 bg-background/30 px-3 py-6 text-center text-sm text-muted-foreground">
              No members yet.
            </div>
          ) : (
            <div className="overflow-x-auto rounded border border-border/60">
              <table className="w-full min-w-[960px] text-sm">
                <thead className="border-b border-border/60 text-left text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <SortTh label="Symbol" sortKey="symbol" sort={sort} onSort={onSort} />
                    <SortTh label="Company" sortKey="companyName" sort={sort} onSort={onSort} />
                    <SortTh label="Sector" sortKey="sector" sort={sort} onSort={onSort} />
                    <SortTh label="Mkt Cap" sortKey="marketCap" sort={sort} onSort={onSort} align="right" />
                    <SortTh label="ADR%" sortKey="adr20Pct" sort={sort} onSort={onSort} align="right" />
                    <SortTh label="Price" sortKey="price" sort={sort} onSort={onSort} align="right" />
                    <SortTh label="20d $ Vol" sortKey="avgDollarVolume20d" sort={sort} onSort={onSort} align="right" />
                    <SortTh label="Anchor" sortKey="is_anchor" sort={sort} onSort={onSort} align="center" />
                    <SortTh label="Source" sortKey="source" sort={sort} onSort={onSort} />
                    <SortTh label="Added" sortKey="added_at" sort={sort} onSort={onSort} />
                    <th className="px-2 py-1.5 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((m) => (
                    <tr
                      key={m.id}
                      className={`border-b border-border/40 last:border-0 hover:bg-white/[0.02] ${
                        !m.is_active ? "opacity-50" : ""
                      }`}
                    >
                      <td className="px-2 py-1.5 font-mono font-semibold text-foreground">{m.symbol}</td>
                      <td className="px-2 py-1.5 text-muted-foreground">{m.companyName ?? "—"}</td>
                      <td className="px-2 py-1.5 text-muted-foreground">{m.sector ?? "—"}</td>
                      <td className="px-2 py-1.5 text-right font-mono">{fmtMarketCap(m.marketCap)}</td>
                      <td className="px-2 py-1.5 text-right font-mono">{fmtPct(m.adr20Pct)}</td>
                      <td className="px-2 py-1.5 text-right font-mono">{fmtMoney(m.price)}</td>
                      <td className="px-2 py-1.5 text-right font-mono">{fmtMarketCap(m.avgDollarVolume20d)}</td>
                      <td className="px-2 py-1.5 text-center">
                        {m.is_anchor && (
                          <span className="rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-300">
                            Anchor
                          </span>
                        )}
                      </td>
                      <td className="px-2 py-1.5 text-muted-foreground">{m.source}</td>
                      <td className="px-2 py-1.5 text-muted-foreground">{fmtDate(m.added_at)}</td>
                      <td className="px-2 py-1.5">
                        <div className="flex justify-end gap-1">
                          <button
                            type="button"
                            onClick={() => patchMember(m, { is_anchor: !m.is_anchor })}
                            className="flex items-center justify-center rounded border border-border px-2 py-1 text-muted-foreground hover:bg-white/5 hover:text-foreground"
                            title={m.is_anchor ? "Unset anchor" : "Set anchor"}
                            aria-label={m.is_anchor ? "Unset anchor" : "Set anchor"}
                          >
                            {m.is_anchor ? <StarOff className="h-3 w-3" /> : <Star className="h-3 w-3" />}
                          </button>
                          <button
                            type="button"
                            onClick={() => patchMember(m, { is_active: !m.is_active })}
                            className="flex items-center justify-center rounded border border-border px-2 py-1 text-muted-foreground hover:bg-white/5 hover:text-foreground"
                            title={m.is_active ? "Deactivate" : "Reactivate"}
                            aria-label={m.is_active ? "Deactivate member" : "Reactivate member"}
                          >
                            {m.is_active ? <Trash2 className="h-3 w-3" /> : <Undo2 className="h-3 w-3" />}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
      </div>

      {/* Pending review — transient work: everything Perplexity suggested
          that hasn't been accepted or rejected yet. */}
      {pending.length > 0 && (
        <div className="rounded border border-amber-500/40 bg-amber-500/5 p-3">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setPendingOpen((o) => !o)}
                className="flex items-center gap-1.5 text-sm font-semibold text-foreground"
              >
                <span className="text-[10px] text-muted-foreground">{pendingOpen ? "▼" : "▶"}</span>
                Pending review ({pending.length})
              </button>
              {/* Always visible, even collapsed — a partial selection
                  shouldn't require opening the section to notice. */}
              {selectedPending.size > 0 && (
                <span className="rounded-full border border-amber-400/50 bg-amber-400/10 px-2 py-0.5 text-[11px] font-medium text-amber-200">
                  {selectedPending.size} selected
                </span>
              )}
            </div>
            {pendingOpen && (
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={rejectReason}
                  onChange={(e) => setRejectReason(e.target.value)}
                  placeholder="Reject reason (optional)"
                  className="rounded border border-border bg-background px-2 py-1 text-[11px]"
                />
                <Button
                  variant="outline"
                  disabled={reviewBusy || selectedPending.size === 0}
                  onClick={() => rejectSelected(Array.from(selectedPending))}
                >
                  Reject selected ({selectedPending.size})
                </Button>
                <Button
                  disabled={reviewBusy || selectedPending.size === 0}
                  onClick={() => acceptSelected(Array.from(selectedPending))}
                >
                  Accept selected ({selectedPending.size})
                </Button>
              </div>
            )}
          </div>

          {pendingOpen && (
            <>
              <div className="mb-2 flex flex-wrap items-center gap-2 border-t border-border/60 pt-2 text-[11px] text-muted-foreground">
                <span>Select where</span>
                <select
                  value={thresholdColumn}
                  onChange={(e) => setThresholdColumn(e.target.value as ThresholdColumn)}
                  className="rounded border border-border bg-background px-1.5 py-1"
                >
                  {THRESHOLD_COLUMNS.map((c) => (
                    <option key={c.key} value={c.key}>
                      {c.label}
                    </option>
                  ))}
                </select>
                <select
                  value={thresholdOp}
                  onChange={(e) => setThresholdOp(e.target.value as "lt" | "gt")}
                  className="rounded border border-border bg-background px-1.5 py-1"
                >
                  <option value="lt">&lt;</option>
                  <option value="gt">&gt;</option>
                </select>
                <input
                  type="number"
                  value={thresholdValue}
                  onChange={(e) => setThresholdValue(e.target.value)}
                  placeholder="value"
                  className="w-20 rounded border border-border bg-background px-1.5 py-1"
                />
                <Button variant="outline" onClick={selectByThreshold} disabled={thresholdValue.trim() === ""}>
                  Select matching
                </Button>
                {selectedPending.size > 0 && (
                  <button
                    type="button"
                    onClick={() => setSelectedPending(new Set())}
                    className="text-muted-foreground underline hover:text-foreground"
                  >
                    Clear selection ({selectedPending.size})
                  </button>
                )}
                <span>Shift-click a checkbox to select a range.</span>
              </div>
              <div className="overflow-x-auto rounded border border-border/60">
                <table className="w-full min-w-[900px] text-sm">
                  <thead className="border-b border-border/60 text-left text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="p-0">
                        <label className="flex w-full cursor-pointer items-center justify-center px-2 py-1.5 hover:bg-white/5">
                          <input
                            type="checkbox"
                            className="h-3.5 w-3.5 cursor-pointer"
                            checked={selectedPending.size > 0 && selectedPending.size === sortedPending.length}
                            onChange={(e) =>
                              setSelectedPending(
                                e.target.checked ? new Set(sortedPending.map((m) => m.id)) : new Set(),
                              )
                            }
                          />
                        </label>
                      </th>
                      <SortTh label="Symbol" sortKey="symbol" sort={pendingSort} onSort={onPendingSort} />
                      <th className="px-2 py-1.5">Company</th>
                      <th className="px-2 py-1.5">Sector</th>
                      <SortTh label="Mkt Cap" sortKey="marketCap" sort={pendingSort} onSort={onPendingSort} align="right" />
                      <SortTh label="Price" sortKey="price" sort={pendingSort} onSort={onPendingSort} align="right" />
                      <SortTh label="ADR%" sortKey="adr20Pct" sort={pendingSort} onSort={onPendingSort} align="right" />
                      <SortTh
                        label="20d $ Vol"
                        sortKey="avgDollarVolume20d"
                        sort={pendingSort}
                        onSort={onPendingSort}
                        align="right"
                      />
                      <th className="px-2 py-1.5">Rationale</th>
                      <th className="px-2 py-1.5 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedPending.map((m, idx) => (
                      <tr key={m.id} className="border-b border-border/40 last:border-0 hover:bg-white/[0.02]">
                        <td className="p-0">
                          <label
                            className="flex h-full w-full cursor-pointer select-none items-center justify-center px-2 py-2 hover:bg-white/5"
                            onMouseDown={(e) => {
                              pendingShiftRef.current = e.shiftKey;
                            }}
                          >
                            <input
                              type="checkbox"
                              className="h-3.5 w-3.5 cursor-pointer"
                              checked={selectedPending.has(m.id)}
                              onChange={(e) => {
                                const shiftKey = pendingShiftRef.current || (e.nativeEvent as MouseEvent).shiftKey;
                                pendingShiftRef.current = false;
                                handlePendingCheckboxChange(m.id, idx, e.target.checked, shiftKey);
                              }}
                            />
                          </label>
                        </td>
                        <td className="px-2 py-1.5 font-mono font-semibold text-foreground">{m.symbol}</td>
                        <td className="px-2 py-1.5 text-muted-foreground">{m.companyName ?? "—"}</td>
                        <td className="px-2 py-1.5 text-muted-foreground">{m.sector ?? "—"}</td>
                        <td className="px-2 py-1.5 text-right font-mono">{fmtMarketCap(m.marketCap)}</td>
                        <td className="px-2 py-1.5 text-right font-mono">{fmtMoney(m.price)}</td>
                        <td className="px-2 py-1.5 text-right font-mono font-semibold text-amber-300">
                          {fmtPct(m.adr20Pct)}
                        </td>
                        <td className="px-2 py-1.5 text-right font-mono">{fmtMarketCap(m.avgDollarVolume20d)}</td>
                        <td className="max-w-[280px] px-2 py-1.5 text-muted-foreground">{m.notes ?? "—"}</td>
                        <td className="px-2 py-1.5">
                          <div className="flex justify-end gap-1">
                            <button
                              type="button"
                              disabled={reviewBusy}
                              onClick={() => acceptSelected([m.id])}
                              className="rounded border border-emerald-500/40 px-2 py-1 text-[10px] text-emerald-300 hover:bg-emerald-500/10"
                            >
                              Accept
                            </button>
                            <button
                              type="button"
                              disabled={reviewBusy}
                              onClick={() => rejectSelected([m.id])}
                              className="rounded border border-rose-500/40 px-2 py-1 text-[10px] text-rose-300 hover:bg-rose-500/10"
                            >
                              Reject
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}

      {/* Rejected — transient history, collapsed by default. */}
      {rejections.length > 0 && (
        <div className="rounded border border-border bg-background/40 p-3">
          <button
            type="button"
            onClick={() => setRejectedOpen((o) => !o)}
            className={`flex items-center gap-1.5 text-sm font-semibold text-foreground ${rejectedOpen ? "mb-2" : ""}`}
          >
            <span className="text-[10px] text-muted-foreground">{rejectedOpen ? "▼" : "▶"}</span>
            Rejected ({rejections.length})
          </button>
          {rejectedOpen && (
            <div className="overflow-x-auto rounded border border-border/60">
              <table className="w-full min-w-[820px] text-sm">
                <thead className="border-b border-border/60 text-left text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-2 py-1.5">Symbol</th>
                    <th className="px-2 py-1.5">Reason</th>
                    <th className="px-2 py-1.5">Rejected</th>
                    <th className="px-2 py-1.5">Rejected under</th>
                    <th className="px-2 py-1.5">Scope</th>
                    <th className="px-2 py-1.5 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rejections.map((r) => (
                    <tr key={r.id} className="border-b border-border/40 last:border-0 hover:bg-white/[0.02]">
                      <td className="px-2 py-1.5 font-mono font-semibold text-foreground">{r.symbol}</td>
                      <td className="max-w-[280px] px-2 py-1.5 text-muted-foreground">{r.reason ?? "—"}</td>
                      <td className="px-2 py-1.5 text-muted-foreground">{fmtDate(r.rejected_at)}</td>
                      <td className="px-2 py-1.5 text-muted-foreground">{r.theme_type ?? "—"}</td>
                      <td className="px-2 py-1.5">
                        {r.is_current_scope ? (
                          <span className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
                            Current question — suppresses
                          </span>
                        ) : (
                          <span
                            className="rounded border border-sky-500/40 bg-sky-500/10 px-1.5 py-0.5 text-[10px] text-sky-200"
                            title="Rejected under a different theme_type or expansion prompt — retained for the record, but does not suppress this symbol on the next expansion run."
                          >
                            Different question — inactive
                          </span>
                        )}
                      </td>
                      <td className="px-2 py-1.5">
                        <div className="flex justify-end">
                          <button
                            type="button"
                            disabled={undoingId === r.id}
                            onClick={() => undoOneRejection(r)}
                            className="rounded border border-border px-2 py-1 text-[10px] text-muted-foreground hover:bg-white/5 hover:text-foreground"
                            title="Remove this rejection — the symbol can be suggested again"
                          >
                            {undoingId === r.id ? "Undoing…" : "Undo"}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

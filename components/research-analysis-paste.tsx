"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MarkdownBody } from "@/components/filing-analysis";
import {
  parseResearchAnalysisPaste,
  isKnownFlag,
  type ParsedResearchAnalysis,
} from "@/lib/research-analysis-parser";
import { ANALYSIS_TEMPLATE_VERSION } from "@/lib/analysis-dump-template";

// The full research_analyses row, as returned by GET/POST
// /api/screener/research-analysis — the persisted source of truth this
// component hydrates the textarea from and diffs live edits against.
// Exported so the AI-badge read modal (components/research-analysis-
// modal.tsx) can share the exact same shape instead of redeclaring it.
export type SavedAnalysisRow = {
  symbol: string;
  earnings_date: string;
  flags_fired: string[];
  flags_na: string[];
  flags_unknown: string[];
  candidate_flags: string[];
  checklist_version: string | null;
  template_version: string | null;
  analysis_prose: string | null;
  raw_paste: string;
  parse_status: "parsed" | "prose_only" | "partial";
  updated_at: string;
};

// Shape handed to the optional onSaved callback — enough for a caller
// (the candidates table's AI-analysis indicator) to update its own
// index without re-fetching, and matching what the batch GET endpoint
// returns per row so both paths populate the same shape.
export type SavedAnalysisInfo = {
  symbol: string;
  earningsDate: string;
  updatedAt: string;
  checklistVersion: string | null;
};

function formatSavedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

// Paste-back capture for the Analysis Dump tab's research layer.
// Advisory only: this component only ever writes to research_analyses
// (via /api/screener/research-analysis) — it never touches the
// numeric grade, strike selection, POP, EV, or premium pricing.
//
// This is an iterative workflow (paste -> discuss -> revise -> re-save),
// not a one-shot submit, so the textarea always reflects what's
// currently persisted: hydrated from the DB on open, refilled (not
// cleared) from the server's response after a save, and diffed live
// against the saved raw_paste so an unsaved edit is never silently lost
// by navigating away.
export function ResearchAnalysisPasteBack({
  symbol,
  earningsDate,
  snapshot,
  onSaved,
}: {
  symbol: string;
  earningsDate: string;
  snapshot: {
    referenceStrike: number | null;
    spot: number | null;
    emPct: number | null;
    numericGrade: string | null;
    crushGrade: string | null;
    maxDownsideRatio: number | null;
  };
  // Fires after a successful save with exactly what the server
  // persisted — lets the candidates table light up its AI-analysis
  // badge immediately, without a page reload or a redundant re-fetch.
  onSaved?: (info: SavedAnalysisInfo) => void;
}) {
  const [raw, setRaw] = useState("");
  const [parsed, setParsed] = useState<ParsedResearchAnalysis | null>(null);
  const [confirmedMismatch, setConfirmedMismatch] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(true);
  const [savedRecord, setSavedRecord] = useState<SavedAnalysisRow | null>(null);
  // Paste box starts compact (the saved analysis is the primary reading
  // surface now, not this input) and grows once the user actually
  // focuses it. Does NOT shrink back on blur — layout jumping the box
  // out from under the cursor mid-click (e.g. right as "Parse &
  // preview" is clicked) would be worse than staying expanded.
  const [textareaExpanded, setTextareaExpanded] = useState(false);

  // Hydrate from research_analyses whenever the candidate changes (tab
  // open, or switching to a different symbol/earnings date). Empty
  // placeholder is just the natural result of no match existing — no
  // separate "not found" state needed.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setSavedRecord(null);
    setRaw("");
    setParsed(null);
    setSaved(false);
    setSaveError(null);
    setConfirmedMismatch(false);
    setTextareaExpanded(false);
    async function load() {
      try {
        const res = await fetch(
          `/api/screener/research-analysis?symbol=${encodeURIComponent(symbol)}`,
          { cache: "no-store" },
        );
        if (!res.ok) return;
        const json = (await res.json()) as { analyses?: SavedAnalysisRow[] };
        if (cancelled) return;
        const match = (json.analyses ?? []).find((a) => a.earnings_date === earningsDate) ?? null;
        if (match) {
          setSavedRecord(match);
          setRaw(match.raw_paste ?? "");
        }
      } catch {
        /* hydration is best-effort — falls back to the empty placeholder */
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [symbol, earningsDate]);

  const tickerMismatch =
    parsed !== null && parsed.ticker !== null && parsed.ticker.toUpperCase() !== symbol.toUpperCase();
  const dateMismatch =
    parsed !== null && parsed.earningsDate !== null && parsed.earningsDate !== earningsDate;
  const hasMismatch = tickerMismatch || dateMismatch;

  const unrecognizedFired = useMemo(
    () => (parsed ? parsed.flagsFired.filter((f) => !isKnownFlag(f)) : []),
    [parsed],
  );

  // Unsaved-edit detection — the textarea vs. whatever's actually
  // persisted (empty string when nothing's saved yet). Intentionally
  // independent of the parsed-preview state so it stays accurate even
  // before "Parse & preview" has been clicked.
  const hasUnsavedEdits = !loading && raw !== (savedRecord?.raw_paste ?? "");

  function handleParse() {
    setSaved(false);
    setSaveError(null);
    setConfirmedMismatch(false);
    if (raw.trim().length === 0) {
      setParsed(null);
      return;
    }
    setParsed(parseResearchAnalysisPaste(raw));
  }

  async function handleSave() {
    if (!parsed) return;
    if (hasMismatch && !confirmedMismatch) return;
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch("/api/screener/research-analysis", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol,
          earningsDate,
          flagsFired: parsed.flagsFired,
          flagsNa: parsed.flagsNa,
          flagsUnknown: parsed.flagsUnknown,
          candidateFlags: parsed.candidateFlags,
          checklistVersion: parsed.checklistVersion,
          templateVersion: ANALYSIS_TEMPLATE_VERSION,
          analysisProse: parsed.prose,
          rawPaste: parsed.rawPaste,
          parseStatus: parsed.status,
          referenceStrike: snapshot.referenceStrike,
          spotAtAnalysis: snapshot.spot,
          emPctAtAnalysis: snapshot.emPct,
          numericGrade: snapshot.numericGrade,
          crushGrade: snapshot.crushGrade,
          maxDownsideRatio: snapshot.maxDownsideRatio,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(typeof body.error === "string" ? body.error : `HTTP ${res.status}`);
      }
      // Rehydrate from the server's own upserted row rather than
      // clearing the box — the box should always show what's currently
      // persisted, and this is the freshest source of that.
      if (body.analysis) {
        const row = body.analysis as SavedAnalysisRow;
        setSavedRecord(row);
        setRaw(row.raw_paste ?? "");
        onSaved?.({
          symbol: row.symbol,
          earningsDate: row.earnings_date,
          updatedAt: row.updated_at,
          checklistVersion: row.checklist_version,
        });
      }
      setSaved(true);
      setParsed(null);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-2 rounded border border-border bg-background/40 p-3">
      <div className="text-sm font-medium text-foreground/80">
        Paste research analysis response
      </div>
      <p className="text-xs text-muted-foreground">
        Advisory only — never feeds the numeric grade, never vetoes a trade. Paste the full response
        from the external LLM conversation (including the metadata block) below.
      </p>

      {loading ? (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          Loading saved analysis…
        </div>
      ) : savedRecord ? (
        <div className="space-y-1 rounded border border-border bg-muted/20 p-2 text-xs">
          <div className="font-medium text-foreground/80">
            Currently saved — {formatSavedAt(savedRecord.updated_at)}
          </div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 font-mono text-muted-foreground">
            <div>Parse status: {savedRecord.parse_status}</div>
            <div>Checklist version: {savedRecord.checklist_version ?? "—"}</div>
          </div>
          <div className="text-muted-foreground">
            Flags fired ({savedRecord.flags_fired.length}):{" "}
            {savedRecord.flags_fired.length === 0 ? "none" : savedRecord.flags_fired.join(", ")}
          </div>
          <div className="text-muted-foreground">
            Flags N/A ({savedRecord.flags_na.length}):{" "}
            {savedRecord.flags_na.length === 0 ? "none" : savedRecord.flags_na.join(", ")}
          </div>
          <div className="text-muted-foreground">
            Flags unknown ({savedRecord.flags_unknown.length}):{" "}
            {savedRecord.flags_unknown.length === 0 ? "none" : savedRecord.flags_unknown.join(", ")}
          </div>
          <div className="text-muted-foreground">
            Candidate flags ({savedRecord.candidate_flags.length}):{" "}
            {savedRecord.candidate_flags.length === 0 ? "none" : savedRecord.candidate_flags.join(", ")}
          </div>
        </div>
      ) : (
        <div className="text-xs text-muted-foreground">No analysis saved yet for {symbol} / {earningsDate}.</div>
      )}

      {/* Primary reading surface — this is read repeatedly when deciding
          a trade, unlike the dump above it (copied once). No max-height/
          overflow here on purpose: the page scrolls naturally instead of
          fighting a cramped inner scrollbar for a typical ~5k-char
          analysis. */}
      {!loading && savedRecord && (
        <div className="rounded border border-border bg-background/60 p-3">
          {savedRecord.analysis_prose ? (
            <MarkdownBody text={savedRecord.analysis_prose} />
          ) : (
            <div className="text-xs text-muted-foreground">No prose stored for this analysis.</div>
          )}
        </div>
      )}

      <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
        Paste / revise
      </div>
      <textarea
        value={raw}
        onFocus={() => setTextareaExpanded(true)}
        onChange={(e) => {
          setRaw(e.target.value);
          setParsed(null);
          setSaved(false);
          setSaveError(null);
        }}
        placeholder="Paste the full analysis response here..."
        className={`w-full rounded border border-border bg-background px-2 py-1.5 font-mono text-xs transition-[height] duration-150 ${textareaExpanded ? "h-48" : "h-14"}`}
      />
      <div className="flex items-center gap-2">
        <Button size="sm" variant="secondary" onClick={handleParse} disabled={raw.trim().length === 0}>
          Parse &amp; preview
        </Button>
        {hasUnsavedEdits ? (
          <span className="flex items-center gap-1 text-xs text-amber-300">
            <AlertTriangle className="h-3.5 w-3.5" />
            Unsaved edits — not yet saved
          </span>
        ) : (
          saved && (
            <span className="flex items-center gap-1 text-xs text-emerald-400">
              <CheckCircle2 className="h-3.5 w-3.5" />
              Saved.
            </span>
          )
        )}
      </div>

      {parsed && (
        <div className="space-y-2 rounded border border-border bg-muted/20 p-2 text-xs">
          <div className="font-medium text-foreground/80">
            Preview — parse status: <span className="font-mono">{parsed.status}</span>
          </div>

          {parsed.status === "prose_only" && (
            <div className="flex items-start gap-1.5 rounded border border-amber-500/40 bg-amber-500/10 p-1.5 text-amber-200">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                No ANALYSIS METADATA block found. This will save as prose-only — flags, ticker, and
                date all left null. The full raw text is retained regardless.
              </span>
            </div>
          )}

          {parsed.notes.length > 0 && (
            <ul className="space-y-0.5 pl-1 text-muted-foreground">
              {parsed.notes.map((n, i) => (
                <li key={i}>• {n}</li>
              ))}
            </ul>
          )}

          <div className="grid grid-cols-2 gap-x-3 gap-y-1 font-mono">
            <div>
              Ticker: <span className={tickerMismatch ? "text-rose-400" : ""}>{parsed.ticker ?? "—"}</span>
            </div>
            <div>
              Earnings date: <span className={dateMismatch ? "text-rose-400" : ""}>{parsed.earningsDate ?? "—"}</span>
            </div>
            <div>Checklist version: {parsed.checklistVersion ?? "—"}</div>
            <div>Prose: {parsed.proseCharCount} chars</div>
          </div>

          <div className="space-y-1">
            <div>
              Flags fired ({parsed.flagsFired.length}):{" "}
              {parsed.flagsFired.length === 0
                ? "none"
                : parsed.flagsFired.map((f, i) => (
                    <span key={f} className={!isKnownFlag(f) ? "text-amber-300" : ""}>
                      {i > 0 ? ", " : ""}
                      {f}
                      {!isKnownFlag(f) ? " (unrecognized)" : ""}
                    </span>
                  ))}
            </div>
            <div>
              Flags N/A ({parsed.flagsNa.length}):{" "}
              {parsed.flagsNa.length === 0 ? "none" : parsed.flagsNa.join(", ")}
            </div>
            <div>
              Flags unknown ({parsed.flagsUnknown.length}):{" "}
              {parsed.flagsUnknown.length === 0 ? "none" : parsed.flagsUnknown.join(", ")}
            </div>
            <div>
              Candidate flags ({parsed.candidateFlags.length}):{" "}
              {parsed.candidateFlags.length === 0 ? "none" : parsed.candidateFlags.join(", ")}
            </div>
            {unrecognizedFired.length > 0 && (
              <div className="text-amber-300">
                {unrecognizedFired.length} flag(s) in FLAGS_FIRED are outside the current known vocabulary —
                stored as-is, shown above as (unrecognized), not dropped.
              </div>
            )}
          </div>

          {hasMismatch && (
            <div className="flex items-start gap-1.5 rounded border-2 border-rose-500 bg-rose-500/10 p-2 text-rose-200">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <div>
                <div className="font-semibold">
                  {tickerMismatch && dateMismatch
                    ? "Ticker AND earnings date do not match the current candidate."
                    : tickerMismatch
                      ? "Ticker does not match the current candidate."
                      : "Earnings date does not match the current candidate."}
                </div>
                <div className="mt-1">
                  Current candidate: {symbol} / {earningsDate}. Parsed: {parsed.ticker ?? "—"} /{" "}
                  {parsed.earningsDate ?? "—"}. This looks like the wrong ticker&apos;s analysis pasted here.
                </div>
                <label className="mt-1.5 flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={confirmedMismatch}
                    onChange={(e) => setConfirmedMismatch(e.target.checked)}
                  />
                  Save anyway for {symbol} / {earningsDate} (I&apos;ve confirmed this is correct)
                </label>
              </div>
            </div>
          )}

          {saveError && (
            <div className="rounded border border-rose-500/40 bg-rose-500/10 p-1.5 text-rose-200">
              Save failed: {saveError}
            </div>
          )}

          <Button
            size="sm"
            onClick={() => void handleSave()}
            disabled={saving || (hasMismatch && !confirmedMismatch)}
          >
            {saving ? (
              <>
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                Saving...
              </>
            ) : (
              `Save analysis for ${symbol} / ${earningsDate}`
            )}
          </Button>
        </div>
      )}
    </div>
  );
}

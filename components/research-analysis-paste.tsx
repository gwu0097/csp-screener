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
import {
  buildDictionaryMap,
  classifyObservations,
  validateObservationResolutions,
  type ObservationDictionaryEntry,
  type ObservationKind,
  type ObservationResolutions,
} from "@/lib/observation-dictionary";
import { computeRiskScore, canonicalizeFlags } from "@/lib/risk-score";

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
  risk_score_at_analysis?: number | null;
  risk_contributions_at_analysis?: unknown[] | null;
  risk_config_version_at_analysis?: string | null;
};

// Shape handed to the optional onSaved callback — enough for a caller
// (the candidates table's AI-analysis indicator) to update its own
// index without re-fetching, and matching what the batch GET endpoint
// returns per row so both paths populate the same shape. flagsFired is
// read by the live Risk Score column (lib/risk-score.ts) — display-
// only, never fed into grading.
export type SavedAnalysisInfo = {
  symbol: string;
  earningsDate: string;
  updatedAt: string;
  checklistVersion: string | null;
  flagsFired: string[];
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
    impliedMoveSource: string | null;
    pop: number | null;
    delta: number | null;
    yieldPct: number | null;
    premiumBid: number | null;
    premiumAsk: number | null;
    spreadPct: number | null;
    oi: number | null;
    volume: number | null;
    vix: number | null;
    vixRegime: string | null;
    crushSubscores: {
      historicalMoveScore: number;
      consistencyScore: number;
      termStructureScore: number;
      ivEdgeScore: number;
      surpriseScore: number;
    } | null;
    // Risk Score inputs not covered by the fields above — see
    // lib/risk-score.ts. flagsFired isn't here: it comes from this
    // paste's own parsed output at save time.
    hasOverhang: boolean;
    priorLossOnTicker: boolean;
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

  // Observation dictionary — fetched once (it's global, not per-candidate)
  // and used to classify a v4 paste's CANDIDATE_OBSERVATIONS against
  // known terms before Save is enabled. newTermKinds/useNewDefinitionFor
  // hold the user's resolutions for the two ambiguous cases the response
  // format itself can't carry: a brand-new term needs a kind chosen here,
  // and a redefined term needs the user to pick which definition wins.
  const [dictionaryEntries, setDictionaryEntries] = useState<ObservationDictionaryEntry[] | null>(null);
  const [dictionaryError, setDictionaryError] = useState<string | null>(null);
  const [dictionaryLoading, setDictionaryLoading] = useState(true);
  const [newTermKinds, setNewTermKinds] = useState<Record<string, ObservationKind>>({});
  const [useNewDefinitionFor, setUseNewDefinitionFor] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    setDictionaryLoading(true);
    setDictionaryError(null);
    (async () => {
      try {
        const res = await fetch("/api/screener/observation-dictionary", { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as { entries?: ObservationDictionaryEntry[] };
        if (cancelled) return;
        setDictionaryEntries(json.entries ?? []);
      } catch (e) {
        if (!cancelled) setDictionaryError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setDictionaryLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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

  const dictionaryMap = useMemo(() => buildDictionaryMap(dictionaryEntries ?? []), [dictionaryEntries]);
  const observationClassifications = useMemo(
    () => (parsed ? classifyObservations(parsed.candidateObservations, dictionaryMap) : []),
    [parsed, dictionaryMap],
  );
  const observationResolutions: ObservationResolutions = useMemo(
    () => ({ newTermKinds, useNewDefinitionFor: Array.from(useNewDefinitionFor) }),
    [newTermKinds, useNewDefinitionFor],
  );
  const observationValidation = useMemo(
    () => validateObservationResolutions(observationClassifications, observationResolutions),
    [observationClassifications, observationResolutions],
  );
  // A v4 paste (observationsBlockFound) can't be safely classified until
  // the dictionary has actually loaded — without it, a bare reused term
  // is indistinguishable from a new undefined one. Block Save rather than
  // guess; the server would reject anyway, but failing before the round
  // trip is cheaper and the reason is clearer to the user.
  const observationsBlockedOnDictionary =
    parsed !== null && parsed.observationsBlockFound && (dictionaryLoading || dictionaryError !== null);

  // Unsaved-edit detection — the textarea vs. whatever's actually
  // persisted (empty string when nothing's saved yet). Intentionally
  // independent of the parsed-preview state so it stays accurate even
  // before "Parse & preview" has been clicked.
  const hasUnsavedEdits = !loading && raw !== (savedRecord?.raw_paste ?? "");

  function handleParse() {
    setSaved(false);
    setSaveError(null);
    setConfirmedMismatch(false);
    setNewTermKinds({});
    setUseNewDefinitionFor(new Set());
    if (raw.trim().length === 0) {
      setParsed(null);
      return;
    }
    setParsed(parseResearchAnalysisPaste(raw));
  }

  async function handleSave() {
    if (!parsed) return;
    if (hasMismatch && !confirmedMismatch) return;
    if (parsed.observationsParseFailed) return;
    if (parsed.observationsBlockFound && (observationsBlockedOnDictionary || !observationValidation.ok)) return;
    setSaving(true);
    setSaveError(null);
    try {
      // Computed here (not read off `tl` — this component only ever
      // sees the snapshot prop) so the frozen risk_*_at_analysis columns
      // reflect the flags THIS save actually reports, not whatever an
      // earlier partial parse happened to carry.
      const riskResult = computeRiskScore({
        firedFlags: canonicalizeFlags(parsed.flagsFired),
        hasOverhang: snapshot.hasOverhang,
        vix: snapshot.vix,
        priorLossOnTicker: snapshot.priorLossOnTicker,
      });
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
          ...(parsed.observationsBlockFound
            ? {
                candidateObservations: parsed.candidateObservations,
                observationResolutions,
              }
            : {}),
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
          impliedMoveSourceAtAnalysis: snapshot.impliedMoveSource,
          popAtAnalysis: snapshot.pop,
          deltaAtAnalysis: snapshot.delta,
          yieldAtAnalysis: snapshot.yieldPct,
          premiumBidAtAnalysis: snapshot.premiumBid,
          premiumAskAtAnalysis: snapshot.premiumAsk,
          spreadPctAtAnalysis: snapshot.spreadPct,
          oiAtAnalysis: snapshot.oi,
          volumeAtAnalysis: snapshot.volume,
          vixAtAnalysis: snapshot.vix,
          vixRegimeAtAnalysis: snapshot.vixRegime,
          crushSubscoresAtAnalysis: snapshot.crushSubscores,
          riskScoreAtAnalysis: riskResult.score,
          riskContributionsAtAnalysis: riskResult.contributions,
          riskConfigVersionAtAnalysis: riskResult.configVersion,
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
          flagsFired: row.flags_fired,
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
            {!parsed.observationsBlockFound && (
              <div>
                Candidate flags ({parsed.candidateFlags.length}):{" "}
                {parsed.candidateFlags.length === 0 ? "none" : parsed.candidateFlags.join(", ")}
              </div>
            )}
            {unrecognizedFired.length > 0 && (
              <div className="text-amber-300">
                {unrecognizedFired.length} flag(s) in FLAGS_FIRED are outside the current known vocabulary —
                stored as-is, shown above as (unrecognized), not dropped.
              </div>
            )}
          </div>

          {parsed.observationsBlockFound && (
            <div className="space-y-1.5 rounded border border-border bg-background/40 p-2">
              <div className="font-medium text-foreground/80">
                Candidate observations ({parsed.candidateObservations.length})
              </div>

              {dictionaryLoading && (
                <div className="flex items-center gap-1.5 text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Loading observation dictionary…
                </div>
              )}
              {dictionaryError && (
                <div className="flex items-start gap-1.5 rounded border border-rose-500/40 bg-rose-500/10 p-1.5 text-rose-200">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  Observation dictionary unavailable ({dictionaryError}) — new vs. reused terms can&apos;t be
                  verified. Save is disabled until this loads; reload the page to retry.
                </div>
              )}
              {parsed.observationsParseFailed && (
                <div className="flex items-start gap-1.5 rounded border border-rose-500/40 bg-rose-500/10 p-1.5 text-rose-200">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  Block has content but nothing matched a term pattern — this is a parse failure, not an
                  empty list. Save is disabled until the raw paste is fixed or re-pasted.
                </div>
              )}
              {!dictionaryLoading &&
                !dictionaryError &&
                !parsed.observationsParseFailed &&
                parsed.candidateObservations.length === 0 && <div className="text-muted-foreground">none</div>}

              {!dictionaryLoading &&
                !dictionaryError &&
                observationClassifications.map((c) => (
                  <div key={c.term} className="rounded border border-border/60 p-1.5">
                    {c.status === "new_missing_definition" && (
                      <div className="flex items-start gap-1.5 text-rose-300">
                        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        <div>
                          <span className="font-mono">{c.term}</span> is a new term with no definition.
                          Definitions are required on first use — add one, or check the name if this was
                          meant to reuse an existing term.
                        </div>
                      </div>
                    )}

                    {c.status === "new_with_definition" && (
                      <div className="space-y-1">
                        <div>
                          <span className="font-mono text-emerald-300">{c.term}</span>{" "}
                          <span className="text-muted-foreground">(new) — {c.definition}</span>
                        </div>
                        <div className="flex flex-wrap items-center gap-3 pl-1 text-muted-foreground">
                          <span>Kind:</span>
                          <label className="flex items-center gap-1">
                            <input
                              type="radio"
                              name={`obs-kind-${c.term}`}
                              checked={newTermKinds[c.term] === "setup_observation"}
                              onChange={() =>
                                setNewTermKinds((prev) => ({ ...prev, [c.term]: "setup_observation" }))
                              }
                            />
                            Setup observation
                          </label>
                          <label className="flex items-center gap-1">
                            <input
                              type="radio"
                              name={`obs-kind-${c.term}`}
                              checked={newTermKinds[c.term] === "app_defect"}
                              onChange={() => setNewTermKinds((prev) => ({ ...prev, [c.term]: "app_defect" }))}
                            />
                            App defect
                          </label>
                          {!newTermKinds[c.term] && (
                            <span className="text-amber-300">— choose one to enable save</span>
                          )}
                        </div>
                      </div>
                    )}

                    {c.status === "existing_reused" && (
                      <div>
                        <span className="font-mono text-muted-foreground">{c.term}</span>{" "}
                        <span className="text-muted-foreground">(known) — {c.definition}</span>
                      </div>
                    )}

                    {c.status === "existing_redefined" && (
                      <div className="space-y-1 text-amber-200">
                        <div className="flex items-start gap-1.5">
                          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                          <div>
                            <span className="font-mono">{c.term}</span> redefined — pick which definition to
                            keep.
                          </div>
                        </div>
                        <label className="flex items-start gap-1.5 pl-1">
                          <input
                            type="radio"
                            name={`obs-redef-${c.term}`}
                            checked={!useNewDefinitionFor.has(c.term)}
                            onChange={() =>
                              setUseNewDefinitionFor((prev) => {
                                const next = new Set(prev);
                                next.delete(c.term);
                                return next;
                              })
                            }
                          />
                          Keep existing: {c.priorDefinition}
                        </label>
                        <label className="flex items-start gap-1.5 pl-1">
                          <input
                            type="radio"
                            name={`obs-redef-${c.term}`}
                            checked={useNewDefinitionFor.has(c.term)}
                            onChange={() => setUseNewDefinitionFor((prev) => new Set(prev).add(c.term))}
                          />
                          Use new: {c.newDefinition}
                        </label>
                      </div>
                    )}
                  </div>
                ))}
            </div>
          )}

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
            disabled={
              saving ||
              (hasMismatch && !confirmedMismatch) ||
              (parsed.observationsBlockFound &&
                (observationsBlockedOnDictionary || !observationValidation.ok))
            }
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
          {parsed.observationsBlockFound && !observationsBlockedOnDictionary && !observationValidation.ok && (
            <div className="text-rose-300">{observationValidation.error}</div>
          )}
        </div>
      )}
    </div>
  );
}

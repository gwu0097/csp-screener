"use client";

import { useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  parseResearchAnalysisPaste,
  isKnownFlag,
  type ParsedResearchAnalysis,
} from "@/lib/research-analysis-parser";
import { ANALYSIS_TEMPLATE_VERSION } from "@/lib/analysis-dump-template";

// Paste-back capture for the Analysis Dump tab's research layer.
// Advisory only: this component only ever writes to research_analyses
// (via /api/screener/research-analysis) — it never touches the
// numeric grade, strike selection, POP, EV, or premium pricing.
export function ResearchAnalysisPasteBack({
  symbol,
  earningsDate,
  snapshot,
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
}) {
  const [raw, setRaw] = useState("");
  const [parsed, setParsed] = useState<ParsedResearchAnalysis | null>(null);
  const [confirmedMismatch, setConfirmedMismatch] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const tickerMismatch =
    parsed !== null && parsed.ticker !== null && parsed.ticker.toUpperCase() !== symbol.toUpperCase();
  const dateMismatch =
    parsed !== null && parsed.earningsDate !== null && parsed.earningsDate !== earningsDate;
  const hasMismatch = tickerMismatch || dateMismatch;

  const unrecognizedFired = useMemo(
    () => (parsed ? parsed.flagsFired.filter((f) => !isKnownFlag(f)) : []),
    [parsed],
  );

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
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(typeof body.error === "string" ? body.error : `HTTP ${res.status}`);
      }
      setSaved(true);
      setRaw("");
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
      <textarea
        value={raw}
        onChange={(e) => {
          setRaw(e.target.value);
          setParsed(null);
          setSaved(false);
          setSaveError(null);
        }}
        placeholder="Paste the full analysis response here..."
        rows={6}
        className="w-full rounded border border-border bg-background px-2 py-1.5 font-mono text-xs"
      />
      <div className="flex items-center gap-2">
        <Button size="sm" variant="secondary" onClick={handleParse} disabled={raw.trim().length === 0}>
          Parse &amp; preview
        </Button>
        {saved && (
          <span className="flex items-center gap-1 text-xs text-emerald-400">
            <CheckCircle2 className="h-3.5 w-3.5" />
            Saved.
          </span>
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
              Flags unknown ({parsed.flagsUnknown.length}):{" "}
              {parsed.flagsUnknown.length === 0 ? "none" : parsed.flagsUnknown.join(", ")}
            </div>
            <div>
              Candidate flags ({parsed.candidateFlags.length}):{" "}
              {parsed.candidateFlags.length === 0 ? "none" : parsed.candidateFlags.join(", ")}
            </div>
            {unrecognizedFired.length > 0 && (
              <div className="text-amber-300">
                {unrecognizedFired.length} flag(s) in FLAGS_FIRED are outside the known v1 vocabulary —
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

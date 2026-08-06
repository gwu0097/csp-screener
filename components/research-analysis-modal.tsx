"use client";

// Read-only modal opened by clicking the candidates table's "AI" badge
// (components/screener-view.tsx) — reads that candidate's saved
// research analysis without expanding the row or switching tabs. No
// editing/saving here; that stays on the Analysis Dump tab's
// ResearchAnalysisPasteBack.
//
// The badge index (screener-view.tsx's analysisIndex, backed by
// /api/screener/research-analysis?symbols=...) only carries
// symbol/earnings_date/checklist_version/updated_at — deliberately
// trimmed so the whole-table badge query stays cheap. It does NOT
// carry analysis_prose, so this modal always does its own fetch on
// open (the single-?symbol= GET, which already selects the full row)
// rather than reusing the batch response.

import { useEffect, useState } from "react";
import { AlertTriangle, Loader2, X } from "lucide-react";
import { MarkdownBody } from "@/components/filing-analysis";
import type { SavedAnalysisRow } from "@/components/research-analysis-paste";

function formatSavedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function ResearchAnalysisModal({
  symbol,
  earningsDate,
  onClose,
}: {
  symbol: string;
  earningsDate: string;
  onClose: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [record, setRecord] = useState<SavedAnalysisRow | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setRecord(null);
    setError(null);
    (async () => {
      try {
        const res = await fetch(
          `/api/screener/research-analysis?symbol=${encodeURIComponent(symbol)}`,
          { cache: "no-store" },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as { analyses?: SavedAnalysisRow[] };
        if (cancelled) return;
        const match = (json.analyses ?? []).find((a) => a.earnings_date === earningsDate) ?? null;
        if (!match) throw new Error("No analysis found for this quarter.");
        setRecord(match);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [symbol, earningsDate]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-border bg-background shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="text-sm font-semibold text-foreground">
            {symbol} <span className="font-normal text-muted-foreground">/ {earningsDate}</span> — research
            analysis
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded p-1 text-muted-foreground hover:bg-muted/40 hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {loading ? (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Loading…
            </div>
          ) : error || !record ? (
            <div className="flex items-start gap-1.5 rounded border border-rose-500/40 bg-rose-500/10 p-2 text-xs text-rose-200">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {error ?? "Analysis not found."}
            </div>
          ) : (
            <div className="space-y-3">
              <div className="space-y-1 rounded border border-border bg-muted/20 p-2 text-xs">
                <div className="font-medium text-foreground/80">
                  Saved {formatSavedAt(record.updated_at)} · checklist{" "}
                  {record.checklist_version ?? "—"}
                </div>
                <div className="text-muted-foreground">
                  Flags fired ({record.flags_fired.length}):{" "}
                  {record.flags_fired.length === 0 ? "none" : record.flags_fired.join(", ")}
                </div>
                <div className="text-muted-foreground">
                  Flags N/A ({record.flags_na.length}):{" "}
                  {record.flags_na.length === 0 ? "none" : record.flags_na.join(", ")}
                </div>
                <div className="text-muted-foreground">
                  Flags unknown ({record.flags_unknown.length}):{" "}
                  {record.flags_unknown.length === 0 ? "none" : record.flags_unknown.join(", ")}
                </div>
                <div className="text-muted-foreground">
                  Candidate flags ({record.candidate_flags.length}):{" "}
                  {record.candidate_flags.length === 0 ? "none" : record.candidate_flags.join(", ")}
                </div>
              </div>
              {record.analysis_prose ? (
                <MarkdownBody text={record.analysis_prose} />
              ) : (
                <div className="text-xs text-muted-foreground">No prose stored for this analysis.</div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

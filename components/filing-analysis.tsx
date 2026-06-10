"use client";

// Pasted-Claude-analysis controls for filing rows on the 10-K tab.
// A filing with a stored analysis shows an "AI Summary" badge that
// expands an inline markdown panel (+ personal notes, delete); one
// without shows a "+ AI Summary" button that opens a paste form which
// POSTs to /api/research/[symbol]/analyses.

import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Loader2, Sparkles, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { FilingAnalysisRow } from "@/app/api/research/[symbol]/analyses/route";

export type FilingAnalysis = FilingAnalysisRow;

function fmtReviewedDate(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function AiSummaryBadge({
  open,
  onClick,
}: {
  open: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
        open
          ? "border-violet-500/60 bg-violet-500/20 text-violet-200"
          : "border-violet-500/40 bg-violet-500/10 text-violet-300 hover:bg-violet-500/20",
      )}
      title="Stored Claude analysis — click to view"
    >
      <Sparkles className="h-3 w-3" />
      AI Summary
    </button>
  );
}

export function AddAiSummaryButton({
  onClick,
  compact = false,
}: {
  onClick: () => void;
  compact?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1 rounded border border-border text-muted-foreground hover:bg-background/60 hover:text-foreground",
        compact ? "px-1.5 py-0.5 text-[10px]" : "px-2 py-1 text-[11px]",
      )}
      title="Paste Claude's analysis of this filing"
    >
      <Sparkles className={compact ? "h-3 w-3" : "h-3.5 w-3.5"} />
      + AI Summary
    </button>
  );
}

// Markdown body styled for the dark theme without a typography plugin.
function MarkdownBody({ text }: { text: string }) {
  return (
    <div
      className={cn(
        "text-[12px] leading-relaxed text-foreground/90",
        "[&_h1]:mt-3 [&_h1]:text-sm [&_h1]:font-bold [&_h1]:text-foreground",
        "[&_h2]:mt-3 [&_h2]:text-[13px] [&_h2]:font-semibold [&_h2]:text-foreground",
        "[&_h3]:mt-2 [&_h3]:text-[12px] [&_h3]:font-semibold [&_h3]:text-foreground",
        "[&_p]:my-1.5",
        "[&_ul]:my-1.5 [&_ul]:list-disc [&_ul]:pl-5",
        "[&_ol]:my-1.5 [&_ol]:list-decimal [&_ol]:pl-5",
        "[&_li]:my-0.5",
        "[&_strong]:font-semibold [&_strong]:text-foreground",
        "[&_a]:text-sky-300 [&_a]:underline",
        "[&_code]:rounded [&_code]:bg-muted/60 [&_code]:px-1 [&_code]:font-mono [&_code]:text-[11px]",
        "[&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:border [&_pre]:border-border [&_pre]:bg-background/60 [&_pre]:p-2",
        "[&_blockquote]:my-1.5 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-2 [&_blockquote]:text-muted-foreground",
        "[&_table]:my-2 [&_table]:w-full [&_table]:border-collapse [&_table]:text-[11px]",
        "[&_th]:border-b [&_th]:border-border [&_th]:px-1.5 [&_th]:py-1 [&_th]:text-left [&_th]:font-semibold",
        "[&_td]:border-b [&_td]:border-border/40 [&_td]:px-1.5 [&_td]:py-1",
        "[&_hr]:my-3 [&_hr]:border-border",
      )}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
}

// Expanded view of a stored analysis: markdown body, personal-notes
// field (PATCH), delete (DELETE → onChanged reloads the parent list).
export function AnalysisViewPanel({
  analysis,
  onChanged,
}: {
  analysis: FilingAnalysis;
  onChanged: () => void | Promise<void>;
}) {
  const [note, setNote] = useState(analysis.notes ?? "");
  const [noteOpen, setNoteOpen] = useState(Boolean(analysis.notes));
  const [savingNote, setSavingNote] = useState(false);
  const [noteSaved, setNoteSaved] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const base = `/api/research/${encodeURIComponent(analysis.symbol)}/analyses/${analysis.id}`;

  async function saveNote() {
    setSavingNote(true);
    setError(null);
    try {
      const res = await fetch(base, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notes: note }),
        cache: "no-store",
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setError(j.error ?? `Save failed (HTTP ${res.status})`);
        return;
      }
      setNoteSaved(true);
      setTimeout(() => setNoteSaved(false), 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setSavingNote(false);
    }
  }

  async function remove() {
    if (
      !window.confirm(
        `Delete the stored analysis for ${analysis.symbol} ${analysis.period}?`,
      )
    ) {
      return;
    }
    setDeleting(true);
    setError(null);
    try {
      const res = await fetch(base, { method: "DELETE", cache: "no-store" });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setError(j.error ?? `Delete failed (HTTP ${res.status})`);
        return;
      }
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="mt-2 rounded border border-violet-500/30 bg-violet-500/[0.04] p-2.5">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-violet-300">
          AI Summary · Reviewed {fmtReviewedDate(analysis.reviewed_at)}
        </span>
        <button
          type="button"
          onClick={() => void remove()}
          disabled={deleting}
          className="text-muted-foreground hover:text-rose-300 disabled:opacity-60"
          title="Delete this analysis"
          aria-label="Delete analysis"
        >
          {deleting ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Trash2 className="h-3.5 w-3.5" />
          )}
        </button>
      </div>

      <MarkdownBody text={analysis.analysis_text} />

      <div className="mt-2 border-t border-border/50 pt-2">
        {!noteOpen ? (
          <button
            type="button"
            onClick={() => setNoteOpen(true)}
            className="text-[11px] text-muted-foreground hover:text-foreground"
          >
            + Add note
          </button>
        ) : (
          <div className="space-y-1.5">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Personal note
            </div>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Your take on this filing…"
              rows={2}
              className="w-full rounded border border-border bg-background px-2 py-1 text-[11px]"
            />
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => void saveNote()}
                disabled={savingNote}
              >
                {savingNote ? (
                  <>
                    <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                    Saving…
                  </>
                ) : noteSaved ? (
                  <>
                    <Check className="mr-1 h-3 w-3" />
                    Saved
                  </>
                ) : (
                  "Save note"
                )}
              </Button>
            </div>
          </div>
        )}
        {error && <div className="mt-1 text-[10px] text-rose-300">{error}</div>}
      </div>
    </div>
  );
}

// Paste form for a new analysis. POSTs and hands control back via
// onSaved so the caller can reload its analyses list.
export function AnalysisPasteForm({
  symbol,
  filingType,
  period,
  filingDate,
  onSaved,
  onCancel,
}: {
  symbol: string;
  filingType: "8-K" | "10-Q" | "10-K";
  period: string;
  filingDate?: string | null;
  onSaved: () => void | Promise<void>;
  onCancel: () => void;
}) {
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!text.trim()) {
      setError("Paste the analysis text first");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/research/${encodeURIComponent(symbol)}/analyses`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            filing_type: filingType,
            period,
            filing_date: filingDate ?? undefined,
            analysis_text: text,
          }),
          cache: "no-store",
        },
      );
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setError(j.error ?? `Save failed (HTTP ${res.status})`);
        return;
      }
      await onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-2 rounded border border-border bg-background/60 p-2.5">
      <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        Paste Claude&apos;s analysis for {period}
      </div>
      <textarea
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Paste the full markdown response from Claude here…"
        rows={10}
        className="w-full rounded border border-border bg-background px-2 py-1.5 font-mono text-[11px] leading-relaxed"
      />
      <div className="mt-2 flex items-center gap-2">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => void save()}
          disabled={saving}
        >
          {saving ? (
            <>
              <Loader2 className="mr-1 h-3 w-3 animate-spin" />
              Saving…
            </>
          ) : (
            "Save"
          )}
        </Button>
        <button
          type="button"
          onClick={onCancel}
          className="text-[11px] text-muted-foreground hover:text-foreground"
        >
          Cancel
        </button>
        {error && <span className="text-[10px] text-rose-300">{error}</span>}
      </div>
    </div>
  );
}

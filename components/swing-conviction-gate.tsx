"use client";

import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { StarRating, type SwingIdea } from "@/components/swing-idea-dialog";

const CHECKLIST: Array<{ key: string; label: string }> = [
  { key: "understand", label: "I understand what this company does" },
  { key: "catalyst", label: "I believe the catalyst is real and near-term" },
  { key: "valuation", label: "The valuation makes sense at current price" },
  { key: "wrong", label: "I know what would make me wrong" },
];

const MIN_THESIS_WORDS = 10;
const MIN_EXIT_WORDS = 5;

function wordCount(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

export function SwingConvictionGate({
  idea,
  open,
  onOpenChange,
  onConfirmed,
  apiBase = "/api/swings/ideas",
}: {
  idea: SwingIdea | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onConfirmed: () => void;
  apiBase?: string;
}) {
  const [checks, setChecks] = useState<Record<string, boolean>>({});
  const [thesis, setThesis] = useState("");
  const [exit, setExit] = useState("");
  const [conviction, setConviction] = useState(3);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-seed the form whenever the dialog opens for a different idea.
  // Existing user_thesis / conviction get pre-filled so an aborted gate
  // doesn't lose what the user already wrote.
  useEffect(() => {
    if (!open) return;
    setChecks({});
    setThesis(idea?.user_thesis ?? "");
    setExit(idea?.exit_condition ?? "");
    setConviction(idea?.conviction ?? 3);
    setError(null);
  }, [open, idea?.id, idea?.user_thesis, idea?.exit_condition, idea?.conviction]);

  const allChecked = CHECKLIST.every((c) => checks[c.key]);
  const thesisWords = wordCount(thesis);
  const exitWords = wordCount(exit);
  const ready =
    allChecked && thesisWords >= MIN_THESIS_WORDS && exitWords >= MIN_EXIT_WORDS;

  async function submit() {
    if (!idea || !ready) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`${apiBase}/${idea.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: "conviction",
          user_thesis: thesis.trim(),
          exit_condition: exit.trim(),
          conviction,
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      onConfirmed();
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>
            Build your conviction for{" "}
            <span className="font-mono">{idea?.symbol ?? "—"}</span>
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2 text-sm">
          <p className="text-xs text-muted-foreground">
            Before marking as conviction, confirm:
          </p>

          <div className="space-y-2">
            {CHECKLIST.map((c) => (
              <label
                key={c.key}
                className="flex cursor-pointer items-start gap-2 rounded-md border border-border bg-background/40 p-2 hover:bg-background/60"
              >
                <input
                  type="checkbox"
                  checked={!!checks[c.key]}
                  onChange={(e) =>
                    setChecks((prev) => ({ ...prev, [c.key]: e.target.checked }))
                  }
                  className="mt-0.5 h-4 w-4 cursor-pointer"
                />
                <span className="text-foreground">{c.label}</span>
              </label>
            ))}
          </div>

          <label className="grid gap-1 text-xs">
            <span className="text-muted-foreground">
              My thesis <span className="text-rose-300">*</span>{" "}
              <span className="text-[10px]">
                (one sentence: why will this stock move up in the next 1-6 months?)
              </span>
            </span>
            <textarea
              value={thesis}
              onChange={(e) => setThesis(e.target.value)}
              rows={3}
              className="rounded border border-border bg-background px-2 py-1.5 text-sm"
              placeholder="SaaS sticky businesses won't be replaced by AI quickly — enterprise switching costs are too high…"
            />
            <span
              className={`text-[10px] ${
                thesisWords >= MIN_THESIS_WORDS
                  ? "text-emerald-300"
                  : "text-muted-foreground"
              }`}
            >
              {thesisWords} words (need at least {MIN_THESIS_WORDS})
            </span>
          </label>

          <label className="grid gap-1 text-xs">
            <span className="text-muted-foreground">
              My exit condition <span className="text-rose-300">*</span>{" "}
              <span className="text-[10px]">
                (what price or event triggers a sell?)
              </span>
            </span>
            <textarea
              value={exit}
              onChange={(e) => setExit(e.target.value)}
              rows={2}
              className="rounded border border-border bg-background px-2 py-1.5 text-sm"
              placeholder="Close if AI disruption narrative accelerates or company misses two quarters of revenue guidance…"
            />
            <span
              className={`text-[10px] ${
                exitWords >= MIN_EXIT_WORDS
                  ? "text-emerald-300"
                  : "text-muted-foreground"
              }`}
            >
              {exitWords} words (need at least {MIN_EXIT_WORDS})
            </span>
          </label>

          <div className="flex items-center gap-2 text-xs">
            <span className="text-muted-foreground">Conviction level:</span>
            <StarRating value={conviction} onChange={setConviction} />
          </div>

          {error && (
            <div className="rounded border border-rose-500/40 bg-rose-500/10 p-2 text-xs text-rose-300">
              {error}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button onClick={submit} disabled={!ready || submitting}>
            {submitting ? "Saving…" : "Mark as Conviction →"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

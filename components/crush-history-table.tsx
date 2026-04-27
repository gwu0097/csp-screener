"use client";

// Per-quarter crush history surfaced in the screener expanded row.
// Reads stageThree.details.crushHistory which is stamped server-side
// by runStagesThreeFour. ★ marks events within ±2pp of today's IV-
// implied move (today's EM is the only fair comparison set).

import { AlertTriangle } from "lucide-react";

type CrushHistoryEvent = {
  earningsDate: string;
  qtrLabel: string;
  impliedMovePct: number | null;
  actualMovePct: number | null;
  ratio: number | null;
  grade: "A" | "B" | "C" | "D" | "F" | null;
  impliedMoveSource: string | null;
};

const SIMILAR_EM_TOLERANCE = 0.02; // ±2pp from today's EM

function fmtPct(n: number | null, digits = 1): string {
  if (n === null || !Number.isFinite(n)) return "?";
  return `${(Math.abs(n) * 100).toFixed(digits)}%`;
}

function fmtRatio(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "?";
  return n.toFixed(2);
}

function gradeBadgeCls(g: CrushHistoryEvent["grade"]): string {
  if (g === "A") return "bg-emerald-500/15 text-emerald-300";
  if (g === "B") return "bg-teal-500/15 text-teal-300";
  if (g === "C") return "bg-amber-500/15 text-amber-300";
  if (g === "D") return "bg-orange-500/15 text-orange-300";
  if (g === "F") return "bg-rose-500/15 text-rose-300";
  return "bg-zinc-500/10 text-muted-foreground";
}

export function CrushHistoryTable({
  events,
  todayEmPct,
  todaySymbol,
}: {
  events: CrushHistoryEvent[] | undefined | null;
  todayEmPct: number | null;
  todaySymbol: string;
}) {
  if (!events || events.length === 0) return null;

  // Sort newest first; today's pending row goes at the bottom.
  const sorted = [...events].sort((a, b) => b.earningsDate.localeCompare(a.earningsDate));
  const similar: CrushHistoryEvent[] = [];
  if (todayEmPct !== null) {
    for (const e of sorted) {
      if (e.impliedMovePct === null) continue;
      if (Math.abs(e.impliedMovePct - todayEmPct) <= SIMILAR_EM_TOLERANCE) {
        similar.push(e);
      }
    }
  }
  const similarFs = similar.filter((e) => e.grade === "F");

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
    <div className="rounded-md border border-border bg-background/40 p-3 text-xs">
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        Earnings history
      </div>
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
            {sorted.map((e) => {
              const isSimilar =
                todayEmPct !== null &&
                e.impliedMovePct !== null &&
                Math.abs(e.impliedMovePct - todayEmPct) <= SIMILAR_EM_TOLERANCE;
              const isF = e.grade === "F";
              return (
                <tr
                  key={e.earningsDate}
                  className={`border-t border-border ${isSimilar ? "bg-emerald-500/[0.04]" : ""}`}
                >
                  <td className="px-2 py-1 font-mono">{e.qtrLabel}</td>
                  <td className="px-2 py-1 text-right font-mono">
                    {fmtPct(e.impliedMovePct)}
                  </td>
                  <td className="px-2 py-1 text-right font-mono">
                    {fmtPct(e.actualMovePct)}
                  </td>
                  <td className="px-2 py-1 text-right font-mono">
                    {fmtRatio(e.ratio)}
                  </td>
                  <td className="px-2 py-1 text-center">
                    <span
                      className={`inline-flex items-center gap-0.5 rounded px-1 py-0.5 font-mono font-semibold ${gradeBadgeCls(e.grade)}`}
                    >
                      {e.grade ?? "?"}
                      {isF && <span title="Stock overshot implied move">⚠️</span>}
                    </span>
                  </td>
                  <td className="px-2 py-1 text-[10px] text-muted-foreground">
                    {isSimilar && (
                      <span className="text-emerald-300/80">★ similar EM</span>
                    )}
                    {!isSimilar && e.impliedMovePct === null && (
                      <span>EM not available</span>
                    )}
                  </td>
                </tr>
              );
            })}
            <tr className="border-t border-border bg-amber-500/[0.04]">
              <td className="px-2 py-1 font-mono font-semibold text-amber-200">
                TODAY
              </td>
              <td className="px-2 py-1 text-right font-mono text-amber-200">
                {fmtPct(todayEmPct)}
              </td>
              <td className="px-2 py-1 text-right font-mono text-muted-foreground">
                ???
              </td>
              <td className="px-2 py-1 text-right font-mono text-muted-foreground">
                ???
              </td>
              <td className="px-2 py-1 text-center text-muted-foreground">???</td>
              <td className="px-2 py-1 text-[10px] text-muted-foreground">
                pending
              </td>
            </tr>
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

      {similarFs.length > 0 && (
        <div className="mt-2 flex items-start gap-2 rounded border border-amber-500/40 bg-amber-500/10 p-2 text-[11px] text-amber-200">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <div>
            <div className="font-medium">
              ⚠️ {similarFs.length} similar-EM quarter
              {similarFs.length === 1 ? "" : "s"} resulted in a larger-than-
              expected move.
            </div>
            <div className="mt-0.5 text-[10px] text-amber-200/80">
              Pull up {todaySymbol}&apos;s{" "}
              {similarFs.map((e) => e.qtrLabel).join(", ")}{" "}
              earnings news to understand what overshot the implied range —
              [What caused it? →] (coming soon)
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

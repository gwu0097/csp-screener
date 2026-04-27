"use client";

// Per-quarter crush history surfaced in the screener expanded row.
// Reads stageThree.details.crushHistory which is stamped server-side
// by runStagesThreeFour. ★ marks events within ±2pp of today's IV-
// implied move (today's EM is the only fair comparison set).

import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, XCircle } from "lucide-react";

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

// Signed version for the Actual column. Direction is encoded in the
// sign of actualMovePct (positive = up, negative = down). Returns
// "+14.8%" / "-11.6%" / "0.0%" / "?".
function fmtSignedPct(n: number | null, digits = 1): string {
  if (n === null || !Number.isFinite(n)) return "?";
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
                  <td
                    className={`px-2 py-1 text-right font-mono ${signedPctCls(e.actualMovePct)}`}
                  >
                    {fmtSignedPct(e.actualMovePct)}
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

      {outliers.length > 0 && (
        <TradeDecisionContext
          symbol={todaySymbol}
          outliers={outliers}
          todayEmPct={todayEmPct ?? null}
        />
      )}
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
  outliers,
  todayEmPct,
}: {
  symbol: string;
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

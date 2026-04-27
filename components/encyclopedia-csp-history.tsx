"use client";

// CSP History tab — one card per past or upcoming earnings event,
// newest first. Surfaces the same per-event data the screener writes
// during analyze (implied move, actual move, crush, options-flow
// snapshot, trade-decision context). The point is to let a trader
// look at SPOT and see "last quarter implied 9.4%, stock moved 14.8%
// (F), pre-earnings flow had 44% deep-OTM put cluster + bearish bias"
// in one glance before opening a new position.

import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, XCircle } from "lucide-react";

type FlowUnusual = {
  type?: string;
  strike?: number;
  volume?: number;
  oi?: number;
  ratio?: number;
  note?: string;
};

type TradeContext = {
  overallRisk: string;
  verdict: string;
  safeToTrade: boolean;
  outlierAnalyses: unknown[];
  keyMetricToWatch: string;
  confidence: string;
  currentSetupResembles: string;
};

type CspHistoryEvent = {
  earningsDate: string;
  qtrLabel: string;
  impliedMove: number | null;
  actualMove: number | null;
  direction: "up" | "down" | null;
  crushRatio: number | null;
  crushGrade: "A" | "B" | "C" | "D" | "F" | null;
  flowPcRatio: number | null;
  flowBias: string | null;
  flowDeepOtmPct: number | null;
  flowUnusualTop3: FlowUnusual[] | null;
  flowCapturedAt: string | null;
  tradeContext: TradeContext | null;
};

function fmtPct(n: number | null, digits = 1): string {
  if (n === null || !Number.isFinite(n)) return "—";
  return `${(Math.abs(n) * 100).toFixed(digits)}%`;
}

function fmtSignedPct(n: number | null, digits = 1): string {
  if (n === null || !Number.isFinite(n)) return "—";
  const pct = n * 100;
  if (pct > 0) return `+${pct.toFixed(digits)}%`;
  return `${pct.toFixed(digits)}%`;
}

function shortDate(iso: string): string {
  const d = new Date(iso + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

// Border + tint for the card. Pending = gray; A/B = green; C/D = amber;
// F (>1.2× ratio) = red. Mirrors the spec: actual within EM = green,
// exceeded = amber, way exceeded = red. Pending (no actual yet) = gray.
function cardBorderClass(e: CspHistoryEvent): string {
  if (e.actualMove === null) return "border-border bg-background/40";
  const g = e.crushGrade;
  if (g === "A" || g === "B") return "border-emerald-500/40 bg-emerald-500/[0.04]";
  if (g === "C" || g === "D") return "border-amber-500/40 bg-amber-500/[0.04]";
  if (g === "F") return "border-rose-500/50 bg-rose-500/[0.05]";
  return "border-border bg-background/40";
}

function gradeBadgeClass(g: CspHistoryEvent["crushGrade"]): string {
  if (g === "A") return "bg-emerald-500/15 text-emerald-300 border-emerald-500/40";
  if (g === "B") return "bg-teal-500/15 text-teal-300 border-teal-500/40";
  if (g === "C") return "bg-amber-500/15 text-amber-300 border-amber-500/40";
  if (g === "D") return "bg-orange-500/15 text-orange-300 border-orange-500/40";
  if (g === "F") return "bg-rose-500/15 text-rose-300 border-rose-500/40";
  return "bg-zinc-500/10 text-muted-foreground border-border";
}

function biasBadgeClass(bias: string | null): string {
  if (bias === "bullish") return "bg-emerald-500/15 text-emerald-300 border-emerald-500/40";
  if (bias === "bearish") return "bg-rose-500/15 text-rose-300 border-rose-500/40";
  if (bias === "neutral") return "bg-zinc-500/15 text-zinc-300 border-zinc-500/40";
  return "bg-zinc-500/10 text-muted-foreground border-border";
}

function riskBadgeClass(risk: string): string {
  const r = risk.toLowerCase();
  if (r === "high") return "bg-rose-500/15 text-rose-300 border-rose-500/40";
  if (r === "medium") return "bg-amber-500/15 text-amber-300 border-amber-500/40";
  if (r === "low") return "bg-emerald-500/15 text-emerald-300 border-emerald-500/40";
  return "bg-zinc-500/10 text-muted-foreground border-border";
}

function todayHeaderTag(e: CspHistoryEvent): { label: string; cls: string } {
  if (e.actualMove === null) {
    return {
      label: "PENDING",
      cls: "bg-zinc-500/15 text-zinc-300 border-zinc-500/40",
    };
  }
  const arrow = e.direction === "up" ? "▲" : e.direction === "down" ? "▼" : "";
  const cls =
    e.crushGrade === "F"
      ? "bg-rose-500/15 text-rose-300 border-rose-500/40"
      : e.crushGrade === "C" || e.crushGrade === "D"
        ? "bg-amber-500/15 text-amber-300 border-amber-500/40"
        : "bg-emerald-500/15 text-emerald-300 border-emerald-500/40";
  return {
    label: `${fmtSignedPct(e.actualMove)} ${arrow}`.trim(),
    cls,
  };
}

export function CspHistoryTab({ symbol }: { symbol: string }) {
  const [events, setEvents] = useState<CspHistoryEvent[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function run() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(
          `/api/encyclopedia/${encodeURIComponent(symbol)}/csp-history`,
          { cache: "no-store" },
        );
        const json = (await res.json()) as {
          events?: CspHistoryEvent[];
          error?: string;
        };
        if (cancelled) return;
        if (!res.ok || json.error) {
          throw new Error(json.error ?? `HTTP ${res.status}`);
        }
        setEvents(json.events ?? []);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Failed to load");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, [symbol]);

  if (loading) {
    return (
      <div className="flex items-center justify-center rounded-md border border-border bg-background/40 px-6 py-12 text-sm text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        Loading CSP history…
      </div>
    );
  }
  if (error) {
    return (
      <div className="rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
        <AlertTriangle className="mr-1.5 inline h-3 w-3" />
        {error}
      </div>
    );
  }
  if (!events || events.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border bg-background/40 px-6 py-12 text-center text-sm text-muted-foreground">
        No CSP history for {symbol} yet.
        <br />
        Run the CSP screener when {symbol} has upcoming earnings to start
        building history.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {events.map((e) => (
        <CspEventCard key={e.earningsDate} event={e} />
      ))}
    </div>
  );
}

function CspEventCard({ event: e }: { event: CspHistoryEvent }) {
  const tag = todayHeaderTag(e);
  return (
    <div className={`rounded-md border p-4 text-xs ${cardBorderClass(e)}`}>
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2 border-b border-border/60 pb-2">
        <div className="font-semibold text-foreground">
          <span className="text-sm">{e.qtrLabel}</span>
          <span className="ml-2 text-muted-foreground">
            — {shortDate(e.earningsDate)}
          </span>
        </div>
        <span
          className={`rounded border px-2 py-0.5 text-[10px] font-semibold whitespace-nowrap ${tag.cls}`}
        >
          {tag.label}
        </span>
      </div>

      {/* Top-line numbers */}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <Metric label="Implied Move" value={fmtPct(e.impliedMove)} />
        <Metric
          label="Actual Move"
          value={
            e.actualMove === null ? (
              <span className="text-muted-foreground">pending</span>
            ) : (
              <span
                className={
                  e.direction === "up"
                    ? "text-emerald-300"
                    : e.direction === "down"
                      ? "text-rose-300"
                      : ""
                }
              >
                {fmtSignedPct(e.actualMove)}
                {e.crushRatio !== null && (
                  <span className="ml-1 text-muted-foreground">
                    (ratio {e.crushRatio.toFixed(2)})
                  </span>
                )}
              </span>
            )
          }
        />
        <Metric
          label="Crush"
          value={
            e.crushGrade === null ? (
              <span className="text-muted-foreground">pending</span>
            ) : (
              <span className="inline-flex items-center gap-1.5">
                <span
                  className={`inline-block rounded border px-1.5 py-0.5 font-mono font-semibold ${gradeBadgeClass(e.crushGrade)}`}
                >
                  {e.crushGrade}
                </span>
                {e.crushRatio !== null && (
                  <span className="text-muted-foreground">
                    moved {e.crushRatio.toFixed(2)}× implied
                  </span>
                )}
                {e.crushGrade === "F" && (
                  <AlertTriangle className="h-3 w-3 text-rose-300" />
                )}
              </span>
            )
          }
        />
      </div>

      {/* Options flow */}
      <FlowSection event={e} />

      {/* Trade decision */}
      <TradeDecisionSection event={e} />
    </div>
  );
}

function Metric({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="rounded border border-border/40 bg-background/40 px-2 py-1.5">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="mt-0.5 font-mono">{value}</div>
    </div>
  );
}

function FlowSection({ event: e }: { event: CspHistoryEvent }) {
  const captured =
    e.flowPcRatio !== null ||
    e.flowBias !== null ||
    e.flowDeepOtmPct !== null ||
    (e.flowUnusualTop3 !== null && e.flowUnusualTop3.length > 0);
  return (
    <div className="mt-4 rounded border border-border/40 bg-background/40 px-3 py-2">
      <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        Options flow{" "}
        <span className="font-normal lowercase">(pre-earnings snapshot)</span>
      </div>
      {!captured ? (
        <div className="text-muted-foreground">Not captured for this quarter</div>
      ) : (
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {e.flowPcRatio !== null && (
              <span>
                <span className="text-muted-foreground">P/C Ratio:</span>{" "}
                <span className="font-mono text-foreground">
                  {e.flowPcRatio.toFixed(2)}
                </span>
              </span>
            )}
            {e.flowBias && (
              <span
                className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase ${biasBadgeClass(
                  e.flowBias,
                )}`}
              >
                {e.flowBias}
              </span>
            )}
            {e.flowDeepOtmPct !== null && (
              <span>
                <span className="text-muted-foreground">Deep OTM puts:</span>{" "}
                <span className="font-mono text-foreground">
                  {e.flowDeepOtmPct.toFixed(0)}%
                </span>
                {e.flowDeepOtmPct >= 25 && (
                  <span title="Elevated tail-risk hedging" className="ml-1">
                    ⚠️
                  </span>
                )}
              </span>
            )}
          </div>
          {e.flowUnusualTop3 && e.flowUnusualTop3.length > 0 && (
            <div className="text-muted-foreground">
              <span>Top unusual:</span>{" "}
              <span className="font-mono text-foreground">
                {e.flowUnusualTop3
                  .slice(0, 3)
                  .map(
                    (u) =>
                      `$${u.strike ?? "?"} ${(u.type ?? "").toUpperCase()} ${
                        u.ratio !== undefined ? u.ratio.toFixed(1) + "×" : ""
                      }`.trim(),
                  )
                  .join(" | ")}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TradeDecisionSection({ event: e }: { event: CspHistoryEvent }) {
  return (
    <div className="mt-3 rounded border border-border/40 bg-background/40 px-3 py-2">
      <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        Trade decision
      </div>
      {!e.tradeContext ? (
        <div className="text-muted-foreground">
          No pre-earnings context recorded for this quarter
        </div>
      ) : (
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>
              <span className="text-muted-foreground">Risk:</span>{" "}
              <span
                className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase ${riskBadgeClass(
                  e.tradeContext.overallRisk,
                )}`}
              >
                {e.tradeContext.overallRisk}
              </span>
            </span>
            <span>
              <span className="text-muted-foreground">Safe to trade:</span>{" "}
              <span
                className={
                  e.tradeContext.safeToTrade
                    ? "text-emerald-300"
                    : "text-rose-300"
                }
              >
                {e.tradeContext.safeToTrade ? (
                  <span className="inline-flex items-center gap-1">
                    <CheckCircle2 className="h-3 w-3" /> YES
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1">
                    <XCircle className="h-3 w-3" /> NO
                  </span>
                )}
              </span>
            </span>
          </div>
          <div className="text-foreground">
            <span className="text-muted-foreground">Verdict:</span>{" "}
            <span className="italic">&ldquo;{e.tradeContext.verdict}&rdquo;</span>
          </div>
          {e.tradeContext.keyMetricToWatch &&
            e.tradeContext.keyMetricToWatch !== "—" && (
              <div className="text-muted-foreground">
                <span>Key metric:</span>{" "}
                <span className="text-foreground">
                  {e.tradeContext.keyMetricToWatch}
                </span>
              </div>
            )}
        </div>
      )}
    </div>
  );
}

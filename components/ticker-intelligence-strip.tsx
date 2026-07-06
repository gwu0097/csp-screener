"use client";

// Compact point-of-decision intelligence strip for one ticker. Rendered
// in the screener expanded row (between chart and fundamentals bar) and
// on the Deep Research page (between chart and tab bar). Loads
// /api/intelligence/ticker/[symbol] async — a skeleton shows while
// loading and a failed fetch renders nothing rather than blocking or
// breaking the page around it.

import { useEffect, useState } from "react";

type TickerIntel = {
  symbol: string;
  history: { trades: number; wins: number; win_rate: number; avg_roc: number | null } | null;
  sector: {
    industry: string;
    trades: number;
    win_rate: number;
    avg_roc: number | null;
  } | null;
  calibration: {
    scope: "ticker" | "sector";
    events: number;
    avg_ratio: number;
    within_implied_pct: number;
  } | null;
  crush: { grade: string; avg_move_ratio: number; events: number } | null;
};

// Spec color bands. Win rate: ≥85 green, 70-84 amber, <70 red.
function winColor(rate: number): string {
  if (rate >= 0.85) return "text-emerald-300";
  if (rate >= 0.7) return "text-amber-300";
  return "text-rose-300";
}
// Move ratio: <0.7 green (premium rich), 0.7-1.0 amber, >1.0 red.
function ratioColor(ratio: number): string {
  if (ratio < 0.7) return "text-emerald-300";
  if (ratio <= 1.0) return "text-amber-300";
  return "text-rose-300";
}
function ratioLabel(ratio: number): string {
  if (ratio < 0.7) return "rich premium";
  if (ratio <= 1.0) return "fair";
  return "dangerous";
}
function gradeColorClass(g: string): string {
  if (g === "A") return "text-emerald-300";
  if (g === "B") return "text-emerald-200/80";
  if (g === "C") return "text-amber-300";
  return "text-rose-300";
}
function pct(v: number, digits = 0): string {
  return `${(v * 100).toFixed(digits)}%`;
}

function Section({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 px-3 first:pl-0 last:pr-0">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className="truncate text-sm">{children}</div>
    </div>
  );
}

export function TickerIntelligenceStrip({ symbol }: { symbol: string }) {
  const [data, setData] = useState<TickerIntel | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");

  useEffect(() => {
    let cancelled = false;
    setState("loading");
    setData(null);
    (async () => {
      try {
        const res = await fetch(
          `/api/intelligence/ticker/${encodeURIComponent(symbol)}`,
          { cache: "no-store" },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as TickerIntel;
        if (!cancelled) {
          setData(json);
          setState("ready");
        }
      } catch {
        if (!cancelled) setState("failed");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [symbol]);

  if (state === "failed") return null;
  if (state === "loading") {
    return (
      <div className="flex h-12 animate-pulse items-center rounded-md border border-border bg-background/40 px-3">
        <div className="h-3 w-1/2 rounded bg-muted/40" />
      </div>
    );
  }
  if (!data) return null;

  const { history, sector, calibration, crush } = data;

  return (
    <div className="flex flex-wrap items-center divide-x divide-border rounded-md border border-border bg-background/40 px-3 py-2">
      <Section label="Your history">
        {history && history.trades > 0 ? (
          <>
            <span className="text-foreground">{history.trades} trade{history.trades === 1 ? "" : "s"}</span>
            {" · "}
            <span className={winColor(history.win_rate)}>{pct(history.win_rate)} win</span>
            {history.avg_roc !== null && (
              <span className="text-muted-foreground"> · {pct(history.avg_roc, 2)} ROC</span>
            )}
          </>
        ) : (
          <span className="text-muted-foreground">No trades yet</span>
        )}
      </Section>

      <Section label="Sector">
        {sector ? (
          sector.trades > 0 ? (
            <>
              <span className="text-foreground" title={sector.industry}>
                {sector.industry}
              </span>
              {" · "}
              <span className={winColor(sector.win_rate)}>
                {pct(sector.win_rate)} win
              </span>
              {sector.avg_roc !== null && (
                <span className="text-muted-foreground">
                  {" "}
                  · {pct(sector.avg_roc, 2)} ROC ({sector.trades})
                </span>
              )}
            </>
          ) : (
            <>
              <span className="text-foreground" title={sector.industry}>
                {sector.industry}
              </span>
              <span className="text-muted-foreground"> · no sector trades</span>
            </>
          )
        ) : (
          <span className="text-muted-foreground">No sector data</span>
        )}
      </Section>

      <Section label="Move calibration">
        {calibration ? (
          <>
            <span className={ratioColor(calibration.avg_ratio)}>
              {calibration.avg_ratio.toFixed(2)}× avg
            </span>
            <span className="text-muted-foreground">
              {" "}
              · inside {pct(calibration.within_implied_pct)} of {calibration.events}
              {calibration.scope === "sector" ? " sector events" : " events"}
            </span>
            {" · "}
            <span className={ratioColor(calibration.avg_ratio)}>
              {ratioLabel(calibration.avg_ratio)}
            </span>
          </>
        ) : (
          <span className="text-muted-foreground">No earnings pairs</span>
        )}
      </Section>

      <Section label="Crush">
        {crush ? (
          <>
            <span className={`font-semibold ${gradeColorClass(crush.grade)}`}>
              Crush {crush.grade}
            </span>
            <span className="text-muted-foreground">
              {" "}
              · {crush.avg_move_ratio.toFixed(2)}× over {crush.events} report{crush.events === 1 ? "" : "s"}
            </span>
          </>
        ) : (
          <span className="text-muted-foreground">No crush data</span>
        )}
      </Section>
    </div>
  );
}

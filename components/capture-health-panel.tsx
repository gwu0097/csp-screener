"use client";

import { useEffect, useState } from "react";
import { AlertOctagon, AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";

// Reads /api/capture-health, which reads capture_health_daily — NOT
// Parquet chain-data presence. A day with zero due symbols and a day
// where the scheduled run never fired look identical from the outside
// unless the source of truth is the outcome log's rollup, which is
// exactly why this panel exists.
type CaptureHealthResp = {
  todayEt: string;
  lastRun: {
    captureDate: string;
    runStartedAt: string | null;
    runFinishedAt: string | null;
    due: number;
    fired: number;
    errored: number;
    suppressed: number;
    missed: number;
    schwabDisconnected: number;
    reconciledAt: string | null;
  } | null;
  todayHasRun: boolean;
  outstandingToday: Array<{ symbol: string; earnings_date: string | null; trading_day_offset: number | null }>;
  coverage7: { bdaysChecked: number; zeroRunDates: string[]; highFailureDates: string[] };
  coverage30: { bdaysChecked: number; zeroRunDates: string[]; highFailureDates: string[] };
  schwabStatus: { ok: boolean; expiresInDays?: number; error?: string } | null;
  priceIntegrityFlags: Array<{
    symbol: string;
    earnings_date: string;
    stored_price_before: number;
    stored_price_after: number;
    stored_actual_move_pct: number | null;
    matched_before_date: string;
    matched_after_date: string;
    gap_from_earnings_days: number;
    detected_at: string;
  }>;
};

export function CaptureHealthPanel() {
  const [resp, setResp] = useState<CaptureHealthResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/capture-health", { cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<CaptureHealthResp>;
      })
      .then((j) => {
        if (!cancelled) setResp(j);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-border bg-muted/30 p-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Checking capture health...
      </div>
    );
  }
  if (error || !resp) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-200">
        <AlertOctagon className="h-4 w-4 shrink-0" />
        Capture-health check failed: {error ?? "no data"}
      </div>
    );
  }

  const { lastRun, todayHasRun, outstandingToday, coverage7, coverage30, schwabStatus } = resp;

  const problems: string[] = [];
  if (!lastRun) {
    problems.push("No capture run has ever been recorded.");
  }
  if (coverage7.zeroRunDates.length > 0) {
    problems.push(`${coverage7.zeroRunDates.length} day(s) in the last 7 with NO run at all: ${coverage7.zeroRunDates.join(", ")}`);
  }
  if (coverage7.highFailureDates.length > 0) {
    problems.push(`${coverage7.highFailureDates.length} day(s) in the last 7 with >10% failures: ${coverage7.highFailureDates.join(", ")}`);
  }
  if (coverage30.zeroRunDates.length > coverage7.zeroRunDates.length) {
    problems.push(`${coverage30.zeroRunDates.length} day(s) in the last 30 with NO run at all.`);
  }
  if (outstandingToday.length > 0) {
    problems.push(`${outstandingToday.length} symbol(s) still owed a capture today: ${outstandingToday.slice(0, 8).map((o) => o.symbol).join(", ")}${outstandingToday.length > 8 ? "…" : ""}`);
  }
  if (schwabStatus && !schwabStatus.ok) {
    problems.push(`Schwab token: ${schwabStatus.error ?? "not connected"}`);
  }

  const degraded = problems.length > 0;

  return (
    <div
      className={
        degraded
          ? "rounded-lg border-2 border-rose-500 bg-rose-500/10 p-4 shadow-[0_0_0_1px_rgba(244,63,94,0.3)]"
          : "rounded-lg border border-border bg-muted/20 p-3"
      }
    >
      <div className="flex items-center gap-2">
        {degraded ? (
          <AlertOctagon className="h-5 w-5 shrink-0 text-rose-400" />
        ) : (
          <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />
        )}
        <span className={degraded ? "text-base font-bold text-rose-200" : "text-sm font-medium text-foreground/80"}>
          {degraded ? "Post-earnings capture: DEGRADED" : "Post-earnings capture healthy"}
        </span>
      </div>

      {degraded && (
        <ul className="mt-2 space-y-1 pl-1 text-sm text-rose-200">
          {problems.map((p, i) => (
            <li key={i} className="flex gap-2">
              <span className="text-rose-400">•</span>
              <span>{p}</span>
            </li>
          ))}
        </ul>
      )}

      <div className={degraded ? "mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-rose-200/80 sm:grid-cols-4" : "mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground sm:grid-cols-4"}>
        <div>
          Last run: {lastRun ? lastRun.captureDate : "never"}
          {lastRun?.runFinishedAt ? ` (${new Date(lastRun.runFinishedAt).toLocaleTimeString()})` : ""}
        </div>
        <div>
          due {lastRun?.due ?? 0} / fired {lastRun?.fired ?? 0} / errored {lastRun?.errored ?? 0}
        </div>
        <div>
          suppressed {lastRun?.suppressed ?? 0} / missed {lastRun?.missed ?? 0} / disconnected {lastRun?.schwabDisconnected ?? 0}
        </div>
        <div>
          today&apos;s run: {todayHasRun ? "recorded" : "not yet"}
        </div>
        <div>
          7d coverage: {coverage7.bdaysChecked - coverage7.zeroRunDates.length}/{coverage7.bdaysChecked} days ran
        </div>
        <div>
          30d coverage: {coverage30.bdaysChecked - coverage30.zeroRunDates.length}/{coverage30.bdaysChecked} days ran
        </div>
        <div>
          Schwab: {schwabStatus?.ok ? `ok (${schwabStatus.expiresInDays?.toFixed(1)}d)` : (schwabStatus?.error ?? "unknown")}
        </div>
        <div>outstanding today: {outstandingToday.length}</div>
      </div>
    </div>
  );
}

// Warn-only price-date-mismatch findings from the weekly scan
// (scripts/detect-price-date-mismatch.ts). Never auto-repaired —
// this panel is where a human sees them and decides whether to act.
// Separate component so a clean capture run doesn't hide these, and a
// price-integrity issue doesn't get mistaken for a capture-pipeline
// problem (different failure mode, different severity color).
export function PriceIntegrityFlagsPanel() {
  const [resp, setResp] = useState<CaptureHealthResp | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/capture-health", { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<CaptureHealthResp>) : null))
      .then((j) => {
        if (!cancelled) setResp(j);
      })
      .catch(() => {
        if (!cancelled) setResp(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading || !resp || resp.priceIntegrityFlags.length === 0) return null;

  return (
    <div className="rounded-lg border-2 border-amber-500 bg-amber-500/10 p-4 shadow-[0_0_0_1px_rgba(245,158,11,0.3)]">
      <div className="flex items-center gap-2">
        <AlertTriangle className="h-5 w-5 shrink-0 text-amber-400" />
        <span className="text-base font-bold text-amber-200">
          Price integrity: {resp.priceIntegrityFlags.length} row(s) flagged
        </span>
      </div>
      <p className="mt-1 text-xs text-amber-200/80">
        Stored price_before/price_after exactly match real closes on dates well outside the
        earnings window — the same signature as the report-window-gap bug fixed 2026-08-05. Warn
        only: nothing here has been changed automatically.
      </p>
      <ul className="mt-3 space-y-2">
        {resp.priceIntegrityFlags.map((f) => (
          <li
            key={`${f.symbol}|${f.earnings_date}`}
            className="rounded border border-amber-500/30 bg-amber-500/5 p-2 text-xs text-amber-100"
          >
            <div className="font-mono font-semibold">
              {f.symbol} · earnings_date {f.earnings_date}
            </div>
            <div className="mt-1 text-amber-200/90">
              stored: before={f.stored_price_before} after={f.stored_price_after}{" "}
              {f.stored_actual_move_pct !== null
                ? `(${(f.stored_actual_move_pct * 100).toFixed(2)}%)`
                : ""}
            </div>
            <div className="text-amber-200/90">
              actually matches: {f.matched_before_date} → {f.matched_after_date} (
              {f.gap_from_earnings_days}d from earnings_date)
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

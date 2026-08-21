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

// Reads /api/capture-health/crush — the T0/T1 earnings_history
// actual-move pipeline (captureEarningsT0/T1). Separate endpoint and
// separate panel from CaptureHealthPanel above on purpose: that one
// watches a different mechanism entirely (capture_phase='daily', the
// local full-chain Parquet capture). The 2026-08-11 audit found the
// banner above claiming DEGRADED/healthy for this pipeline while never
// actually reading its data — this panel is what closes that gap.
type CrushHealthDay = { date: string; state: "no_run" | "ran_nothing_due" | "ran_ok" | "ran_failed"; due: number; fired: number; failed: number };
type CrushHealthResp = {
  todayEt: string;
  t0: {
    last: { capture_date: string; due: number; fired: number; errored: number; schwab_disconnected: number; run_finished_at: string | null } | null;
    days: CrushHealthDay[];
  };
  t1: {
    last: { capture_date: string; due: number; fired: number; errored: number; schwab_disconnected: number; run_finished_at: string | null } | null;
    days: CrushHealthDay[];
  };
  incomplete: Array<{ symbol: string; earningsDate: string; attempts: number; lastAttemptAt: string | null; lastFailureReason: string | null }>;
  unrecoverable: Array<{ id: string; symbol: string; earningsDate: string; reason: string | null }>;
};

function dayStateLabel(s: CrushHealthDay["state"]): string {
  switch (s) {
    case "no_run":
      return "did not run";
    case "ran_nothing_due":
      return "ran, nothing due";
    case "ran_failed":
      return "ran, failed";
    case "ran_ok":
      return "ran ok";
  }
}

function dayStateColor(s: CrushHealthDay["state"]): string {
  switch (s) {
    case "no_run":
      return "text-rose-300";
    case "ran_failed":
      return "text-amber-300";
    case "ran_nothing_due":
      return "text-muted-foreground";
    case "ran_ok":
      return "text-emerald-300";
  }
}

// Aged-out rows tend to share one root cause (e.g. every legacy
// phantom-capture row carries the identical explanation) — printing
// the same paragraph 9 times is noise. Group by exact reason text so
// it's stated once with the affected symbols listed under it.
function groupByReason(
  rows: CrushHealthResp["unrecoverable"],
): Array<[string, CrushHealthResp["unrecoverable"]]> {
  const byReason = new Map<string, CrushHealthResp["unrecoverable"]>();
  for (const r of rows) {
    const key = r.reason ?? "unknown";
    const bucket = byReason.get(key);
    if (bucket) bucket.push(r);
    else byReason.set(key, [r]);
  }
  return Array.from(byReason.entries()).sort((a, b) => b[1].length - a[1].length);
}

export function CrushCaptureHealthPanel() {
  const [resp, setResp] = useState<CrushHealthResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Local, mutable copy of resp.unrecoverable so a Dismiss click can
  // remove rows immediately (and let `degraded` re-evaluate) without a
  // full refetch. Dismiss is permanent server-side (see the dismiss
  // route) — a page reload won't bring these back.
  const [unrecoverable, setUnrecoverable] = useState<CrushHealthResp["unrecoverable"]>([]);
  const [dismissingKey, setDismissingKey] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/capture-health/crush", { cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<CrushHealthResp>;
      })
      .then((j) => {
        if (!cancelled) {
          setResp(j);
          setUnrecoverable(j.unrecoverable);
        }
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

  async function dismissIds(ids: string[]): Promise<boolean> {
    try {
      const res = await fetch("/api/capture-health/crush/dismiss", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async function dismissReason(reason: string, ids: string[]) {
    setDismissingKey(reason);
    try {
      if (await dismissIds(ids)) {
        setUnrecoverable((prev) => prev.filter((r) => !ids.includes(r.id)));
      }
    } finally {
      setDismissingKey(null);
    }
  }

  async function dismissAllUnrecoverable() {
    if (unrecoverable.length === 0) return;
    const ids = unrecoverable.map((r) => r.id);
    setDismissingKey("__all__");
    try {
      if (await dismissIds(ids)) {
        setUnrecoverable([]);
      }
    } finally {
      setDismissingKey(null);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-border bg-muted/30 p-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Checking T0/T1 crush-capture health...
      </div>
    );
  }
  if (error || !resp) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-200">
        <AlertOctagon className="h-4 w-4 shrink-0" />
        Crush-capture health check failed: {error ?? "no data"}
      </div>
    );
  }

  const { t0, t1, incomplete } = resp;
  const degraded = incomplete.length > 0 || unrecoverable.length > 0 || t0.days.some((d) => d.state === "no_run" || d.state === "ran_failed") || t1.days.some((d) => d.state === "no_run" || d.state === "ran_failed");

  return (
    <div
      className={
        degraded
          ? "rounded-lg border-2 border-amber-500 bg-amber-500/10 p-4 shadow-[0_0_0_1px_rgba(245,158,11,0.3)]"
          : "rounded-lg border border-border bg-muted/20 p-3"
      }
    >
      <div className="flex items-center gap-2">
        {degraded ? (
          <AlertTriangle className="h-5 w-5 shrink-0 text-amber-400" />
        ) : (
          <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />
        )}
        <span className={degraded ? "text-base font-bold text-amber-200" : "text-sm font-medium text-foreground/80"}>
          {degraded ? "T0/T1 crush capture: attention needed" : "T0/T1 crush capture healthy"}
        </span>
      </div>

      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <div className="text-xs font-semibold text-foreground/70">T0 (last 7 weekdays)</div>
          <ul className="mt-1 space-y-0.5 text-xs">
            {t0.days.map((d) => (
              <li key={d.date} className={dayStateColor(d.state)}>
                {d.date}: {dayStateLabel(d.state)}
                {d.state === "ran_failed" ? ` (${d.failed}/${d.due} failed)` : ""}
              </li>
            ))}
          </ul>
        </div>
        <div>
          <div className="text-xs font-semibold text-foreground/70">T1 (last 7 weekdays)</div>
          <ul className="mt-1 space-y-0.5 text-xs">
            {t1.days.map((d) => (
              <li key={d.date} className={dayStateColor(d.state)}>
                {d.date}: {dayStateLabel(d.state)}
                {d.state === "ran_failed" ? ` (${d.failed}/${d.due} failed)` : ""}
              </li>
            ))}
          </ul>
        </div>
      </div>

      {incomplete.length > 0 && (
        <div className="mt-3">
          <div className="text-xs font-semibold text-amber-200">
            Incomplete T1 ({incomplete.length}) — still within retry window
          </div>
          <ul className="mt-1 space-y-1 text-xs text-amber-100/90">
            {incomplete.map((r) => (
              <li key={`${r.symbol}|${r.earningsDate}`} className="font-mono">
                {r.symbol} ({r.earningsDate}): {r.attempts} attempt{r.attempts === 1 ? "" : "s"}
                {r.lastFailureReason ? ` — last failure: ${r.lastFailureReason}` : " — never attempted"}
              </li>
            ))}
          </ul>
        </div>
      )}

      {unrecoverable.length > 0 && (
        <div className="mt-3">
          <div className="flex items-center justify-between gap-2">
            <div className="text-xs font-semibold text-rose-200">
              Aged out permanently ({unrecoverable.length})
            </div>
            <button
              type="button"
              disabled={dismissingKey !== null}
              onClick={() => dismissAllUnrecoverable()}
              className="text-[11px] text-rose-200/70 hover:text-rose-100 disabled:opacity-50"
            >
              {dismissingKey === "__all__" ? "Dismissing…" : "Dismiss all"}
            </button>
          </div>
          <div className="mt-1 space-y-2">
            {groupByReason(unrecoverable).map(([reason, rows]) => (
              <div key={reason} className="flex items-start justify-between gap-2">
                <div>
                  <div className="text-xs text-rose-100/90">{reason}</div>
                  <div className="mt-0.5 font-mono text-xs text-rose-200/80">
                    {rows.map((r) => `${r.symbol} (${r.earningsDate})`).join(", ")}
                  </div>
                </div>
                <button
                  type="button"
                  disabled={dismissingKey !== null}
                  onClick={() => dismissReason(reason, rows.map((r) => r.id))}
                  className="shrink-0 text-[11px] text-rose-200/70 hover:text-rose-100 disabled:opacity-50"
                >
                  {dismissingKey === reason ? "Dismissing…" : "Dismiss"}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
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

// A write the earnings_history precedence trigger rejected — the
// incoming date_confidence tier ranked below the row's stored tier
// (migrations/2026-08-19-earnings-history-precedence-trigger.sql),
// logged by lib/earnings-history-writer.ts. Persistent panel, not a
// toast, same reasoning as PriceIntegrityFlagsPanel above: a rejection
// can originate from an unattended cron (Phase 1 refresh, the manual-
// repair script), so it has to surface on the next page load regardless
// of who — if anyone — was watching when it happened.
type RejectionRow = {
  id: string;
  symbol: string;
  earnings_date: string;
  quarter_label: string | null;
  attempted_by: string;
  attempted_tier: string;
  attempted_data_source: string | null;
  attempted_timing: string | null;
  stored_tier: string;
  stored_data_source: string;
  stored_earnings_date: string;
  stored_timing: string | null;
  created_at: string;
};
type RejectionsResp = { rejections: RejectionRow[] };

export function EarningsHistoryRejectionsPanel() {
  const [resp, setResp] = useState<RejectionsResp | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/capture-health/earnings-history-rejections", { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<RejectionsResp>) : null))
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

  if (loading || !resp || resp.rejections.length === 0) return null;

  return (
    <div className="rounded-lg border-2 border-rose-500 bg-rose-500/10 p-4 shadow-[0_0_0_1px_rgba(244,63,94,0.3)]">
      <div className="flex items-center gap-2">
        <AlertOctagon className="h-5 w-5 shrink-0 text-rose-400" />
        <span className="text-base font-bold text-rose-200">
          Earnings history writes rejected: {resp.rejections.length} (last 30d)
        </span>
      </div>
      <p className="mt-1 text-xs text-rose-200/80">
        The precedence guard blocked these because the incoming date confidence tier ranked below
        what&apos;s already stored — the stored row wins, nothing was changed. Investigate the
        writer named below, not the row.
      </p>
      <ul className="mt-3 space-y-2">
        {resp.rejections.map((r) => (
          <li
            key={r.id}
            className="rounded border border-rose-500/30 bg-rose-500/5 p-2 text-xs text-rose-100"
          >
            <div className="font-mono font-semibold">
              {r.symbol} · earnings_date {r.earnings_date}
              {r.quarter_label ? ` (${r.quarter_label})` : ""}
            </div>
            <div className="mt-1 text-rose-200/90">
              {r.attempted_by} attempted {r.attempted_tier}
              {r.attempted_data_source ? ` / ${r.attempted_data_source}` : ""} — stored is{" "}
              {r.stored_tier} / {r.stored_data_source}
            </div>
            <div className="text-rose-200/70">{new Date(r.created_at).toLocaleString()}</div>
          </li>
        ))}
      </ul>
    </div>
  );
}

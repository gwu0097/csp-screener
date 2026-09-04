"use client";

// Cheap "last run" visibility for the Schwab and Robinhood couriers —
// reads /api/positions/courier-status, which is just the latest row
// each poller already writes to schwab_account_poll_runs /
// robinhood_account_poll_runs, plus local-only Robinhood courier
// failures now logged via /api/robinhood-account/poll-attempt. See the
// 2026-09-04 incident: a 1:05pm Robinhood run silently never reached
// the deployed route, and there was nothing on this page to show it —
// a clean "0 new fills" run and total silence looked identical.
//
// Admin-only, same convention as SchwabTokenBanner — the route itself
// 401s for non-admins, so a failed fetch here is silently ignored
// rather than shown as an error.
//
// Fetched once on mount, no polling: a page refresh showing current
// state (including "running since HH:MM" while a courier run is still
// in flight — see run_finished_at handling below) is enough; watching
// it flip live isn't worth a client polling loop (2026-09-04, explicit
// user call).

import { useEffect, useState } from "react";

type CourierRun = {
  broker: string;
  accountNumber: string | null;
  ok: boolean;
  fillsCreated: number;
  errorCount: number;
  errors: string[] | null;
  runStartedAt: string;
  runFinishedAt: string | null;
} | null;

type CourierStatusResponse = {
  schwab: CourierRun;
  schwab2: CourierRun;
  robinhood: CourierRun;
};

// Robinhood fires every 2h weekdays 07:05-13:05, Schwab similar
// 07:00-13:00 — 3 hours covers a single missed cycle without flagging
// a normal end-of-day gap as stale.
const STALE_HOURS = 3;

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function isStale(iso: string): boolean {
  return Date.now() - new Date(iso).getTime() > STALE_HOURS * 60 * 60 * 1000;
}

function latestOf(runs: CourierRun[]): CourierRun {
  const present = runs.filter((r): r is NonNullable<CourierRun> => r !== null);
  if (present.length === 0) return null;
  return present.sort((a, b) => b.runStartedAt.localeCompare(a.runStartedAt))[0];
}

function StatusItem({ label, run }: { label: string; run: CourierRun }) {
  if (!run) {
    return <span className="text-muted-foreground">{label}: no run recorded</span>;
  }
  // run_finished_at stays NULL for the lifetime of an in-flight run —
  // see app/api/robinhood-account/poll-run-start. This is a snapshot at
  // page-load time (no client polling), so a run that's still going
  // when you refresh shows as running; it won't flip to "finished" on
  // its own until you reload.
  if (run.runFinishedAt === null) {
    return (
      <span className="inline-flex items-center gap-1.5">
        <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-sky-500" />
        <span className="text-muted-foreground">
          {label}: running since {fmtTime(run.runStartedAt)}
        </span>
      </span>
    );
  }
  const stale = isStale(run.runStartedAt);
  const dotColor = !run.ok ? "bg-rose-500" : stale ? "bg-amber-500" : "bg-emerald-500";
  const summary = !run.ok
    ? `failed${run.errors?.[0] ? ` — ${run.errors[0].slice(0, 90)}` : ""}`
    : run.fillsCreated > 0
      ? `${run.fillsCreated} fill${run.fillsCreated === 1 ? "" : "s"} imported`
      : "no new fills";
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotColor}`} />
      <span className="text-muted-foreground">
        {label}: {fmtTime(run.runStartedAt)}, {summary}
        {stale && " · stale"}
      </span>
    </span>
  );
}

export function CourierStatusLine() {
  const [data, setData] = useState<CourierStatusResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch("/api/positions/courier-status", { cache: "no-store" });
        if (!res.ok || cancelled) return;
        const json = (await res.json()) as CourierStatusResponse;
        if (!cancelled) setData(json);
      } catch {
        /* network blip — silent; informational only */
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!data) return null;

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-1 text-sm">
      <StatusItem label="Schwab" run={latestOf([data.schwab, data.schwab2])} />
      <StatusItem label="Robinhood" run={data.robinhood} />
    </div>
  );
}

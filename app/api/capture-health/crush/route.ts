import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { requireAdmin, authErrorResponse } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// GET /api/capture-health/crush
//
// Health for the T0/T1 IV-crush earnings_history actual-move pipeline
// (captureEarningsT0/T1, lib/encyclopedia.ts) — deliberately a SEPARATE
// endpoint from /api/capture-health, which tracks a different mechanism
// entirely (the local full-chain Parquet capture, capture_phase='daily').
// A 2026-08-11 audit found the dashboard banner showing that OTHER
// pipeline's health while this one — the one that actually determines
// whether actual_move_pct gets written — had zero presence anywhere.
// Reads capture_phase IN ('crush-t0','crush-t1'), written by
// runT0Capture/runT1Capture (lib/earnings-capture.ts) — distinct labels
// from the 't0'/'t1' phases scripts/capture-t0-t1-chain-detail.ts
// already uses for yet a THIRD, unrelated chain-detail mechanism.
type HealthRow = {
  capture_date: string;
  capture_phase: string;
  due: number;
  fired: number;
  errored: number;
  schwab_disconnected: number;
  outstanding: Array<{ symbol: string; earnings_date: string | null }>;
  run_started_at: string | null;
  run_finished_at: string | null;
};

type PendingRow = {
  symbol: string;
  earnings_date: string;
  iv_before: number | null;
  t1_last_attempt_at: string | null;
  t1_last_failure_reason: string | null;
};

type UnrecoverableRow = {
  symbol: string;
  earnings_date: string;
  t1_unrecoverable_reason: string | null;
};

type AttemptRow = {
  symbol: string;
  earnings_date: string;
  outcome: string;
};

function isBday(iso: string): boolean {
  const day = new Date(iso + "T00:00:00Z").getUTCDay();
  return day !== 0 && day !== 6;
}
function addCalDays(iso: string, n: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function todayEasternIso(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export async function GET(): Promise<NextResponse> {
  try {
    await requireAdmin();
  } catch (e) {
    return authErrorResponse(e);
  }

  const sb = createServerClient();
  const todayEt = todayEasternIso();
  const since14 = addCalDays(todayEt, -14);
  // Wider than the 10-day T1_RETRY_CUTOFF_DAYS so a row still shows as
  // "pending" for a day or two after it would age out, rather than
  // vanishing from view the instant the next sweep marks it — the
  // unrecoverable list below picks it up from that point on.
  const since30 = addCalDays(todayEt, -30);

  const [t0Res, t1Res, pendingRawRes, unrecoverableRes, attemptsRes] = await Promise.all([
    sb
      .from("capture_health_daily")
      .select("*")
      .eq("capture_phase", "crush-t0")
      .gte("capture_date", since14)
      .lte("capture_date", todayEt)
      .order("capture_date", { ascending: false }),
    sb
      .from("capture_health_daily")
      .select("*")
      .eq("capture_phase", "crush-t1")
      .gte("capture_date", since14)
      .lte("capture_date", todayEt)
      .order("capture_date", { ascending: false }),
    // Bounded by earnings_date, not left unbounded — see
    // lib/earnings-capture-attempts.ts's markT1RowsUnrecoverable comment
    // for why an unbounded iv_after-IS-NULL query silently truncates at
    // the custom Supabase wrapper's ~1000-row cap on an unordered result.
    sb
      .from("earnings_history")
      .select("symbol,earnings_date,iv_before,t1_last_attempt_at,t1_last_failure_reason")
      .is("iv_after", null)
      .eq("t1_unrecoverable", false)
      .gte("earnings_date", since30)
      .lte("earnings_date", todayEt),
    sb
      .from("earnings_history")
      .select("symbol,earnings_date,t1_unrecoverable_reason")
      .eq("t1_unrecoverable", true)
      .gte("earnings_date", since30)
      .order("earnings_date", { ascending: false }),
    sb
      .from("earnings_capture_attempts")
      .select("symbol,earnings_date,outcome")
      .eq("capture_phase", "t1")
      .gte("earnings_date", since30),
  ]);

  if (t0Res.error) return NextResponse.json({ error: t0Res.error.message }, { status: 500 });
  if (t1Res.error) return NextResponse.json({ error: t1Res.error.message }, { status: 500 });
  if (pendingRawRes.error) return NextResponse.json({ error: pendingRawRes.error.message }, { status: 500 });
  if (unrecoverableRes.error) return NextResponse.json({ error: unrecoverableRes.error.message }, { status: 500 });
  if (attemptsRes.error) return NextResponse.json({ error: attemptsRes.error.message }, { status: 500 });

  const t0Rows = (t0Res.data ?? []) as HealthRow[];
  const t1Rows = (t1Res.data ?? []) as HealthRow[];
  const t0ByDate = new Map(t0Rows.map((r) => [r.capture_date, r]));
  const t1ByDate = new Map(t1Rows.map((r) => [r.capture_date, r]));

  // "ran and found nothing to do" (due=0) vs "ran and failed" (due>0,
  // failures>0) vs "did not run" (no rollup row at all) — the three
  // states the audit asked this banner distinguish, for the trailing N
  // business days. Weekends are skipped entirely, not counted as
  // "no_run" — the crons only fire weekdays, and PASS 1 of this same
  // audit flagged "are weekends in the denominator" as exactly the
  // phantom-alarm bug to not recreate here.
  // Starts at yesterday, not today — today's run (if any) is surfaced
  // separately via t0.last/t1.last, and a same-day "not yet run" isn't
  // a failure worth counting toward the trailing window.
  function dailyStates(byDate: Map<string, HealthRow>, bdaysWanted: number) {
    const out: Array<{ date: string; state: "no_run" | "ran_nothing_due" | "ran_ok" | "ran_failed"; due: number; fired: number; failed: number }> = [];
    let i = 1;
    // Generous ceiling so a long holiday run can't spin this forever.
    while (out.length < bdaysWanted && i < bdaysWanted * 3 + 10) {
      const d = addCalDays(todayEt, -i);
      i++;
      if (!isBday(d)) continue;
      const row = byDate.get(d);
      if (!row) {
        out.push({ date: d, state: "no_run", due: 0, fired: 0, failed: 0 });
        continue;
      }
      const failed = row.errored + row.schwab_disconnected;
      const state = row.due === 0 ? "ran_nothing_due" : failed > 0 ? "ran_failed" : "ran_ok";
      out.push({ date: d, state, due: row.due, fired: row.fired, failed });
    }
    return out;
  }

  const pendingRaw = (pendingRawRes.data ?? []) as PendingRow[];
  const pending = pendingRaw.filter((r) => r.iv_before !== null); // only real T1 candidates, not T0-less rows

  const attempts = (attemptsRes.data ?? []) as AttemptRow[];
  const attemptCounts = new Map<string, number>();
  for (const a of attempts) {
    const key = `${a.symbol}|${a.earnings_date}`;
    attemptCounts.set(key, (attemptCounts.get(key) ?? 0) + 1);
  }

  const incomplete = pending
    .map((r) => ({
      symbol: r.symbol,
      earningsDate: r.earnings_date,
      attempts: attemptCounts.get(`${r.symbol}|${r.earnings_date}`) ?? 0,
      lastAttemptAt: r.t1_last_attempt_at,
      lastFailureReason: r.t1_last_failure_reason,
    }))
    .sort((a, b) => b.attempts - a.attempts);

  const unrecoverable = ((unrecoverableRes.data ?? []) as UnrecoverableRow[]).map((r) => ({
    symbol: r.symbol,
    earningsDate: r.earnings_date,
    reason: r.t1_unrecoverable_reason,
  }));

  return NextResponse.json({
    todayEt,
    t0: { last: t0Rows[0] ?? null, days: dailyStates(t0ByDate, 7) },
    t1: { last: t1Rows[0] ?? null, days: dailyStates(t1ByDate, 7) },
    incomplete,
    unrecoverable,
  });
}

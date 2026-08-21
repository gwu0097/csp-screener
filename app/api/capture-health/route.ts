import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { requireAdmin, authErrorResponse } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// GET /api/capture-health
//
// Reads capture_health_daily — the small Supabase rollup the local
// capture scripts upsert at the end of every run (see
// lib/capture-health.ts). Deliberately NOT derived from the presence of
// chain data: a day with a rollup row showing due=0 (no earnings that
// day) must look different from a day with NO rollup row at all (the
// scheduled run never fired). That distinction is the entire point of
// this endpoint — it's why the dashboard can't just check "did Parquet
// files show up."
type HealthRow = {
  capture_date: string;
  capture_phase: string;
  due: number;
  fired: number;
  errored: number;
  suppressed: number;
  missed: number;
  schwab_disconnected: number;
  outstanding: Array<{ symbol: string; earnings_date: string | null; trading_day_offset: number | null }>;
  run_started_at: string | null;
  run_finished_at: string | null;
  reconciled_at: string | null;
  updated_at: string;
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
  const since30 = addCalDays(todayEt, -30);

  const res = await sb
    .from("capture_health_daily")
    .select("*")
    .eq("capture_phase", "daily")
    .gte("capture_date", since30)
    .lte("capture_date", todayEt)
    .order("capture_date", { ascending: false });
  if (res.error) {
    return NextResponse.json({ error: res.error.message }, { status: 500 });
  }
  const rows = (res.data ?? []) as HealthRow[];
  const byDate = new Map(rows.map((r) => [r.capture_date, r]));

  const last = rows[0] ?? null;

  // Coverage can only be measured from when the capture job first
  // actually ran. Business days before that predate the feature
  // (capture_health_daily was created by the 2026-08-04 migration) and
  // must NOT count as "missed runs" — otherwise the handful of
  // pre-launch late-July business days with no row keep this panel
  // DEGRADED for a month until they age out of the 30-day window.
  // Anchored to run_started_at (a real run), not mere row presence:
  // some pre-launch days have no row at all even inside
  // reconciliation's backfill reach, so an earliest-row floor wouldn't
  // fully exclude them.
  const trackingStart =
    rows
      .filter((r) => r.run_started_at !== null)
      .map((r) => r.capture_date)
      .sort()[0] ?? null;

  function coverage(days: number) {
    const bdaysInWindow: string[] = [];
    for (let i = 0; i < days; i++) {
      const d = addCalDays(todayEt, -i);
      if (d === todayEt) continue; // today may not have run yet — not a gap
      if (isBday(d) && (!trackingStart || d >= trackingStart)) bdaysInWindow.push(d);
    }
    const zeroRunDates = bdaysInWindow.filter((d) => !byDate.has(d));
    const highFailureDates = bdaysInWindow
      .filter((d) => byDate.has(d))
      .filter((d) => {
        const r = byDate.get(d)!;
        const failed = r.errored + r.schwab_disconnected;
        return r.due > 0 && failed / r.due > 0.1;
      });
    return {
      bdaysChecked: bdaysInWindow.length,
      zeroRunDates,
      highFailureDates,
    };
  }

  const outstandingToday = last && last.capture_date === todayEt ? last.outstanding : [];

  // Warn-only findings from the weekly price-date-mismatch scan (see
  // scripts/detect-price-date-mismatch.ts) — never auto-repaired, just
  // surfaced here so they get seen.
  const priceIntegrityRes = await sb
    .from("price_integrity_flags")
    .select(
      "symbol,earnings_date,stored_price_before,stored_price_after,stored_actual_move_pct,matched_before_date,matched_after_date,gap_from_earnings_days,detected_at",
    )
    .is("resolved_at", null)
    .order("detected_at", { ascending: false });
  const priceIntegrityFlags = (priceIntegrityRes.data ?? []) as Array<{
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

  // Reuse the same live-refresh verify the reconnect banner uses, so
  // this panel's Schwab status matches what the banner would show —
  // one source of truth for "is Schwab actually connected right now."
  let schwabStatus: unknown = null;
  try {
    const { forceRefreshToken } = await import("@/lib/schwab");
    const result = await forceRefreshToken();
    schwabStatus = result.ok
      ? { ok: true, expiresInDays: (new Date(result.newRefreshExpiresAt).getTime() - Date.now()) / 86_400_000 }
      : { ok: false, error: result.error };
  } catch (e) {
    schwabStatus = { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  return NextResponse.json({
    todayEt,
    lastRun: last
      ? {
          captureDate: last.capture_date,
          runStartedAt: last.run_started_at,
          runFinishedAt: last.run_finished_at,
          due: last.due,
          fired: last.fired,
          errored: last.errored,
          suppressed: last.suppressed,
          missed: last.missed,
          schwabDisconnected: last.schwab_disconnected,
          reconciledAt: last.reconciled_at,
        }
      : null,
    todayHasRun: byDate.has(todayEt),
    outstandingToday,
    coverage7: coverage(7),
    coverage30: coverage(30),
    schwabStatus,
    priceIntegrityFlags,
  });
}

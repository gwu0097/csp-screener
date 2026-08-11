// T0/T1 capture retry backstop — audit trail + unrecoverable-marking for
// the earnings_history actual-move pipeline (captureEarningsT0/T1 in
// lib/encyclopedia.ts). Deliberately separate from lib/capture-health.ts,
// which tracks a DIFFERENT, unrelated pipeline (the local full-chain
// Parquet capture, capture_health_daily/capture_phase='daily') — the
// audit that motivated this file found the dashboard banner conflating
// the two, so this stays its own file with its own table rather than
// reusing that one and repeating the mistake.
//
// Never touches actual_move_pct/move_ratio or any capture calculation —
// those stay exactly as captureEarningsT0/T1 compute them. This module
// only records that an attempt happened and, for T1, ages a row out
// after too many failed days.
import { createServerClient } from "./supabase";

export type CapturePhase = "t0" | "t1";

// How many calendar days past earnings_date a row stays a T1 candidate.
// Was a fixed 4-day window with no retry at all — one Schwab failure
// (chain_fetch_failed / schwab_disconnected / timeout) inside that
// window orphaned the row permanently, confirmed for 27 real rows in
// the 2026-08-11 audit. 10 days gives ~2 weeks of weekday retries
// before giving up for good.
export const T1_RETRY_CUTOFF_DAYS = 10;

function addDaysIso(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Records one attempt (success or failure) — called once per
// captureEarningsT0/T1 call, whatever the outcome. outcome is the same
// string already used elsewhere in this codebase (reason from
// CaptureItem: "chain_fetch_failed", "schwab_disconnected",
// "no_options_data", "no_iv_data", "too_early_capture", "captured" on
// success, etc.) — no new vocabulary invented, just persisted instead of
// only ever reaching a log line.
export async function recordCaptureAttempt(opts: {
  earningsHistoryId: string | null;
  symbol: string;
  earningsDate: string;
  phase: CapturePhase;
  outcome: string;
  errorMessage?: string | null;
}): Promise<void> {
  const sb = createServerClient();
  const ins = await sb.from("earnings_capture_attempts").insert({
    earnings_history_id: opts.earningsHistoryId,
    symbol: opts.symbol.toUpperCase(),
    earnings_date: opts.earningsDate,
    capture_phase: opts.phase,
    outcome: opts.outcome,
    error_message: opts.errorMessage ?? null,
  });
  if (ins.error) {
    console.warn(
      `[earnings-capture-attempts] insert failed for ${opts.symbol}/${opts.earningsDate}/${opts.phase}: ${ins.error.message}`,
    );
  }

  const failureReason = opts.outcome === "captured" ? null : opts.outcome;
  const patch =
    opts.phase === "t1"
      ? { t1_last_attempt_at: new Date().toISOString(), t1_last_failure_reason: failureReason }
      : { t0_last_attempt_at: new Date().toISOString(), t0_last_failure_reason: failureReason };
  const upd = await sb
    .from("earnings_history")
    .update(patch)
    .eq("symbol", opts.symbol.toUpperCase())
    .eq("earnings_date", opts.earningsDate);
  if (upd.error) {
    console.warn(
      `[earnings-capture-attempts] history patch failed for ${opts.symbol}/${opts.earningsDate}/${opts.phase}: ${upd.error.message}`,
    );
  }
}

// Ages out T1 rows that have exceeded the retry cutoff without ever
// completing — the explicit "stop trying, mark it, attach the reason"
// step the audit asked for, so a row that fails forever is visibly
// distinguishable from one that's still being retried, rather than
// sitting silently incomplete. Called once at the start of every
// runT1Capture invocation, before selectT1Candidates() runs, so a row
// aged out THIS run is also excluded from THIS run's candidate list.
//
// Bounded to a 60-day lookback ending at the cutoff — NOT small by
// construction like the comment here used to claim: earnings_history
// has 2500+ rows with iv_after IS NULL going back years (most from
// before this T0/T1 mechanism existed, never had iv_before set either).
// Without a lower bound this query hits the custom Supabase wrapper's
// ~1000-row read cap (lib/supabase.ts — no .not()/.range() support) on
// an UNORDERED result set, so it silently returns an arbitrary page
// that may not even include the rows actually due to be marked —
// confirmed live: an unbounded version of this query returned rows from
// 2025 while missing every 2026-07/08 row it was meant to catch. A
// recurring operational sweep has no reason to keep re-scanning years
// of pre-mechanism history anyway; a one-time historical cleanup, if
// ever wanted, belongs in its own one-off script, not this cron path.
export async function markT1RowsUnrecoverable(
  todayEt: string,
): Promise<Array<{ symbol: string; earnings_date: string; reason: string }>> {
  const sb = createServerClient();
  const cutoff = addDaysIso(todayEt, -T1_RETRY_CUTOFF_DAYS);
  const lookbackFloor = addDaysIso(cutoff, -60);
  const res = await sb
    .from("earnings_history")
    .select("id,symbol,earnings_date,iv_before,t1_last_failure_reason")
    .is("iv_after", null)
    .eq("t1_unrecoverable", false)
    .lt("earnings_date", cutoff)
    .gte("earnings_date", lookbackFloor);
  if (res.error) {
    console.warn(`[earnings-capture-attempts] unrecoverable sweep query failed: ${res.error.message}`);
    return [];
  }
  const rows = (
    (res.data ?? []) as Array<{
      id: string;
      symbol: string;
      earnings_date: string;
      iv_before: number | null;
      t1_last_failure_reason: string | null;
    }>
  ).filter((r) => r.iv_before !== null); // only rows that actually had a T0 and were real T1 candidates

  const marked: Array<{ symbol: string; earnings_date: string; reason: string }> = [];
  for (const r of rows) {
    const reason = r.t1_last_failure_reason ?? "never_attempted";
    const upd = await sb
      .from("earnings_history")
      .update({ t1_unrecoverable: true, t1_unrecoverable_reason: reason })
      .eq("id", r.id);
    if (upd.error) {
      console.warn(`[earnings-capture-attempts] unrecoverable mark failed for ${r.symbol}/${r.earnings_date}: ${upd.error.message}`);
      continue;
    }
    marked.push({ symbol: r.symbol, earnings_date: r.earnings_date, reason });
  }
  return marked;
}

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

// em-seed / eps-sweep (lib/em-universe-seed.ts, lib/eps-sweep.ts) are
// NOT T0/T1 capture phases — neither one calls Schwab or performs a
// T0/T1 capture, so they must never patch t0_*/t1_* bookkeeping columns
// (recordCaptureAttempt below does that unconditionally, keyed only on
// "t1" vs "everything else"). Logged through the same table anyway, per
// the capture-attempts audit's own principle: a symbol failing
// repeatedly should be visible, not silent.
export type AncillaryPhase = "em-seed" | "eps-sweep";

// Insert-only counterpart to recordCaptureAttempt — no earnings_history
// patch, so it's safe for phases that aren't a T0/T1 capture.
export async function recordAncillaryAttempt(opts: {
  earningsHistoryId: string | null;
  symbol: string;
  earningsDate: string;
  phase: AncillaryPhase;
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
}

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

// N consecutive too_early_capture outcomes that never once cross to
// iv_after < iv_before (iv_crush_magnitude stays negative every time),
// spanning at least 2 distinct ET sessions, is what a corrupted T0
// baseline produces: iv_before was measured too early/off the wrong
// contract, so it undercounts the true pre-earnings IV, and every live
// iv_after read since keeps landing above it. A genuine too-early
// capture doesn't have that property — its magnitude drifts toward
// zero and then positive as the crush settles in from one session to
// the next, so it doesn't stay on the wrong side of zero for days.
//
// This replaced an earlier "materially the same magnitude across
// attempts" check (matching within 0.001) that could never fire:
// iv_after is a live quote, so the magnitude moves every attempt by
// construction — two independent live reads landing within 0.001 of
// each other never happens whether the baseline is good or corrupted.
// Confirmed live: CPRT (2026-09-02) ran 12 too_early_capture attempts
// over 6 days, all magnitude negative (-0.12 to -0.33), no two ever
// within 0.001 — the old check never fired for it. TECH's one existing
// corrupted_t0_baseline row (2026-08-11) predates this function
// entirely; it was hand-set via scripts/scratchpad fix-tech.sql before
// checkAndMarkCorruptedBaseline shipped (2026-08-13), so it isn't
// evidence the old check ever fired either — this detector has never
// actually caught a row in production.
export const CORRUPTED_BASELINE_CONSECUTIVE_THRESHOLD = 3;

// A negative iv_crush_magnitude means iv_after read ABOVE iv_before —
// structurally impossible for a genuine crush that just hasn't
// finished settling (that case bottoms out near zero, not below it).
// -0.02 sits comfortably past ordinary live-quote noise around zero so
// a magnitude that's negative only by a hair doesn't trip this.
export const CORRUPTED_BASELINE_NEGATIVE_FLOOR = -0.02;

function etSessionDate(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

// Shared predicate: given the most recent CORRUPTED_BASELINE_CONSECUTIVE_THRESHOLD
// t1 attempts for a row (ordered newest-first), are they all
// too_early_capture with a magnitude below the negative floor, spanning
// 2+ ET sessions? Used both live (checkAndMarkCorruptedBaseline, with
// the in-flight attempt prepended since it isn't recorded yet) and
// retroactively (markT1RowsUnrecoverable, over already-recorded rows).
function isPersistentNegativeMagnitude(
  rows: Array<{ outcome: string; error_message: string | null; attempted_at: string }>,
): boolean {
  if (rows.length < CORRUPTED_BASELINE_CONSECUTIVE_THRESHOLD) return false;
  const recent = rows.slice(0, CORRUPTED_BASELINE_CONSECUTIVE_THRESHOLD);
  if (!recent.every((r) => r.outcome === "too_early_capture")) return false;
  const magnitudes = recent.map((r) => (r.error_message !== null ? Number(r.error_message) : NaN));
  if (magnitudes.some((m) => !Number.isFinite(m))) return false;
  if (!magnitudes.every((m) => m < CORRUPTED_BASELINE_NEGATIVE_FLOOR)) return false;
  const sessions = new Set(recent.map((r) => etSessionDate(r.attempted_at)));
  return sessions.size >= 2;
}

// Called from inside captureEarningsT1's too_early_capture branch
// (lib/encyclopedia.ts), before it returns to its caller. Looks at the
// last CORRUPTED_BASELINE_CONSECUTIVE_THRESHOLD-1 recorded t1 attempts
// for this row; if together with the attempt happening right now they
// show persistent negative magnitude (see isPersistentNegativeMagnitude
// above), marks the row unrecoverable with the accurate reason instead
// of leaving it to retry under the generic label. Deliberately does NOT
// null iv_before the way the one-off manual fix for TECH did — this
// keeps the corrupted value visible for diagnosis; t1_unrecoverable=true
// alone is what stops retries (selectT1Candidates filters on it,
// lib/encyclopedia.ts:2547) and excludes the row downstream.
export async function checkAndMarkCorruptedBaseline(opts: {
  symbol: string;
  earningsDate: string;
  currentMagnitude: number;
}): Promise<{ marked: boolean }> {
  const sb = createServerClient();
  const priorCount = CORRUPTED_BASELINE_CONSECUTIVE_THRESHOLD - 1;
  const res = await sb
    .from("earnings_capture_attempts")
    .select("outcome,error_message,attempted_at")
    .eq("symbol", opts.symbol.toUpperCase())
    .eq("earnings_date", opts.earningsDate)
    .eq("capture_phase", "t1")
    .order("attempted_at", { ascending: false })
    .limit(priorCount);
  if (res.error) {
    console.warn(
      `[earnings-capture-attempts] corrupted-baseline check failed for ${opts.symbol}/${opts.earningsDate}: ${res.error.message}`,
    );
    return { marked: false };
  }
  const priorRows = (res.data ?? []) as Array<{ outcome: string; error_message: string | null; attempted_at: string }>;
  const currentRow = {
    outcome: "too_early_capture",
    error_message: String(opts.currentMagnitude),
    attempted_at: new Date().toISOString(),
  };
  if (!isPersistentNegativeMagnitude([currentRow, ...priorRows])) return { marked: false };

  const upd = await sb
    .from("earnings_history")
    .update({ t1_unrecoverable: true, t1_unrecoverable_reason: "corrupted_t0_baseline" })
    .eq("symbol", opts.symbol.toUpperCase())
    .eq("earnings_date", opts.earningsDate);
  if (upd.error) {
    console.warn(
      `[earnings-capture-attempts] corrupted-baseline mark failed for ${opts.symbol}/${opts.earningsDate}: ${upd.error.message}`,
    );
    return { marked: false };
  }
  return { marked: true };
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
    let reason = r.t1_last_failure_reason ?? "never_attempted";
    // A row aging out under the generic too_early_capture label may
    // actually be a corrupted baseline that checkAndMarkCorruptedBaseline
    // should have already caught mid-flight (see its comment) — but
    // didn't, e.g. because an unrelated outcome (invalid_volatility_quote,
    // schwab_disconnected, ...) fell inside the most recent N attempts
    // and broke the required run of too_early_capture outcomes. Re-check
    // the same negative-magnitude signal here so the reason recorded at
    // cutoff still points a future reader at the baseline instead of
    // implying "just needed more retries."
    if (reason === "too_early_capture") {
      const attempts = await sb
        .from("earnings_capture_attempts")
        .select("outcome,error_message,attempted_at")
        .eq("symbol", r.symbol)
        .eq("earnings_date", r.earnings_date)
        .eq("capture_phase", "t1")
        .order("attempted_at", { ascending: false })
        .limit(CORRUPTED_BASELINE_CONSECUTIVE_THRESHOLD);
      if (attempts.error) {
        console.warn(
          `[earnings-capture-attempts] cutoff negative-magnitude check failed for ${r.symbol}/${r.earnings_date}: ${attempts.error.message}`,
        );
      } else if (
        isPersistentNegativeMagnitude(
          (attempts.data ?? []) as Array<{ outcome: string; error_message: string | null; attempted_at: string }>,
        )
      ) {
        reason = "t1_exhausted_negative_magnitude_suspect_baseline";
      }
    }
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

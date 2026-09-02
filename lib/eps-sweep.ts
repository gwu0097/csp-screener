// Scheduled eps_surprise_pct backfill sweep.
//
// eps_surprise_pct is currently written only inside updateEncyclopedia,
// which ALSO calls Yahoo price-action and fetchImpliedMove (a second,
// uncoordinated Schwab path outside the T0/T1 budget/guard discipline).
// Triggering that whole function on a schedule would duplicate the
// em-universe-seed job's Schwab-capture responsibility and add an
// unbudgeted Schwab call. This sweep instead calls fetchFinnhubEarnings
// directly (Finnhub-only, already rate-paced internally via
// FINNHUB_RATE_DELAY_MS) and writes only eps_estimate/eps_actual/
// eps_surprise_pct via the same pctChange() formula updateEncyclopedia
// uses — same computation, narrower trigger.
//
// No pre-print timing constraint (backward-looking, Finnhub-sourced) —
// this can and does run any time after the print, unlike em-universe-seed.
//
// Row selection is two branches, not one (2026-09-04 retry fix):
//   1. Recent (earnings_date within T1_RETRY_CUTOFF_DAYS) — the
//      original T0/T1-adjacent "catch it soon after the print" case.
//   2. Backlog (earnings_date older than that) — rows whose
//      fiscal_quarter was null at the time they aged out of branch 1,
//      then got backfilled later by the EDGAR fiscal-period resolver.
//      Bounding branch 2 by earnings_date the same way branch 1 is
//      would defeat its own purpose: a 10-Q/10-K can land well past 10
//      days after earnings_date (up to the 40/45-day statutory
//      deadline), so by the time fiscal_quarter is actually known, the
//      row has long since aged out of any earnings_date-bound query.
//      Without branch 2, EVERY quarter's freshest rows pass through the
//      exact same unprotected window this repair just closed, and the
//      backlog rebuilds itself. Branch 2 is instead throttled by
//      RETRY_THROTTLE_DAYS — how long since eps-sweep itself last
//      looked at this specific row — via earnings_capture_attempts,
//      not by how old the row is. See RETRY_THROTTLE_DAYS below for why
//      7, not the 45-60 days that bounds the EDGAR resolver itself.
import { fetchFinnhubEarnings, pctChange } from "./encyclopedia";
import { recordAncillaryAttempt, T1_RETRY_CUTOFF_DAYS } from "./earnings-capture-attempts";
import { createServerClient } from "./supabase";

const SWEEP_BUDGET_MS = 50_000;

// Throttles branch 2 (backlog) retries — distinct from, and much
// shorter than, the ~45-60 day window that bounds the EDGAR
// fiscal-period resolver itself (that one is bounded by the SEC 10-Q
// filing deadline: how long fiscal_quarter can plausibly take to
// become knowable at all). This one is a pure efficiency throttle: once
// fiscal_quarter DOES land, matching against Finnhub is a cheap,
// deterministic lookup, so there's no reason for a row to wait a month
// to be picked up. 7 days keeps a stuck row from being re-queried
// against Finnhub daily forever (wasteful once "still no match" is
// established), while still closing the loop within about a week of
// fiscal_quarter actually landing — a full order of magnitude tighter
// than the resolver's own give-up horizon, because retrying a resolved
// case is cheap and re-attempting an unresolved one gains nothing by
// waiting longer than this.
const RETRY_THROTTLE_DAYS = 7;

// Finnhub free-tier /stock/earnings returns the 4 most recent quarters
// regardless of the requested window — a wide window here just ensures
// the requested range doesn't itself exclude the row client-side.
const FINNHUB_LOOKBACK_DAYS = 730;

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}
function addDaysIso(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

type Candidate = {
  id: string;
  symbol: string;
  earnings_date: string;
  fiscal_quarter: number | null;
  fiscal_year: number | null;
  period_end: string | null;
};

export type EpsSweepReport = {
  ok: boolean;
  dryRun: boolean;
  candidates: number;
  captured: Array<{ symbol: string; earnings_date: string; eps_surprise_pct: number | null }>;
  skipped: Array<{ symbol: string; earnings_date: string; reason: string }>;
  errors: Array<{ symbol: string; earnings_date: string; reason: string }>;
  budget_exhausted: boolean;
};

export async function runEpsSweep(opts?: { dryRun?: boolean }): Promise<EpsSweepReport> {
  const dryRun = opts?.dryRun === true;
  const startedAt = Date.now();
  const today = todayIso();
  const windowStart = addDaysIso(today, -T1_RETRY_CUTOFF_DAYS);

  const report: EpsSweepReport = {
    ok: true,
    dryRun,
    candidates: 0,
    captured: [],
    skipped: [],
    errors: [],
    budget_exhausted: false,
  };

  const sb = createServerClient();
  const cols = "id,symbol,earnings_date,fiscal_quarter,fiscal_year,period_end,eps_surprise_pct,implied_move_source";

  // Branch 1: recent, as before.
  const recentRes = await sb
    .from("earnings_history")
    .select(cols)
    .gte("earnings_date", windowStart)
    .lte("earnings_date", today)
    .is("eps_surprise_pct", null);
  if (recentRes.error) {
    report.ok = false;
    report.errors.push({ symbol: "", earnings_date: "", reason: `query failed: ${recentRes.error.message}` });
    return report;
  }

  // Branch 2: backlog — earnings_date older than the recent window,
  // eps_surprise_pct still null. Not bounded by earnings_date at all;
  // Finnhub's own data availability (via the exact-match logic below)
  // is the natural limiter on whether a match can succeed, and
  // RETRY_THROTTLE_DAYS below is the limiter on how often a given row
  // gets re-attempted.
  const backlogRes = await sb
    .from("earnings_history")
    .select(cols)
    .lt("earnings_date", windowStart)
    .is("eps_surprise_pct", null);
  if (backlogRes.error) {
    report.ok = false;
    report.errors.push({ symbol: "", earnings_date: "", reason: `backlog query failed: ${backlogRes.error.message}` });
    return report;
  }
  type RawRow = Candidate & { implied_move_source: string | null };
  const backlogCandidates = (backlogRes.data ?? []) as RawRow[];

  let backlogRows: RawRow[] = [];
  if (backlogCandidates.length > 0) {
    const throttleCutoff = new Date(Date.now() - RETRY_THROTTLE_DAYS * 86_400_000).toISOString();
    const attemptsRes = await sb
      .from("earnings_capture_attempts")
      .select("earnings_history_id")
      .in("earnings_history_id", backlogCandidates.map((r) => r.id))
      .eq("capture_phase", "eps-sweep")
      .gte("attempted_at", throttleCutoff);
    const recentlyAttempted = new Set(
      ((attemptsRes.data ?? []) as Array<{ earnings_history_id: string }>).map((a) => a.earnings_history_id),
    );
    backlogRows = backlogCandidates.filter((r) => !recentlyAttempted.has(r.id));
  }

  const rows = ([...((recentRes.data ?? []) as RawRow[]), ...backlogRows]).filter(
    // Manual-row guard: 'manual' means "hands off this row from any
    // automated writer" everywhere else in this pipeline (T0/T1 both
    // skip the whole row, not just the implied-move field) — same rule
    // applied here for consistency, not just for the EM field.
    (r) => r.implied_move_source !== "manual",
  );
  report.candidates = rows.length;

  for (const row of rows) {
    if (Date.now() - startedAt > SWEEP_BUDGET_MS) {
      report.budget_exhausted = true;
      break;
    }
    const symbol = row.symbol.toUpperCase();
    try {
      // to=today (not a future bound) silently dropped exactly the
      // candidates this sweep exists to find — confirmed live
      // (2026-09-04): fetchFinnhubEarnings's own `period <= to` filter
      // discarded CRM's correct Finnhub row because Finnhub's period
      // label for it (2026-09-30) sits after "today" even though the
      // real quarter was reported weeks earlier. Finnhub's period label
      // is not a reliable date — that's the whole reason this sweep now
      // matches by fiscal_quarter+fiscal_year instead of by date at
      // all. A generous future bound here costs nothing: the exact-
      // match logic below is what actually gates correctness, not this
      // window.
      const finnhubRows = await fetchFinnhubEarnings(
        symbol,
        addDaysIso(today, -FINNHUB_LOOKBACK_DAYS),
        addDaysIso(today, 120),
      );
      if (finnhubRows.length === 0) {
        report.skipped.push({ symbol, earnings_date: row.earnings_date, reason: "finnhub_empty" });
        if (!dryRun) {
          await recordAncillaryAttempt({
            earningsHistoryId: row.id,
            symbol,
            earningsDate: row.earnings_date,
            phase: "eps-sweep",
            outcome: "finnhub_empty",
          }).catch(() => {});
        }
        continue;
      }

      // Finnhub rows are keyed by fiscal period (quarter-end), this row
      // by announcement date — match ONLY on fiscal identifiers already
      // stamped on the row: fiscal_quarter+fiscal_year first, else an
      // exact period_end match. No proximity/date-based fallback.
      //
      // A "nearest preceding period <= earnings_date" fallback lived
      // here until a 2026-09-04 audit found it silently writing the
      // WRONG quarter's actual onto the row: Finnhub's own period label
      // for the correct just-reported quarter frequently falls AFTER
      // earnings_date (confirmed for CRM, DELL, MRVL, MDB — a 4-for-4
      // reproduction, not an edge case), so "preceding" reliably grabbed
      // the PRIOR quarter instead. On RKLB it went further: the estimate
      // matched the right quarter while the actual silently landed from
      // a different, older one on the same row — flipping the sign of
      // the surprise (stored: +60.8% beat; real: a miss). A wrong number
      // reads as real data and poisons every downstream read; a null
      // one is visibly incomplete and self-heals once fiscal_quarter is
      // backfilled (see the accompanying repair plan). When neither
      // identifier resolves, skip and log why rather than guess.
      let match: (typeof finnhubRows)[number] | null = null;
      if (row.fiscal_quarter !== null && row.fiscal_year !== null) {
        match =
          finnhubRows.find((r) => r.quarter === row.fiscal_quarter && r.year === row.fiscal_year) ??
          null;
      }
      if (!match && row.period_end !== null) {
        match = finnhubRows.find((r) => r.period === row.period_end) ?? null;
      }

      if (!match) {
        const reason =
          row.fiscal_quarter === null && row.period_end === null
            ? "no_fiscal_identifiers"
            : "no_period_match";
        report.skipped.push({ symbol, earnings_date: row.earnings_date, reason });
        if (!dryRun) {
          await recordAncillaryAttempt({
            earningsHistoryId: row.id,
            symbol,
            earningsDate: row.earnings_date,
            phase: "eps-sweep",
            outcome: reason,
          }).catch(() => {});
        }
        continue;
      }

      const eps_surprise_pct = pctChange(match.actual, match.estimate);
      if (!dryRun) {
        const upd = await sb
          .from("earnings_history")
          .update({
            eps_estimate: match.estimate,
            eps_actual: match.actual,
            eps_surprise_pct,
          })
          .eq("id", row.id);
        if (upd.error) throw new Error(upd.error.message);
      }
      report.captured.push({ symbol, earnings_date: row.earnings_date, eps_surprise_pct });
      if (!dryRun) {
        await recordAncillaryAttempt({
          earningsHistoryId: row.id,
          symbol,
          earningsDate: row.earnings_date,
          phase: "eps-sweep",
          outcome: "captured",
        }).catch(() => {});
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      report.errors.push({ symbol, earnings_date: row.earnings_date, reason: message });
      if (!dryRun) {
        await recordAncillaryAttempt({
          earningsHistoryId: row.id,
          symbol,
          earningsDate: row.earnings_date,
          phase: "eps-sweep",
          outcome: "error",
          errorMessage: message,
        }).catch(() => {});
      }
    }
  }

  return report;
}

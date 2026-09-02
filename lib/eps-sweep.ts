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
import { fetchFinnhubEarnings, pctChange } from "./encyclopedia";
import { recordAncillaryAttempt, T1_RETRY_CUTOFF_DAYS } from "./earnings-capture-attempts";
import { createServerClient } from "./supabase";

const SWEEP_BUDGET_MS = 50_000;

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
  const res = await sb
    .from("earnings_history")
    .select("id,symbol,earnings_date,fiscal_quarter,fiscal_year,period_end,eps_surprise_pct,implied_move_source")
    .gte("earnings_date", windowStart)
    .lte("earnings_date", today)
    .is("eps_surprise_pct", null);
  if (res.error) {
    report.ok = false;
    report.errors.push({ symbol: "", earnings_date: "", reason: `query failed: ${res.error.message}` });
    return report;
  }

  const rows = ((res.data ?? []) as Array<Candidate & { implied_move_source: string | null }>).filter(
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
      const finnhubRows = await fetchFinnhubEarnings(
        symbol,
        addDaysIso(today, -FINNHUB_LOOKBACK_DAYS),
        today,
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

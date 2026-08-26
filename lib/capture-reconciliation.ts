// Retroactive gap detection for the daily post-earnings chain capture.
// Runs at the start of each day's main invocation (not the same-day
// retry pass — see --skip-reconcile in the runner script), looking back
// over capture_health_daily for recent business days:
//   - no rollup row at all for a date => the scheduled run never fired
//     (or died before writing anything) — Discord alert + MISSED rows
//     for that date's full due set.
//   - a rollup row with a non-empty `outstanding` list => the run fired
//     but some symbols never reached fired/suppressed — MISSED rows for
//     just those symbols.
// Scoped to the "daily" phase only: T0/T1's due-set is inherently
// just-in-time (selectT0Candidates/selectT1Candidates compute against
// "today"), so there's no well-defined past due-set to recompute for a
// prior date the way there is for daily's fixed T+1..T+20 window.
import { createServerClient } from "./supabase";
import { writeOutcomeChunk, type OutcomeRow } from "./local-chain-store";
import { sendDiscordAlert } from "./discord-alert";
import { upsertHealthRollup, type CaptureHealthDailyRow, type OutstandingSymbol } from "./capture-health";

const LOOKBACK_DAYS = 5;

function isBday(d: Date): boolean {
  const day = d.getUTCDay();
  return day !== 0 && day !== 6;
}
function addBdays(iso: string, n: number): string {
  const d = new Date(iso + "T00:00:00Z");
  let remaining = Math.abs(n);
  const step = n >= 0 ? 1 : -1;
  while (remaining > 0) {
    d.setUTCDate(d.getUTCDate() + step);
    if (isBday(d)) remaining -= 1;
  }
  return d.toISOString().slice(0, 10);
}
function bdayOffset(anchor: string, target: string): number {
  if (target === anchor) return 0;
  const forward = target > anchor;
  let cur = anchor;
  let offset = 0;
  while (cur !== target) {
    cur = addBdays(cur, forward ? 1 : -1);
    offset += forward ? 1 : -1;
    if (Math.abs(offset) > 40) return NaN;
  }
  return offset;
}
function addCalDays(iso: string, n: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

type DueRow = { symbol: string; earnings_date: string; earnings_history_id: string | null; trading_day_offset: number };

async function computeDueForDate(
  sb: ReturnType<typeof createServerClient>,
  captureDate: string,
): Promise<DueRow[]> {
  const lowerBound = addBdays(captureDate, -30);
  const raw = await sb
    .from("earnings_history")
    .select("id,symbol,earnings_date")
    // Was .eq("date_confidence", "confirmed") before the 2026-08-19
    // provenance migration retired that value. 'confirmed' was always
    // just "nothing downgraded it" (the column's own silent default,
    // not real evidence) — excluding only 'inferred' (successor to the
    // old 'low') reproduces the exact same row set post-migration,
    // since 'low'/'inferred' was the only value this filter ever meant
    // to exclude.
    .neq("date_confidence", "inferred")
    .gte("earnings_date", lowerBound)
    .lte("earnings_date", captureDate);
  const rows = (raw.data ?? []) as Array<{ id: string; symbol: string; earnings_date: string }>;
  const due: DueRow[] = [];
  for (const r of rows) {
    const offset = bdayOffset(r.earnings_date, captureDate);
    if (offset >= 1 && offset <= 20) {
      due.push({
        symbol: r.symbol.toUpperCase(),
        earnings_date: r.earnings_date,
        earnings_history_id: r.id,
        trading_day_offset: offset,
      });
    }
  }
  return due;
}

export type ReconciliationReport = {
  checkedDates: string[];
  neverFiredDates: string[];
  partialDates: string[];
  missedRowsWritten: number;
};

export async function reconcileMissedCaptures(
  todayIso: string,
  opts?: { lookbackDays?: number; dryRun?: boolean },
): Promise<ReconciliationReport> {
  const dryRun = opts?.dryRun === true;
  const lookback = opts?.lookbackDays ?? LOOKBACK_DAYS;
  const sb = createServerClient();
  const report: ReconciliationReport = {
    checkedDates: [],
    neverFiredDates: [],
    partialDates: [],
    missedRowsWritten: 0,
  };

  for (let i = 1; i <= lookback; i++) {
    const dateIso = addCalDays(todayIso, -i);
    if (!isBday(new Date(dateIso + "T00:00:00Z"))) continue; // no run was ever scheduled on a weekend
    report.checkedDates.push(dateIso);

    const rowRes = await sb
      .from("capture_health_daily")
      .select("*")
      .eq("capture_date", dateIso)
      .eq("capture_phase", "daily")
      .maybeSingle();
    const healthRow = rowRes.data as CaptureHealthDailyRow | null;
    const now = new Date().toISOString();

    if (!healthRow) {
      const due = await computeDueForDate(sb, dateIso);
      report.neverFiredDates.push(dateIso);
      if (due.length > 0) {
        const missedRows: OutcomeRow[] = due.map((c) => ({
          symbol: c.symbol,
          earnings_history_id: c.earnings_history_id,
          earnings_date: c.earnings_date,
          capture_phase: "daily",
          trading_day_offset: c.trading_day_offset,
          capture_date: dateIso,
          outcome: "missed",
          error_message: "reconciliation: no run recorded for this date",
          strikes_written: 0,
          attempts: 0,
          recorded_at: now,
        }));
        if (!dryRun) {
          await writeOutcomeChunk(missedRows, "daily", now, dateIso, 9000 + i);
          report.missedRowsWritten += missedRows.length;
          const outstanding: OutstandingSymbol[] = [];
          await upsertHealthRollup(dateIso, "daily", {
            due: due.length,
            fired: 0,
            errored: 0,
            suppressed: 0,
            missed: due.length,
            schwab_disconnected: 0,
            outstanding,
            run_started_at: null,
            run_finished_at: null,
            reconciled_at: now,
          });
        }
      }
      if (!dryRun) {
        await sendDiscordAlert(
          `🔴 Post-earnings capture: NO RUN recorded for ${dateIso} (found during reconciliation on ${todayIso}). ` +
            `${due.length} symbols were due and got MISSED rows.`,
        );
      }
    } else if (Array.isArray(healthRow.outstanding) && healthRow.outstanding.length > 0) {
      report.partialDates.push(dateIso);
      const missedRows: OutcomeRow[] = healthRow.outstanding.map((o) => ({
        symbol: o.symbol,
        earnings_history_id: o.earnings_history_id ?? null,
        earnings_date: o.earnings_date ?? null,
        capture_phase: "daily",
        trading_day_offset: o.trading_day_offset ?? null,
        capture_date: dateIso,
        outcome: "missed",
        error_message: "reconciliation: never reached a terminal fired/suppressed outcome",
        strikes_written: 0,
        attempts: 0,
        recorded_at: now,
      }));
      if (!dryRun) {
        await writeOutcomeChunk(missedRows, "daily", now, dateIso, 9000 + i);
        report.missedRowsWritten += missedRows.length;
        await upsertHealthRollup(dateIso, "daily", {
          missed: (healthRow.missed ?? 0) + missedRows.length,
          outstanding: [],
          reconciled_at: now,
        });
      }
    }
  }
  return report;
}

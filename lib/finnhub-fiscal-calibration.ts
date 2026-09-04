// Per-symbol calibration translating Finnhub's synthetic fiscal
// quarter/year labels back to the issuer's real ones — see
// migrations/2026-09-05-finnhub-fiscal-label-calibration.sql for the
// full "why" (BOX/HD/LOW/TGT/ULTA/WSM all shift quarter-1/year+1; DG
// shifts quarter-unchanged/year+1 — two different transforms among
// closely comparable off-calendar-FY companies, which is why this is
// a per-symbol lookup, not a formula).
//
// Lazily populated (see scripts/calibrate-fiscal-label.ts) — this file
// only reads and maintains existing calibrations, it never creates one
// from a formula.
import { createServerClient } from "./supabase";

export type FiscalLabelCalibration = {
  id: string;
  symbol: string;
  quarterDelta: number;
  yearDelta: number;
  periodDeltaDays: number | null;
  confirmedCount: number;
};

// The active calibration for a symbol is its latest non-invalidated
// row. Returns null if none exists — the normal case for the ~148
// off-calendar-FY symbols that haven't been audited yet, and the
// intended behavior for every symbol until this is deliberately
// populated (see the migration's "never pre-calibrated in bulk" note).
export async function getActiveCalibration(symbol: string): Promise<FiscalLabelCalibration | null> {
  const sb = createServerClient();
  const res = await sb
    .from("finnhub_fiscal_label_calibration")
    .select("id,symbol,quarter_delta,year_delta,period_delta_days,confirmed_count")
    .eq("symbol", symbol.toUpperCase())
    .is("invalidated_at", null)
    .order("calibrated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (res.error || !res.data) return null;
  const row = res.data as {
    id: string;
    symbol: string;
    quarter_delta: number;
    year_delta: number;
    period_delta_days: number | null;
    confirmed_count: number;
  };
  return {
    id: row.id,
    symbol: row.symbol,
    quarterDelta: row.quarter_delta,
    yearDelta: row.year_delta,
    periodDeltaDays: row.period_delta_days,
    confirmedCount: row.confirmed_count,
  };
}

// Called once a predicted label is confirmed against Finnhub's actual
// response — grows confirmed_count in place (bookkeeping on the SAME
// calibration event, not a new one; see the migration comment on what
// counts as "append-only" here).
export async function bumpCalibrationConfirmed(calibrationId: string, confirmedRowId: string): Promise<void> {
  const sb = createServerClient();
  const current = await sb
    .from("finnhub_fiscal_label_calibration")
    .select("confirmed_count")
    .eq("id", calibrationId)
    .maybeSingle();
  const confirmedCount = ((current.data as { confirmed_count: number } | null)?.confirmed_count ?? 0) + 1;
  await sb
    .from("finnhub_fiscal_label_calibration")
    .update({
      confirmed_count: confirmedCount,
      last_confirmed_at: new Date().toISOString(),
      last_confirmed_row_id: confirmedRowId,
    })
    .eq("id", calibrationId);
}

// The staleness signal: a predicted label (our fiscal_quarter+
// quarter_delta, fiscal_year+year_delta) wasn't found anywhere in
// Finnhub's actual response. Not a guess — an exact prediction that
// didn't materialize means Finnhub's labeling for this ticker changed.
// Fails closed: once invalidated, getActiveCalibration stops returning
// this row, so the next lookup falls through to the normal (no
// calibration) path rather than continuing to guess with a stale delta.
export async function invalidateCalibration(calibrationId: string, reason: string): Promise<void> {
  const sb = createServerClient();
  await sb
    .from("finnhub_fiscal_label_calibration")
    .update({ invalidated_at: new Date().toISOString(), invalidated_reason: reason })
    .eq("id", calibrationId);
}

// Creates a new calibration from a manually-audited row — always a new
// row, never an edit of an existing one, even when superseding an
// invalidated calibration for the same symbol (preserves the full
// history of what this symbol's calibration used to be).
export async function recordCalibration(opts: {
  symbol: string;
  quarterDelta: number;
  yearDelta: number;
  periodDeltaDays?: number | null;
  calibratedFromId: string;
}): Promise<void> {
  const sb = createServerClient();
  await sb.from("finnhub_fiscal_label_calibration").insert({
    symbol: opts.symbol.toUpperCase(),
    quarter_delta: opts.quarterDelta,
    year_delta: opts.yearDelta,
    period_delta_days: opts.periodDeltaDays ?? null,
    calibrated_from_id: opts.calibratedFromId,
  });
}

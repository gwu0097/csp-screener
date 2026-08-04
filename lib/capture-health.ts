// Small Supabase-backed rollup — one row per (capture_date,
// capture_phase), ~250 rows/year. This is deliberately NOT a mirror of
// every outcome row: that was considered and rejected (unbounded growth
// against the same 500MB-tier concern that moved chain data local in
// the first place). The raw per-symbol detail stays in local Parquet;
// this table carries only the aggregate the Vercel-hosted dashboard
// needs to render capture health, since it can't reach local disk.
import { createServerClient } from "./supabase";

export type OutstandingSymbol = {
  symbol: string;
  earnings_history_id: string | null;
  earnings_date: string | null;
  trading_day_offset: number | null;
};

export type CaptureHealthDailyRow = {
  capture_date: string;
  capture_phase: string;
  due: number;
  fired: number;
  errored: number;
  suppressed: number;
  missed: number;
  schwab_disconnected: number;
  outstanding: OutstandingSymbol[];
  run_started_at: string | null;
  run_finished_at: string | null;
  reconciled_at: string | null;
};

export async function upsertHealthRollup(
  captureDate: string,
  phase: string,
  patch: Partial<Omit<CaptureHealthDailyRow, "capture_date" | "capture_phase">>,
): Promise<void> {
  const sb = createServerClient();
  const res = await sb
    .from("capture_health_daily")
    .upsert(
      { capture_date: captureDate, capture_phase: phase, ...patch },
      { onConflict: "capture_date,capture_phase" },
    );
  if (res.error) {
    console.warn(`[capture-health] rollup upsert failed for ${captureDate}/${phase}:`, res.error.message);
  }
}

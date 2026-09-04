import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { requireAdmin, authErrorResponse } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// GET /api/positions/courier-status
//
// Latest row per broker from schwab_account_poll_runs and
// robinhood_account_poll_runs — the per-run health log both pollers
// already write on every completed run (lib/schwab-account-import.ts,
// lib/robinhood-account-import.ts), plus local-only courier failures
// now logged via /api/robinhood-account/poll-attempt. Read-only
// visibility for the Positions page: "is the courier even running,
// and what did it last do" — see the 2026-09-04 incident where a
// 1:05pm Robinhood run silently never reached the deployed route at
// all, invisible from the app until this existed.
type PollRunRow = {
  account_number: string | null;
  broker: string;
  fills_created: number;
  error_count: number;
  errors: string[] | null;
  ok: boolean;
  run_started_at: string;
  run_finished_at: string | null;
};

export type CourierStatus = {
  broker: string;
  accountNumber: string | null;
  ok: boolean;
  fillsCreated: number;
  errorCount: number;
  errors: string[] | null;
  runStartedAt: string;
  runFinishedAt: string | null;
} | null;

export async function GET(): Promise<NextResponse> {
  try {
    await requireAdmin();
  } catch (e) {
    return authErrorResponse(e);
  }

  const sb = createServerClient();

  async function latestFor(table: string, broker?: string): Promise<CourierStatus> {
    let q = sb.from(table).select("*").order("run_started_at", { ascending: false }).limit(1);
    if (broker) q = q.eq("broker", broker);
    const res = await q.maybeSingle();
    const row = res.data as PollRunRow | null;
    if (!row) return null;
    return {
      broker: row.broker,
      accountNumber: row.account_number,
      ok: row.ok,
      fillsCreated: row.fills_created,
      errorCount: row.error_count,
      errors: row.errors,
      runStartedAt: row.run_started_at,
      runFinishedAt: row.run_finished_at,
    };
  }

  const [schwab, schwab2, robinhood] = await Promise.all([
    latestFor("schwab_account_poll_runs", "schwab"),
    latestFor("schwab_account_poll_runs", "schwab2"),
    latestFor("robinhood_account_poll_runs"),
  ]);

  return NextResponse.json({ schwab, schwab2, robinhood });
}

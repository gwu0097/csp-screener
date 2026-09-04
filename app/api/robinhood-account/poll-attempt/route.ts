import { NextRequest, NextResponse } from "next/server";
import { requireCronSecret } from "@/lib/cron-auth";
import { createServerClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// POST /api/robinhood-account/poll-attempt
//
// Logs a courier run that never reached poll-transactions at all —
// the headless `claude -p` call hanging/failing, JSON extraction
// failing, or a missing account number. Those failure modes previously
// left zero trace in the database (only the courier's local state
// file), so a stretch of silent local failures was indistinguishable
// from "nothing scheduled" — see the 2026-09-04 incident where a
// 1:05pm run never landed and only the log file on the runner's own
// machine showed why. Writes into the SAME robinhood_account_poll_runs
// table poll-transactions itself writes to (see
// lib/robinhood-account-import.ts:456), not a separate table — a
// reader just wants "the latest row for this broker," and a failed
// local attempt is exactly as much "the latest run" as a completed one.
//
// Auth: Authorization: Bearer $CRON_SECRET, same gate as
// poll-transactions — this route is machine-called only.
export async function POST(req: NextRequest) {
  const denied = requireCronSecret(req);
  if (denied) return denied;

  const body = (await req.json().catch(() => null)) as {
    accountNumber?: string;
    detail?: string;
    startedAt?: string;
  } | null;
  if (!body?.detail) {
    return NextResponse.json({ ok: false, error: "detail is required" }, { status: 400 });
  }

  const sb = createServerClient();
  const res = await sb.from("robinhood_account_poll_runs").insert({
    account_number: body.accountNumber ?? null,
    broker: "robinhood",
    orders_seen: 0,
    executions_seen: 0,
    executions_landed: 0,
    fills_created: 0,
    skipped_count: 0,
    error_count: 1,
    errors: [body.detail],
    ok: false,
    run_started_at: body.startedAt ?? new Date().toISOString(),
    run_finished_at: new Date().toISOString(),
  });
  if (res.error) {
    return NextResponse.json({ ok: false, error: res.error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}

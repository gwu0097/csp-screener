import { NextRequest, NextResponse } from "next/server";
import { requireCronSecret } from "@/lib/cron-auth";
import { createServerClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// POST /api/robinhood-account/poll-run-start
//
// Inserts a placeholder row into robinhood_account_poll_runs at the
// moment the courier starts, with run_finished_at left NULL — the
// existing, already-nullable column doubles as an "is this run still
// in flight" flag with no schema change. The courier then threads this
// row's id through to whichever completion path it reaches
// (poll-transactions on success, or poll-attempt on a local failure),
// and that path UPDATEs this same row instead of inserting a fresh
// one, so the Positions page's CourierStatusLine can show "running
// since HH:MM" for the actual multi-minute window the headless
// `claude -p` call spends waiting on the Robinhood MCP round trip,
// then flip to the real result once it lands.
//
// Auth: Authorization: Bearer $CRON_SECRET, same gate as the other
// robinhood-account routes.
export async function POST(req: NextRequest) {
  const denied = requireCronSecret(req);
  if (denied) return denied;

  const body = (await req.json().catch(() => null)) as { accountNumber?: string } | null;

  const sb = createServerClient();
  const res = await sb
    .from("robinhood_account_poll_runs")
    .insert({
      account_number: body?.accountNumber ?? null,
      broker: "robinhood",
      orders_seen: 0,
      executions_seen: 0,
      executions_landed: 0,
      fills_created: 0,
      skipped_count: 0,
      error_count: 0,
      errors: null,
      ok: true,
      run_started_at: new Date().toISOString(),
      run_finished_at: null,
    })
    .select("id")
    .single();
  if (res.error || !res.data) {
    return NextResponse.json({ ok: false, error: res.error?.message ?? "insert returned no row" }, { status: 500 });
  }
  return NextResponse.json({ ok: true, runRowId: (res.data as { id: string }).id });
}

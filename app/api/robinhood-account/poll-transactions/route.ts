import { NextRequest, NextResponse } from "next/server";
import { requireCronSecret } from "@/lib/cron-auth";
import { ingestAndProcessRobinhoodOrders } from "@/lib/robinhood-account-import";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const maxDuration = 60;

// POST /api/robinhood-account/poll-transactions
//
// Landing endpoint for the local Robinhood "courier" — a scheduled
// headless `claude -p` run (~/bin/csp-robinhood-courier.sh) that calls
// the Robinhood MCP's get_option_orders and POSTs the raw JSON here
// verbatim. There's no OAuth/token flow on this side at all: unlike
// the Schwab pollers, this route does no outbound fetching itself,
// it only ingests what the courier already fetched. See
// lib/robinhood-account-import.ts for the full parse/dedup/writer
// pipeline — this route is a thin auth-gated wrapper around it,
// mirroring app/api/schwab-account/poll-transactions/route.ts's shape.
//
// Auth: Authorization: Bearer $CRON_SECRET, same gate as the Schwab
// poll route and capture-t0/t1 — this route is on the middleware
// public allowlist (no session cookie), so this is its only
// protection.
export async function POST(req: NextRequest) {
  const denied = requireCronSecret(req);
  if (denied) return denied;

  const accountNumber = req.nextUrl.searchParams.get("accountNumber");
  const lookbackSince = req.nextUrl.searchParams.get("lookbackSince") ?? undefined;
  if (!accountNumber) {
    return NextResponse.json({ ok: false, error: "accountNumber query param required" }, { status: 400 });
  }

  let rawBody: string;
  try {
    rawBody = await req.text();
  } catch {
    return NextResponse.json({ ok: false, error: "failed to read request body" }, { status: 400 });
  }
  if (!rawBody.trim()) {
    return NextResponse.json({ ok: false, error: "empty body" }, { status: 400 });
  }

  try {
    const report = await ingestAndProcessRobinhoodOrders(rawBody, { accountNumber, lookbackSince });
    console.log(
      `[robinhood-account-poll] ok=${report.ok} ${report.broker}: seen=${report.ordersSeen} executions=${report.executionsSeen} landed=${report.executionsLanded} trades=${report.tradesSubmitted} skipped=${report.skipped} errors=${report.errors.length}`,
    );
    return NextResponse.json({ ok: report.ok, report });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown";
    console.error("[robinhood-account-poll] fatal:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

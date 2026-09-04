import { NextRequest, NextResponse } from "next/server";
import { requireCronSecret } from "@/lib/cron-auth";
import { ingestAndProcessRobinhoodOrders, type RobinhoodPollReport } from "@/lib/robinhood-account-import";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const maxDuration = 60;

// POST /api/robinhood-account/poll-transactions?source=courier|manual
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
//
// This route also posts its OWN Discord outcome — but only when
// `source` is anything other than "courier". The courier already
// posts full per-run reporting from the local script (duration, seen/
// executions/landed counts, ETIMEDOUT diagnostics) for its own runs;
// this route's alert exists specifically to close the gap for calls
// that DON'T go through the courier — a fill submitted here directly
// (e.g. manually recovering a stuck run) previously landed in the DB
// with zero notification anywhere. Confirmed 2026-09-04: a LULU close
// imported via a direct curl POST updated the position with no Discord
// message at all, since the courier's alerting is entirely local-script
// side and never runs for a call it didn't make itself.
export async function POST(req: NextRequest) {
  const denied = requireCronSecret(req);
  if (denied) return denied;

  const accountNumber = req.nextUrl.searchParams.get("accountNumber");
  const lookbackSince = req.nextUrl.searchParams.get("lookbackSince") ?? undefined;
  const source = req.nextUrl.searchParams.get("source") ?? "manual";
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
    const alertSent = source === "courier" ? null : await postOutcomeAlert(source, report);
    return NextResponse.json({ ok: report.ok, report, alertSent });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown";
    console.error("[robinhood-account-poll] fatal:", msg);
    const alertSent = source === "courier" ? null : await postOutcomeAlert(source, null, msg);
    return NextResponse.json({ ok: false, error: msg, alertSent }, { status: 500 });
  }
}

// A closing fill with no matching open position on file isn't a
// broken import — see scripts/robinhood-courier.ts's classifyErrors
// for the full reasoning. Duplicated here rather than shared: this is
// the one severity-classification consumer on the server side, and
// importing it from the local script's file would be backwards.
function classifySeverity(errors: string[]): "ok" | "warning" | "failed" {
  if (errors.length === 0) return "ok";
  return errors.every((e) => /no matching open position|no open stock_long position/i.test(e))
    ? "warning"
    : "failed";
}

async function postOutcomeAlert(
  source: string,
  report: RobinhoodPollReport | null,
  fatalError?: string,
): Promise<boolean> {
  const { sendDiscordAlert } = await import("@/lib/discord-alert");
  const via = source === "manual" ? "manually" : `via ${source}`;

  if (!report) {
    const res = await sendDiscordAlert(`🔴 Robinhood fills import ${via} failed: ${fatalError ?? "unknown error"}`);
    return res.ok;
  }

  const severity = classifySeverity(report.errors);
  if (severity === "ok") {
    const msg =
      report.tradesSubmitted > 0
        ? `🟢 Robinhood fills imported ${via} — ${report.tradesSubmitted} fill${report.tradesSubmitted === 1 ? "" : "s"}.`
        : `🟢 Robinhood poll ${via} — no new fills.`;
    const res = await sendDiscordAlert(msg, { mention: false });
    return res.ok;
  }
  if (severity === "warning") {
    const res = await sendDiscordAlert(
      `🟡 Robinhood poll ${via}: ${report.errors.length} trade(s) couldn't auto-import — not part of a tracked position. Review and Dismiss in the activity panel.\n${report.errors.join("; ")}`,
      { mention: false },
    );
    return res.ok;
  }
  const res = await sendDiscordAlert(`🔴 Robinhood poll ${via} failed: ${report.errors.join("; ")}`);
  return res.ok;
}

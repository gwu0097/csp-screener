import { NextRequest, NextResponse } from "next/server";
import { requireCronSecret } from "@/lib/cron-auth";
import { pollSchwabAccountTransactions } from "@/lib/schwab-account-import";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const maxDuration = 60;

// POST /api/schwab-account/poll-transactions
//
// Scheduled 4x/day during market hours (7am/9am/11am/1pm PST) plus a
// daily reconciliation pass with a wider lookback — mirrors the
// existing capture-t0/capture-t1 cron shape. Pulls new transactions
// for both accounts under the Account Data connection since the last
// successful run, routes each to the existing writer that already
// handles that exact event (runBulkCreate / autoExpirePosition /
// recordAssignment + createStockFromAssignment /
// reduceStockLotForCallAssignment — see lib/schwab-account-import.ts's
// header for the full reasoning). Never touches Robinhood or
// covered_calls positions, never backfills history from before this
// connection existed.
//
// Auth: Authorization: Bearer $CRON_SECRET, same gate as capture-t0/t1.
export async function POST(req: NextRequest) {
  const denied = requireCronSecret(req);
  if (denied) return denied;

  try {
    const reports = await pollSchwabAccountTransactions();
    const ok = reports.every((r) => r.ok);
    console.log(
      `[schwab-account-poll] ok=${ok} ${reports
        .map(
          (r) =>
            `${r.broker}: seen=${r.transactionsSeen} landed=${r.transactionsLanded} trades=${r.tradesSubmitted} expired=${r.expirationsRecorded} assigned=${r.assignmentsRecorded} skipped=${r.skipped} errors=${r.errors.length}`,
        )
        .join(" | ")}`,
    );
    return NextResponse.json({ ok, reports });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown";
    console.error("[schwab-account-poll] fatal:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

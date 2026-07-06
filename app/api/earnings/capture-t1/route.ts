import { NextRequest, NextResponse } from "next/server";
import { requireCronSecret } from "@/lib/cron-auth";
import { runT1Capture } from "@/lib/earnings-capture";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const maxDuration = 60;

// POST /api/earnings/capture-t1
//
// Post-earnings IV capture. Cron-called at 09:45 ET (06:45 PT) on
// weekdays — ~15 minutes after the open, once the post-print crush has
// settled out of the opening auction. Finds every earnings_history row
// with a T0 capture (iv_before set) and no T1 yet in the last 4 days
// (covers yesterday-AMC, this-morning-BMO, weekends, and a missed
// cron), snapshots iv_after, and computes iv_crush_magnitude /
// move_ratio / iv_crushed / breached_two_x_em. Fresh crush numbers roll
// into stock_encyclopedia aggregates via recalculateStats.
//
// Auth: Authorization: Bearer $CRON_SECRET. Query: ?dryRun=1.
export async function POST(req: NextRequest) {
  const denied = requireCronSecret(req);
  if (denied) return denied;

  const dryRun = req.nextUrl.searchParams.get("dryRun") === "1";
  const report = await runT1Capture({ dryRun });
  console.log(
    `[capture-t1] ok=${report.ok} dryRun=${report.dryRun} candidates=${report.candidates} captured=${report.captured.length} skipped=${report.skipped.length}${report.skipReason ? ` skipReason=${report.skipReason}` : ""}`,
  );
  return NextResponse.json(report);
}

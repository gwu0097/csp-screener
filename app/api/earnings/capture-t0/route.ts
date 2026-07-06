import { NextRequest, NextResponse } from "next/server";
import { requireCronSecret } from "@/lib/cron-auth";
import { runT0Capture } from "@/lib/earnings-capture";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const maxDuration = 60;

// POST /api/earnings/capture-t0
//
// Pre-earnings IV capture. Cron-called at 15:45 ET (12:45 PT) on
// weekdays — ~15 minutes before the close on report day, when the
// earnings premium is fully priced in. Finds today's AMC + tomorrow's
// BMO reporters among app-known symbols, snapshots ATM straddle IV /
// implied move / spot into earnings_history, and stamps
// positions.earnings_history_id on open option positions spanning the
// event (the trade→event spine).
//
// Auth: Authorization: Bearer $CRON_SECRET (middleware lets this path
// through without a session; the secret is the only gate).
// Query: ?dryRun=1 computes and returns everything without writing;
//        ?symbol=ADBE&date=YYYY-MM-DD targets one event (testing).
export async function POST(req: NextRequest) {
  const denied = requireCronSecret(req);
  if (denied) return denied;

  const dryRun = req.nextUrl.searchParams.get("dryRun") === "1";
  const symbol = req.nextUrl.searchParams.get("symbol");
  const date = req.nextUrl.searchParams.get("date");
  const only =
    symbol && date && /^\d{4}-\d{2}-\d{2}$/.test(date)
      ? [{ symbol, earnings_date: date }]
      : undefined;

  const report = await runT0Capture({ dryRun, only });
  console.log(
    `[capture-t0] ok=${report.ok} dryRun=${report.dryRun} candidates=${report.candidates} captured=${report.captured.length} skipped=${report.skipped.length}${report.skipReason ? ` skipReason=${report.skipReason}` : ""}`,
  );
  // Graceful 200 even on schwab_disconnected — the cron log records the
  // miss; a 5xx would just make curl retry semantics noisier.
  return NextResponse.json(report);
}

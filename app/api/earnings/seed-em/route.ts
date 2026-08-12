import { NextRequest, NextResponse } from "next/server";
import { requireCronSecret } from "@/lib/cron-auth";
import { runEmUniverseSeed } from "@/lib/em-universe-seed";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const maxDuration = 60;

// POST /api/earnings/seed-em
//
// Daily universe-seeding sweep — NOT a capture. Seeds earnings_history
// stub rows (symbol, earnings_date, timing only) for SWING_UNIVERSE
// (S&P500 + Nasdaq100) ahead of each print, one bulk Finnhub calendar
// call per run. The existing capture-t0/capture-t1 crons pick a seeded
// row up automatically (selectT0Candidates()'s source 2 matches any
// earnings_history row dated today/tomorrow with iv_before IS NULL,
// with no relevance filter) — this route never calls Schwab itself.
//
// Run before the 12:45 PT capture-t0 fire, so today's/tomorrow's rows
// already exist by the time T0 looks for them.
//
// Auth: Authorization: Bearer $CRON_SECRET (same gate as capture-t0/t1).
// Query: ?dryRun=1 computes and returns everything without writing.
export async function POST(req: NextRequest) {
  const denied = requireCronSecret(req);
  if (denied) return denied;

  const dryRun = req.nextUrl.searchParams.get("dryRun") === "1";
  const report = await runEmUniverseSeed({ dryRun });
  console.log(
    `[seed-em] ok=${report.ok} dryRun=${report.dryRun} scopeSize=${report.scopeSize} candidates=${report.candidates} seeded=${report.seeded.length} alreadyExists=${report.alreadyExists.length} skipped=${report.skipped.length} errors=${report.errors.length}`,
  );
  return NextResponse.json(report);
}

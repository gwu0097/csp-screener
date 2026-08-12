import { NextRequest, NextResponse } from "next/server";
import { requireCronSecret } from "@/lib/cron-auth";
import { runEpsSweep } from "@/lib/eps-sweep";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const maxDuration = 60;

// POST /api/earnings/sweep-eps
//
// Daily eps_surprise_pct backfill sweep. Backward-looking only — no
// pre-print timing constraint, unlike seed-em. Finds earnings_history
// rows within the trailing T1_RETRY_CUTOFF_DAYS window still missing
// eps_surprise_pct, fetches Finnhub /stock/earnings (actual vs
// estimate), and writes eps_estimate/eps_actual/eps_surprise_pct only —
// same pctChange() formula updateEncyclopedia already uses, just
// triggered narrowly instead of via the full encyclopedia sweep (which
// would also fire an uncoordinated second Schwab call via
// fetchImpliedMove).
//
// Auth: Authorization: Bearer $CRON_SECRET (same gate as capture-t0/t1).
// Query: ?dryRun=1 computes and returns everything without writing.
export async function POST(req: NextRequest) {
  const denied = requireCronSecret(req);
  if (denied) return denied;

  const dryRun = req.nextUrl.searchParams.get("dryRun") === "1";
  const report = await runEpsSweep({ dryRun });
  console.log(
    `[sweep-eps] ok=${report.ok} dryRun=${report.dryRun} candidates=${report.candidates} captured=${report.captured.length} skipped=${report.skipped.length} errors=${report.errors.length} budget_exhausted=${report.budget_exhausted}`,
  );
  return NextResponse.json(report);
}

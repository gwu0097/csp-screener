import { NextRequest, NextResponse } from "next/server";
import { autoExpirePosition } from "@/lib/expire-positions";

export const dynamic = "force-dynamic";
export const revalidate = 0;
// User-confirmed bulk close for the same-day after-close
// pending_confirmation list. Calls autoExpirePosition on each id;
// per-position failures don't fail the whole batch — the response
// surfaces both successes and failures.
export const maxDuration = 30;

type Body = { positionIds?: unknown };

export async function POST(req: NextRequest) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const ids = Array.isArray(body.positionIds)
    ? body.positionIds.filter((x): x is string => typeof x === "string")
    : [];
  if (ids.length === 0) {
    return NextResponse.json(
      { error: "positionIds array required" },
      { status: 400 },
    );
  }

  const results = await Promise.all(
    ids.map(async (id) => {
      try {
        const r = await autoExpirePosition(id);
        return { positionId: id, ok: r.ok, realized_pnl: r.realized_pnl, reason: r.reason };
      } catch (e) {
        return {
          positionId: id,
          ok: false,
          realized_pnl: 0,
          reason: e instanceof Error ? e.message : "threw",
        };
      }
    }),
  );

  const expired = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  const totalPnl = expired.reduce((s, r) => s + r.realized_pnl, 0);

  return NextResponse.json({
    expiredCount: expired.length,
    failedCount: failed.length,
    totalRealizedPnl: Math.round(totalPnl * 100) / 100,
    results,
  });
}

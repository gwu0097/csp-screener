import { NextRequest, NextResponse } from "next/server";
import { requireUserId, authErrorResponse } from "@/lib/auth";
import { runBulkCreate, type BulkBody } from "@/lib/bulk-create-trades";

export const dynamic = "force-dynamic";
// Phase 2b entry-context stamping adds a VIX + snapshot + chain fetch
// per newly-opened position — keep headroom past the 10s default.
export const maxDuration = 60;

// The actual match-or-create / duplicate-detection / aggregate-recompute
// logic lives in lib/bulk-create-trades.ts — see that file's header for
// why. This route is a thin wrapper: derive userId from the session,
// parse the body, call runBulkCreate. The Schwab Account Data
// auto-import poller (lib/schwab-account-import.ts) calls runBulkCreate
// directly, in-process, with the admin userId resolved a different way
// (no session in a cron context) — same function, same behavior, no
// second writer.
export async function POST(req: NextRequest) {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch (e) {
    return authErrorResponse(e);
  }
  let body: BulkBody;
  try {
    body = (await req.json()) as BulkBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  return runBulkCreate(userId, body);
}

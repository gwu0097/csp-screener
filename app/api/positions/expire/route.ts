import { NextResponse } from "next/server";
import { runAutoExpire } from "@/lib/expire-positions";
import { requireUserId, authErrorResponse } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// Runs the auto-expire sweep for the calling user's open positions
// past expiry and returns the pending-confirmation report so the UI
// can surface the confirm modal. No body needed.
export async function POST() {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch (e) {
    return authErrorResponse(e);
  }
  const report = await runAutoExpire(userId);
  return NextResponse.json(report);
}

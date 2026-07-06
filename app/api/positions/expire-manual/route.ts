import { NextRequest, NextResponse } from "next/server";
import { autoExpirePosition } from "@/lib/expire-positions";
import { requireUserId, authErrorResponse } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type Body = { positionId?: unknown };

// Manual "Expire Worthless" confirmation from the verify_assignment
// warning. Calls autoExpirePosition regardless of the automatic
// classifier's verdict — the user is explicitly asserting the option
// expired worthless.
export async function POST(req: NextRequest) {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch (e) {
    return authErrorResponse(e);
  }
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const positionId = typeof body.positionId === "string" ? body.positionId : null;
  if (!positionId) {
    return NextResponse.json({ error: "positionId required" }, { status: 400 });
  }
  const r = await autoExpirePosition(positionId, userId);
  if (!r.ok) {
    const status = r.reason === "not_found" ? 404 : 500;
    return NextResponse.json({ error: r.reason ?? "expire failed" }, { status });
  }
  return NextResponse.json({ ok: true, realized_pnl: r.realized_pnl });
}

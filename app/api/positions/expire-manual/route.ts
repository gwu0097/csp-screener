import { NextRequest, NextResponse } from "next/server";
import { autoExpirePosition } from "@/lib/expire-positions";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type Body = { positionId?: unknown };

// Manual "Expire Worthless" confirmation from the verify_assignment
// warning. Calls autoExpirePosition regardless of the automatic
// classifier's verdict — the user is explicitly asserting the option
// expired worthless.
export async function POST(req: NextRequest) {
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
  const r = await autoExpirePosition(positionId);
  if (!r.ok) {
    return NextResponse.json({ error: r.reason ?? "expire failed" }, { status: 500 });
  }
  return NextResponse.json({ ok: true, realized_pnl: r.realized_pnl });
}

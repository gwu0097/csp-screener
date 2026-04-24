import { NextRequest, NextResponse } from "next/server";
import { recordAssignment } from "@/lib/expire-positions";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type Body = { positionId?: unknown; stockPriceAtExpiry?: unknown };

export async function POST(req: NextRequest) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const positionId = typeof body.positionId === "string" ? body.positionId : null;
  const stockPrice = Number(body.stockPriceAtExpiry);
  if (!positionId) {
    return NextResponse.json({ error: "positionId required" }, { status: 400 });
  }
  if (!Number.isFinite(stockPrice) || stockPrice <= 0) {
    return NextResponse.json(
      { error: "stockPriceAtExpiry must be a positive number" },
      { status: 400 },
    );
  }
  const r = await recordAssignment(positionId, stockPrice);
  if (!r.ok) {
    return NextResponse.json({ error: r.reason ?? "assignment failed" }, { status: 500 });
  }
  return NextResponse.json({ ok: true, realized_pnl: r.realized_pnl });
}

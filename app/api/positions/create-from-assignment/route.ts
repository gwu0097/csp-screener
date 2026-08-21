import { NextRequest, NextResponse } from "next/server";
import { requireUserId, authErrorResponse } from "@/lib/auth";
import { createStockFromAssignment } from "@/lib/positions";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const maxDuration = 30;

// POST /api/positions/create-from-assignment
//
// Creates stock_long position rows from already-assigned put
// positions. Called after the user confirms the AssignmentStockPrompt
// modal that pops up when /api/positions/confirm-expire returns
// non-empty assignments[].
//
// Body: { items: [{ assignedPositionId: string }] }
//
// The actual logic lives in lib/positions.ts::createStockFromAssignment
// — see that function's own comment for the full behavior (cost basis,
// idempotency via assignment_source_id, etc.) and for why it isn't
// exported from this file directly.
type Item = { assignedPositionId?: unknown };
type Body = { items?: unknown };

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
  const itemsRaw = Array.isArray(body.items) ? (body.items as Item[]) : [];
  const ids: string[] = [];
  for (const i of itemsRaw) {
    if (typeof i.assignedPositionId === "string" && i.assignedPositionId)
      ids.push(i.assignedPositionId);
  }
  if (ids.length === 0) {
    return NextResponse.json(
      { error: "items[].assignedPositionId required" },
      { status: 400 },
    );
  }
  return createStockFromAssignment(userId, ids);
}

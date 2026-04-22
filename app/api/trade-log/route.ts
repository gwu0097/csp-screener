import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// Deprecated. The trades table was replaced by positions+fills; use
// /api/trades/bulk-create for writes and /api/positions/open or
// /api/journal/stats for reads.
const GONE = {
  error: "Superseded by positions+fills. Use /api/trades/bulk-create, /api/positions/open, or /api/journal/stats.",
};

export async function GET() {
  return NextResponse.json(GONE, { status: 410 });
}
export async function POST() {
  return NextResponse.json(GONE, { status: 410 });
}
export async function PATCH() {
  return NextResponse.json(GONE, { status: 410 });
}

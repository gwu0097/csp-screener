import { NextRequest, NextResponse } from "next/server";
import { removeFromWatchlist } from "@/lib/watchlist";
import { requireUserId, authErrorResponse } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function DELETE(_req: NextRequest, { params }: { params: { symbol: string } }) {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch (e) {
    return authErrorResponse(e);
  }
  const symbol = (params.symbol ?? "").trim();
  if (!symbol) return NextResponse.json({ error: "Missing symbol" }, { status: 400 });
  try {
    await removeFromWatchlist(userId, symbol);
    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "failed";
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}

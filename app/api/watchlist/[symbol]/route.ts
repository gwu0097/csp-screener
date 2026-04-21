import { NextRequest, NextResponse } from "next/server";
import { removeFromWatchlist } from "@/lib/watchlist";

export const dynamic = "force-dynamic";

export async function DELETE(_req: NextRequest, { params }: { params: { symbol: string } }) {
  const symbol = (params.symbol ?? "").trim();
  if (!symbol) return NextResponse.json({ error: "Missing symbol" }, { status: 400 });
  try {
    await removeFromWatchlist(symbol);
    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "failed";
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}

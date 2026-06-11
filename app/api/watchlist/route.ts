import { NextRequest, NextResponse } from "next/server";
import { addToWatchlist, getWatchlist, WatchlistType } from "@/lib/watchlist";
import { requireUserId, authErrorResponse } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET() {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch (e) {
    return authErrorResponse(e);
  }
  const { whitelist, blacklist } = await getWatchlist(userId);
  return NextResponse.json({
    whitelist: whitelist.map((r) => ({ symbol: r.symbol, addedAt: r.added_at })),
    blacklist: blacklist.map((r) => ({ symbol: r.symbol, addedAt: r.added_at })),
  });
}

type AddBody = { symbol?: unknown; list_type?: unknown };

export async function POST(req: NextRequest) {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch (e) {
    return authErrorResponse(e);
  }
  let body: AddBody;
  try {
    body = (await req.json()) as AddBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (typeof body.symbol !== "string" || body.symbol.trim().length === 0) {
    return NextResponse.json({ error: "Missing symbol" }, { status: 400 });
  }
  if (body.list_type !== "whitelist" && body.list_type !== "blacklist") {
    return NextResponse.json({ error: "list_type must be 'whitelist' or 'blacklist'" }, { status: 400 });
  }
  try {
    const entry = await addToWatchlist(userId, body.symbol, body.list_type as WatchlistType);
    return NextResponse.json({ entry: { symbol: entry.symbol, addedAt: entry.added_at, listType: entry.list_type } });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "failed";
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}

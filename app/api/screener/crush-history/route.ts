import { NextRequest, NextResponse } from "next/server";
import { getCrushHistory } from "@/lib/earnings-history-table";

export const dynamic = "force-dynamic";
export const revalidate = 0;
// Read-only crush-history fetch. Used by the expanded screener row's
// CrushHistoryTable on mount so a remount/re-expand always shows the
// latest DB state — instead of falling back to the stageThree.details.
// crushHistory snapshot baked into the screener_results cache, which
// is stale the moment the user clicks Fetch EM History and the seed /
// Polygon populate writes new rows.
export const maxDuration = 10;

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const symbol = (url.searchParams.get("symbol") ?? "").trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol)) {
    return NextResponse.json({ error: "Invalid symbol" }, { status: 400 });
  }
  const limitRaw = Number(url.searchParams.get("limit") ?? 8);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(1, limitRaw), 16) : 8;

  try {
    const events = await getCrushHistory(symbol, limit);
    return NextResponse.json({ events });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "fetch failed" },
      { status: 500 },
    );
  }
}

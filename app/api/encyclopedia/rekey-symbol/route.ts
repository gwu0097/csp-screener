import { NextRequest, NextResponse } from "next/server";
import {
  reingestHistoricalDates,
  updateEncyclopedia,
} from "@/lib/encyclopedia";

export const dynamic = "force-dynamic";
// Manual re-key + ingest for a single symbol. Phase 2C re-key takes
// ~1-3s + a Yahoo earnings-module call + a few fetchYahooPriceActionTimed
// calls per quarter-end row; updateEncyclopedia adds Finnhub /stock/
// earnings + a Yahoo calendar fetch. Easily fits the 60s ceiling.
export const maxDuration = 60;

type Body = { symbol?: unknown };

function validSymbol(symbol: string): boolean {
  return /^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol);
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: Body = {};
  try {
    body = (await req.json().catch(() => ({}))) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const symbol =
    typeof body.symbol === "string" ? body.symbol.trim().toUpperCase() : "";
  if (!validSymbol(symbol)) {
    return NextResponse.json({ error: "Invalid symbol" }, { status: 400 });
  }

  try {
    // First the re-key — rewrites any legacy quarter-end-dated rows to
    // their actual announcement dates and refills price action with
    // proper BMO/AMC timing.
    const rekey = await reingestHistoricalDates(symbol);
    // Then the regular Phase 1 ingest, which now uses the calendar to
    // create new rows under the correct announcement date going forward
    // and re-runs any rows whose stored move is < 1% (likely stale).
    const summary = await updateEncyclopedia(symbol);
    return NextResponse.json({ rekey, summary });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[rekey-symbol] ${symbol} failed:`, err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

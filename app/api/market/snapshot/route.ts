import { NextRequest, NextResponse } from "next/server";
import {
  getOrRefreshSnapshot,
  batchRefreshSnapshots,
  refreshSymbolSnapshot,
} from "@/lib/market-snapshot";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const maxDuration = 60;

// Central market-snapshot endpoint. Features should read through this
// instead of calling Yahoo directly.
//   GET ?symbol=AAPL          → cached-or-refreshed single snapshot
//   GET ?symbols=AAPL,MSFT    → batch (SPY fetched once, 15-min TTL)
//   POST ?symbol=AAPL         → force refresh

const DEFAULT_MAX_AGE_MIN = 15;

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const symbolsParam = sp.get("symbols");
  const symbol = sp.get("symbol");

  if (symbolsParam) {
    const symbols = symbolsParam
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (symbols.length === 0) {
      return NextResponse.json({ error: "No symbols provided" }, { status: 400 });
    }
    const snapshots = await batchRefreshSnapshots(symbols, DEFAULT_MAX_AGE_MIN);
    return NextResponse.json({ snapshots });
  }

  if (symbol) {
    const snap = await getOrRefreshSnapshot(symbol, DEFAULT_MAX_AGE_MIN);
    if (!snap) {
      return NextResponse.json(
        { error: `No snapshot available for ${symbol.toUpperCase()}` },
        { status: 404 },
      );
    }
    return NextResponse.json({ snapshot: snap });
  }

  return NextResponse.json(
    { error: "Provide ?symbol= or ?symbols=" },
    { status: 400 },
  );
}

export async function POST(req: NextRequest) {
  const symbol = req.nextUrl.searchParams.get("symbol");
  if (!symbol) {
    return NextResponse.json({ error: "Provide ?symbol=" }, { status: 400 });
  }
  const snap = await refreshSymbolSnapshot(symbol);
  if (!snap) {
    return NextResponse.json(
      { error: `Refresh failed for ${symbol.toUpperCase()} (Yahoo unavailable)` },
      { status: 502 },
    );
  }
  return NextResponse.json({ snapshot: snap });
}

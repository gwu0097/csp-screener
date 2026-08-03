import { NextRequest, NextResponse } from "next/server";
import { isSchwabConnected } from "@/lib/schwab";
import { safeGetChain, computeFillPrice } from "@/lib/screener";
import { requireUserId, authErrorResponse } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;
// Options Chain tab's "Refresh Chain" action — a single Schwab chain
// pull for one symbol/expiry, nothing else. Deliberately NOT
// runStageFour: that recomputes suggestedStrike/premium/opportunityGrade,
// which this button must never touch (grade/ladder/news stay exactly
// as the last full analysis left them). strikeCount=200 mirrors
// fetchTargetedStrike's approach — the recommended strike can be far
// OTM on high-IV names, so a narrow ATM-centered window risks missing
// it entirely.
export const maxDuration = 20;

type Body = {
  symbol?: unknown;
  expiry?: unknown;
};

export async function POST(req: NextRequest) {
  try {
    await requireUserId();
  } catch (e) {
    return authErrorResponse(e);
  }

  const { connected } = await isSchwabConnected().catch(() => ({ connected: false }));
  if (!connected) {
    return NextResponse.json(
      { error: "Schwab not connected. Connect it from Settings to refresh the chain." },
      { status: 400 },
    );
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (typeof body.symbol !== "string" || !body.symbol.trim()) {
    return NextResponse.json({ error: "Missing symbol" }, { status: 400 });
  }
  if (typeof body.expiry !== "string" || !body.expiry.trim()) {
    return NextResponse.json({ error: "Missing expiry" }, { status: 400 });
  }
  const symbol = body.symbol.trim().toUpperCase();
  const expiry = body.expiry.trim();

  const chain = await safeGetChain(symbol, expiry, expiry, {
    contractType: "PUT",
    strikeCount: 200,
  });
  if (!chain) {
    return NextResponse.json(
      { error: `Schwab chain fetch failed for ${symbol}` },
      { status: 502 },
    );
  }

  const expKey = Object.keys(chain.putExpDateMap ?? {}).find((k) => k.startsWith(expiry));
  const contracts = expKey
    ? Object.values(chain.putExpDateMap[expKey] ?? {}).flat()
    : [];
  if (contracts.length === 0) {
    return NextResponse.json(
      { error: `No put contracts found for ${symbol} at expiry ${expiry}` },
      { status: 502 },
    );
  }

  // Mirrors StageFourResult["availableStrikes"]'s shape (strike/bid/
  // ask/mark/last/premiumFill/fillInvalid/delta/oi/volume) so the
  // client's click-to-select handler can treat a freshly-refreshed
  // chain and the original analysis-time chain identically — same
  // fields, same fill-basis math, no source-specific branching. delta/
  // openInterest/totalVolume are already on every Schwab contract (no
  // extra fetch), so a strike clicked from a refreshed chain still
  // yields a real per-strike Delta/POP/OI/volume.
  const strikes = contracts
    .map((c) => {
      const bid = Number.isFinite(c.bid) ? c.bid : 0;
      const ask = Number.isFinite(c.ask) ? c.ask : 0;
      const { fill, midInvalid } = computeFillPrice(bid, ask);
      const mark = Number.isFinite(c.mark) ? c.mark : (bid + ask) / 2;
      // Same rounding as runStageFour's availableStrikes so a refreshed
      // strike and an analysis-time strike never differ by floating-
      // point noise alone.
      return {
        strike: c.strikePrice,
        bid,
        ask,
        mark: Math.round(mark * 100) / 100,
        last: Number.isFinite(c.last) ? Math.round(c.last * 100) / 100 : 0,
        premiumFill: Math.round(fill * 100) / 100,
        fillInvalid: midInvalid,
        delta: Number.isFinite(c.delta) ? Math.round(c.delta * 1000) / 1000 : 0,
        oi: Number.isFinite(c.openInterest) ? (c.openInterest as number) : 0,
        volume: Number.isFinite(c.totalVolume) ? (c.totalVolume as number) : 0,
      };
    })
    .sort((a, b) => a.strike - b.strike);

  return NextResponse.json({
    symbol,
    expiry,
    strikes,
    asOf: new Date().toISOString(),
  });
}

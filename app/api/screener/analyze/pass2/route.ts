import { NextRequest, NextResponse } from "next/server";
import { getBatchPrices } from "@/lib/price";
import { isSchwabConnected } from "@/lib/schwab";
import { runStagesThreeFour, ScreenerResult } from "@/lib/screener";
import { getMarketContext } from "@/lib/market";

export const dynamic = "force-dynamic";
export const revalidate = 0;
// Pass 2 = Schwab options chain pull + stages 3/4 grading per candidate
// (in parallel). Perplexity news + final three-layer grade + tracked /
// snapshot / encyclopedia bookkeeping moved to /pass3 so neither route
// exceeds the 60s Hobby ceiling.
export const maxDuration = 60;

type Body = {
  candidates?: unknown;
};

export async function POST(req: NextRequest) {
  const { connected } = await isSchwabConnected().catch(() => ({ connected: false }));
  if (!connected) {
    return NextResponse.json(
      { error: "Schwab not connected. Connect it from Settings to run analysis." },
      { status: 400 },
    );
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!Array.isArray(body.candidates)) {
    return NextResponse.json({ error: "Missing candidates array" }, { status: 400 });
  }

  const candidates = body.candidates as ScreenerResult[];

  // Shared context: batch prices + VIX/SPY. Both cheap and used by every
  // candidate / forwarded to pass 3 for the grade-calc step.
  const [prices, market] = await Promise.all([
    getBatchPrices(candidates.map((c) => c.symbol)),
    getMarketContext().catch(() => ({
      vix: null,
      spyPrice: null,
      regime: null,
      warning: null,
    })),
  ]);

  // Per-candidate stages 3/4 in parallel — Schwab options chain +
  // strike/premium/delta math. The expensive bit is the chain fetch.
  // Three-layer grade calc is deferred to pass 3 because it depends
  // on Perplexity news.
  const scored = await Promise.all(
    candidates.map(async (base): Promise<ScreenerResult> => {
      const upper = base.symbol.toUpperCase();
      const refreshedPrice = prices[upper] ?? base.price ?? 0;
      try {
        return await runStagesThreeFour({ ...base, price: refreshedPrice });
      } catch (e) {
        console.warn(
          `[analyze/pass2] ${upper} stages 3/4 failed: ${e instanceof Error ? e.message : e}`,
        );
        return base;
      }
    }),
  );

  return NextResponse.json({
    connected: true,
    results: scored,
    prices,
    vix: market.vix,
  });
}

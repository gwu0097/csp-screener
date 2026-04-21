import { NextRequest, NextResponse } from "next/server";
import { getBatchPrices } from "@/lib/price";
import { isSchwabConnected } from "@/lib/schwab";
import { runStagesThreeFour, ScreenerResult } from "@/lib/screener";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type Body = { candidates?: unknown };

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
  if (candidates.length === 0) {
    return NextResponse.json({ connected: true, results: [], prices: {} });
  }

  const prices = await getBatchPrices(candidates.map((c) => c.symbol));
  const results: ScreenerResult[] = [];
  for (const base of candidates) {
    const symbol = base.symbol.toUpperCase();
    const refreshedPrice = prices[symbol] ?? base.price ?? 0;
    const updated = await runStagesThreeFour({ ...base, price: refreshedPrice });
    results.push(updated);
  }

  console.log(`[analyze] analyzed ${results.length} candidates`);

  return NextResponse.json({ connected: true, results, prices });
}

import { NextResponse } from "next/server";
import { getTodayEarnings } from "@/lib/earnings";
import { preFilterEarningsCandidates, runScreenerForCandidates } from "@/lib/screener";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const MAX_CANDIDATES = 20;
const YAHOO_FALLBACK_BUDGET = 10;

export async function GET() {
  try {
    const raw = await getTodayEarnings().catch((e) => {
      console.error("[screener] getTodayEarnings failed:", e instanceof Error ? e.message : e);
      return [];
    });

    const { kept, stats } = await preFilterEarningsCandidates(
      raw.map((r) => ({ symbol: r.symbol, date: r.date, timing: r.timing as "BMO" | "AMC" })),
      { maxCount: MAX_CANDIDATES, yahooBudget: YAHOO_FALLBACK_BUDGET },
    );

    console.log(
      `[screener] pre-filter raw=${stats.raw} shape=${stats.shape} kept=${stats.kept} ` +
        `(map=${stats.mapHit} cache=${stats.cacheHit} yahoo=${stats.yahooHit} dropped=${stats.yahooDropped}) ` +
        `cap=${MAX_CANDIDATES} yahooBudget=${YAHOO_FALLBACK_BUDGET}`,
      kept.map((c) => c.symbol),
    );

    const data = await runScreenerForCandidates(kept);
    return NextResponse.json(data);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown";
    console.error("[screener] route failed:", msg);
    return NextResponse.json({ connected: false, results: [], errors: [msg] }, { status: 500 });
  }
}

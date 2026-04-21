import { NextResponse } from "next/server";
import { getTodayEarnings } from "@/lib/earnings";
import { preFilterEarningsCandidates, runScreenerForCandidates } from "@/lib/screener";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const MAX_CANDIDATES = 20;

export async function GET() {
  try {
    const raw = await getTodayEarnings().catch((e) => {
      console.error("[screener] getTodayEarnings failed:", e instanceof Error ? e.message : e);
      return [];
    });

    const filtered = preFilterEarningsCandidates(
      raw.map((r) => ({ symbol: r.symbol, date: r.date, timing: r.timing as "BMO" | "AMC" })),
      { maxCount: MAX_CANDIDATES },
    );

    console.log(
      `[screener] pre-filter: raw=${raw.length} surviving=${filtered.length} (cap=${MAX_CANDIDATES})`,
      filtered.map((c) => c.symbol),
    );

    const data = await runScreenerForCandidates(filtered);
    return NextResponse.json(data);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown";
    console.error("[screener] route failed:", msg);
    return NextResponse.json({ connected: false, results: [], errors: [msg] }, { status: 500 });
  }
}

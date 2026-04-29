import { NextRequest, NextResponse } from "next/server";
import { getBatchPrices } from "@/lib/price";
import { isSchwabConnected } from "@/lib/schwab";
import {
  evaluateStagesOneTwo,
  runStagesThreeFour,
  type EarningsCandidate,
  type ScreenContext,
  type ScreenerResult,
} from "@/lib/screener";
import { getIndustryClassification } from "@/lib/classification";
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

  // Per-candidate Stage 1+2 (when missing) → Stage 3+4 → return.
  //
  // Screen Today now returns minimal candidate shells with stageTwo
  // null (the per-row Schwab call inside the screen route was the
  // timeout source — it's been moved here). Detect shells via
  // missing stageTwo and run Stage 1+2 first using a chain=null
  // context — Stage 1+2's chain dependency is informational only;
  // Stage 3+4 fetches the real chain once for strike/premium math
  // and overwrites whatever Stage 1+2 inferred without one.
  //
  // Backwards-compatible: rows that already have stageTwo (Load
  // Previous, or any pre-strip saved snapshot) skip the prefix and
  // go straight to Stage 3+4 as before.
  let stageOneTwoRan = 0;
  let stageOneTwoSkipped = 0;
  const scored = await Promise.all(
    candidates.map(async (base): Promise<ScreenerResult> => {
      const upper = base.symbol.toUpperCase();
      const refreshedPrice = prices[upper] ?? base.price ?? 0;
      let working: ScreenerResult = { ...base, price: refreshedPrice };

      const isShell = !base.stageTwo;
      if (isShell) {
        try {
          const candidate: EarningsCandidate = {
            symbol: base.symbol,
            price: refreshedPrice,
            earningsDate: base.earningsDate,
            earningsTiming: base.earningsTiming,
            daysToExpiry: base.daysToExpiry,
            expiry: base.expiry,
          };
          const cls = await getIndustryClassification(upper, {
            yahooAllowed: false,
          });
          const industryStatus: "pass" | "fail" | "unknown" = base.isWhitelisted
            ? "pass"
            : cls.source === "unknown"
              ? "unknown"
              : cls.pass
                ? "pass"
                : "fail";
          const ctx: ScreenContext = {
            connected: true,
            chain: null, // Stage 3+4 fetches the real chain — avoids the
            // double Schwab round-trip per candidate.
            // ClassificationResult.industry is the broader string type;
            // ScreenContext.industryClass is the strict IndustryClass
            // union. Cast — same pattern the screen route used.
            industryClass: cls.industry as ScreenContext["industryClass"],
            industryStatus,
            isWhitelisted: base.isWhitelisted,
          };
          working = await evaluateStagesOneTwo(candidate, ctx);
          stageOneTwoRan += 1;
        } catch (e) {
          console.warn(
            `[analyze/pass2] ${upper} stage 1+2 failed: ${e instanceof Error ? e.message : e}`,
          );
          // Fall through with the price-refreshed shell — Stage 3+4
          // partial-degrades better than a hard fail.
        }
      } else {
        stageOneTwoSkipped += 1;
      }

      try {
        return await runStagesThreeFour(working);
      } catch (e) {
        console.warn(
          `[analyze/pass2] ${upper} stages 3/4 failed: ${e instanceof Error ? e.message : e}`,
        );
        return working;
      }
    }),
  );
  console.log(
    `[analyze/pass2] processed ${candidates.length} candidates · stage1+2 ran=${stageOneTwoRan} skipped=${stageOneTwoSkipped}`,
  );

  return NextResponse.json({
    connected: true,
    results: scored,
    prices,
    vix: market.vix,
  });
}

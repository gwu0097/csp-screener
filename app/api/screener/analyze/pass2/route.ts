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

  // ---- Diagnostic — shape of the first candidate on entry ----
  // Surfaces whether stageTwo arrives as null / undefined / {} so the
  // shell-detection condition can be sanity-checked against real
  // payload. Drops only field types + truthiness, no PII.
  if (candidates.length > 0) {
    const c0 = candidates[0] as ScreenerResult & {
      stageOne?: unknown;
      stageTwo?: unknown;
      stageThree?: unknown;
      stageFour?: unknown;
    };
    const shape = (v: unknown) => {
      if (v === null) return "null";
      if (v === undefined) return "undefined";
      if (Array.isArray(v)) return `array(${v.length})`;
      if (typeof v === "object")
        return `object(keys=${Object.keys(v as object).length})`;
      return typeof v;
    };
    console.log(
      `[analyze/pass2] entry shape ${c0.symbol}: ` +
        `stageOne=${shape(c0.stageOne)} stageTwo=${shape(c0.stageTwo)} ` +
        `stageThree=${shape(c0.stageThree)} stageFour=${shape(c0.stageFour)} ` +
        `recommendation=${(c0 as { recommendation?: string }).recommendation ?? "(none)"} ` +
        `falsy?(stageTwo)=${!c0.stageTwo}`,
    );
  }

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
  let stageOneTwoFailed = 0;
  let stageThreeFourFailedHard = 0; // threw
  let stageThreeFourFailedSoft = 0; // returned with stageThree=null
  let firstScoredLogged = false;
  const scored = await Promise.all(
    candidates.map(async (base): Promise<ScreenerResult> => {
      const upper = base.symbol.toUpperCase();
      const refreshedPrice = prices[upper] ?? base.price ?? 0;
      let working: ScreenerResult = { ...base, price: refreshedPrice };

      // Shell detection: stageTwo may arrive as null (new screen),
      // undefined (legacy schema), or — if a serializer somewhere
      // converts to {} — an empty object. Anything that isn't a
      // populated stageTwo with a numeric `score` triggers the prefix.
      const stageTwoVal = base.stageTwo as
        | (ScreenerResult["stageTwo"] & { score?: unknown })
        | null
        | undefined;
      const isShell =
        !stageTwoVal ||
        typeof stageTwoVal !== "object" ||
        typeof stageTwoVal.score !== "number";
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
            `[analyze/pass2] ${upper} stage 1+2 FAILED: ${e instanceof Error ? e.message : e}`,
          );
          stageOneTwoFailed += 1;
          // Fall through with the price-refreshed shell — Stage 3+4
          // partial-degrades better than a hard fail.
        }
      } else {
        stageOneTwoSkipped += 1;
      }

      let final: ScreenerResult;
      try {
        final = await runStagesThreeFour(working);
      } catch (e) {
        console.warn(
          `[analyze/pass2] ${upper} stages 3/4 THREW: ${e instanceof Error ? e.message : e}`,
        );
        stageThreeFourFailedHard += 1;
        final = working;
      }
      // Soft-fail = runStagesThreeFour returned but couldn't fetch the
      // chain — stageThree/stageFour come back null with
      // recommendation="Cannot evaluate". Count separately so the log
      // distinguishes "Schwab outage" (soft) from "code threw" (hard).
      if (!final.stageThree || !final.stageFour) {
        stageThreeFourFailedSoft += 1;
      }

      // Log shape of the first fully-processed candidate so we can
      // see whether stageThree/stageFour got populated.
      if (!firstScoredLogged) {
        firstScoredLogged = true;
        const shape = (v: unknown) =>
          v === null
            ? "null"
            : v === undefined
              ? "undefined"
              : typeof v === "object"
                ? `object(keys=${Object.keys(v as object).length})`
                : typeof v;
        console.log(
          `[analyze/pass2] first-result shape ${final.symbol}: ` +
            `stageOne=${shape(final.stageOne)} stageTwo=${shape(final.stageTwo)} ` +
            `stageThree=${shape(final.stageThree)} stageFour=${shape(final.stageFour)} ` +
            `recommendation=${final.recommendation} stoppedAt=${final.stoppedAt} ` +
            `errors=${final.errors.length}`,
        );
        if (final.stageFour) {
          console.log(
            `[analyze/pass2] first-result strike=${final.stageFour.suggestedStrike ?? "—"} ` +
              `premium=${final.stageFour.premium ?? "—"} ` +
              `delta=${final.stageFour.delta ?? "—"} ` +
              `oppGrade=${final.stageFour.opportunityGrade ?? "—"}`,
          );
        }
      }
      return final;
    }),
  );

  const populatedStageThree = scored.filter((r) => r.stageThree).length;
  const populatedStageFour = scored.filter((r) => r.stageFour).length;
  console.log(
    `[analyze/pass2] processed ${candidates.length} candidates · ` +
      `stage1+2 ran=${stageOneTwoRan} skipped=${stageOneTwoSkipped} failed=${stageOneTwoFailed} · ` +
      `stage3+4 hardFail=${stageThreeFourFailedHard} softFail=${stageThreeFourFailedSoft} · ` +
      `final populated stage3=${populatedStageThree}/${scored.length} stage4=${populatedStageFour}/${scored.length}`,
  );
  if (populatedStageFour === 0 && scored.length > 0) {
    console.warn(
      `[analyze/pass2] EVERY candidate finished with stageFour=null. ` +
        `Schwab options endpoint is likely down or rate-limited — chain fetches inside ` +
        `runStagesThreeFour are returning null. Check Schwab connectivity in Settings.`,
    );
  }

  return NextResponse.json({
    connected: true,
    results: scored,
    prices,
    vix: market.vix,
  });
}

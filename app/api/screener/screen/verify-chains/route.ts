import { NextRequest, NextResponse } from "next/server";
import { isSchwabConnected } from "@/lib/schwab";
import { getWatchlistSymbols } from "@/lib/watchlist";
import { getIndustryClassification } from "@/lib/classification";
import {
  buildCandidateFromEarnings,
  chainHasWeeklyExpiry,
  evaluateStagesOneTwo,
  runStagesThreeFour,
  safeGetChain,
  type ScreenContext,
  type ScreenerResult,
} from "@/lib/screener";

export const dynamic = "force-dynamic";
export const revalidate = 0;
// Stream C of the Screen Today pipeline. Per batch:
//   1. Probe Schwab once for the chain
//   2. If chain absent + not whitelisted → drop
//   3. Otherwise run full Stage 1+2 (quality floor) — drop on fail
//      unless whitelisted
//   4. Run Stage 3+4 (crush + opportunity + strike + premium) using
//      the same chain we already fetched (passed in to avoid a 2nd
//      Schwab round-trip)
// Total per candidate ~3-7s with a healthy Schwab token. Batches of
// 10 run in parallel (Promise.all) so wall-clock per batch stays
// under ~8s. The client retries failed batches once and marks any
// genuine Schwab outage as unverified passthrough.
export const maxDuration = 60;

type EnrichedRow =
  | { symbol: string; status: "scored"; result: ScreenerResult }
  | { symbol: string; status: "unverified"; result: ScreenerResult; reason: string }
  | { symbol: string; status: "dropped"; reason: string };

type Body = {
  candidates?: Array<{
    symbol?: unknown;
    date?: unknown; // earnings date (YYYY-MM-DD)
    timing?: unknown; // "BMO" | "AMC"
    price?: unknown;
    isWhitelisted?: unknown;
  }>;
};

const MAX_BATCH = 25;

// Builds an "unverified" passthrough shell. Stage 1+2 still run so the
// score columns aren't empty in the UI, but Stage 3/4 stay null.
async function buildShell(
  candidate: ReturnType<typeof buildCandidateFromEarnings>,
  ctx: ScreenContext,
  reason: string,
): Promise<EnrichedRow> {
  try {
    const oneTwo = await evaluateStagesOneTwo(candidate, ctx);
    return { symbol: candidate.symbol, status: "unverified", result: oneTwo, reason };
  } catch (e) {
    // If even Stage 1+2 throws (rare — Finnhub/Yahoo dependency), fall
    // back to the bare placeholder shell shape Stream A would emit.
    const placeholder: ScreenerResult = {
      symbol: candidate.symbol,
      price: candidate.price,
      earningsDate: candidate.earningsDate,
      earningsTiming: candidate.earningsTiming,
      daysToExpiry: candidate.daysToExpiry,
      expiry: candidate.expiry,
      stoppedAt: null,
      stageOne: {
        pass: ctx.industryStatus !== "fail",
        reason: "stage 1+2 failed during verify",
        details: { industry: ctx.industryClass ?? "" },
      },
      stageTwo: null,
      stageThree: null,
      stageFour: null,
      recommendation: "Needs analysis",
      errors: [e instanceof Error ? e.message : String(e)],
      isWhitelisted: ctx.isWhitelisted,
      industryStatus: ctx.industryStatus,
      spreadTooWide: false,
      threeLayer: null,
    };
    return { symbol: candidate.symbol, status: "unverified", result: placeholder, reason };
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const t0 = Date.now();
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const candidates = (body.candidates ?? []).slice(0, MAX_BATCH);
  if (candidates.length === 0) {
    return NextResponse.json({ rows: [] });
  }

  const { connected } = await isSchwabConnected().catch(() => ({
    connected: false,
  }));
  const { whitelist } = await getWatchlistSymbols();

  const rows = await Promise.all(
    candidates.map(async (c): Promise<EnrichedRow> => {
      const symbol = String(c.symbol ?? "").toUpperCase();
      const date = typeof c.date === "string" ? c.date : "";
      const timing =
        c.timing === "BMO" || c.timing === "AMC" ? c.timing : "AMC";
      const price = typeof c.price === "number" ? c.price : 0;
      const isWhitelisted = whitelist.has(symbol) || c.isWhitelisted === true;

      if (!symbol || !date) {
        return { symbol, status: "dropped", reason: "missing_fields" };
      }

      const candidate = buildCandidateFromEarnings(
        { symbol, date, timing },
        price,
      );

      // Industry classification (cache-only by default; whitelisted
      // names are allowed the slower Yahoo fallback so they don't
      // sit at "industry: unknown" forever).
      let cls = await getIndustryClassification(symbol, {
        yahooAllowed: false,
      });
      if (isWhitelisted && cls.source === "unknown") {
        cls = await getIndustryClassification(symbol, { yahooAllowed: true });
      }
      const industryStatus: "pass" | "fail" | "unknown" = isWhitelisted
        ? "pass"
        : cls.source === "unknown"
          ? "unknown"
          : cls.pass
            ? "pass"
            : "fail";
      const ctx: ScreenContext = {
        connected,
        chain: null,
        industryClass: cls.industry as ScreenContext["industryClass"],
        industryStatus,
        isWhitelisted,
      };

      // Schwab disconnected → unverified passthrough with Stage 1+2
      // populated. The client surfaces these with chainUnverified.
      if (!connected) {
        return buildShell(candidate, ctx, "schwab_disconnected");
      }

      // Single chain probe. Lets us distinguish:
      //   chain === null         → Schwab unreachable (unverified)
      //   chain present, no wkly → verified absent (dropped unless whitelisted)
      //   chain present + wkly   → run full Stage 1+2+3+4
      let chain;
      try {
        chain = await safeGetChain(symbol, candidate.expiry, candidate.expiry);
      } catch (e) {
        return buildShell(candidate, ctx, e instanceof Error ? e.message : "throw");
      }

      if (chain === null) {
        return buildShell(candidate, ctx, "schwab_error");
      }

      const looksValid =
        (chain.putExpDateMap &&
          Object.keys(chain.putExpDateMap).length > 0) ||
        (chain.callExpDateMap &&
          Object.keys(chain.callExpDateMap).length > 0);
      if (!looksValid) {
        return buildShell(candidate, ctx, "empty_response");
      }

      const hasWeekly = chainHasWeeklyExpiry(chain, candidate.expiry);
      if (!hasWeekly && !isWhitelisted) {
        return { symbol, status: "dropped", reason: "no_weekly_friday" };
      }

      // Stage 1+2 — runs cheaply with chain in context so Stage 1
      // weeklyExpiryFound is real rather than null.
      let oneTwo: ScreenerResult;
      try {
        oneTwo = await evaluateStagesOneTwo(candidate, { ...ctx, chain });
      } catch (e) {
        return buildShell(candidate, ctx, e instanceof Error ? e.message : "stage12_throw");
      }

      // Quality floor — Stage 2 pass is forced to true for whitelisted
      // names inside runStageTwo, so this drop only ever fires on
      // non-whitelisted symbols below the floor.
      if (oneTwo.stageTwo && !oneTwo.stageTwo.pass) {
        return {
          symbol,
          status: "dropped",
          reason: `stage2_floor:${oneTwo.stageTwo.score}/${oneTwo.stageTwo.maxScore}`,
        };
      }

      // Stage 3+4 with the chain we already fetched. Whitelisted names
      // without a weekly expiry pass through here as a Stage 1+2 only
      // shell (stoppedAt=3) since runStagesThreeFour will short-circuit.
      let final: ScreenerResult;
      try {
        final = await runStagesThreeFour(oneTwo, chain);
      } catch (e) {
        // Treat a hard throw as unverified — keep the Stage 1+2 shell
        // visible to the user instead of dropping.
        return {
          symbol,
          status: "unverified",
          result: oneTwo,
          reason: e instanceof Error ? e.message : "stage34_throw",
        };
      }

      if (!final.stageThree || !final.stageFour) {
        // Chain was present at probe but Stage 3+4 still bailed
        // (concurrent rotation, IV missing, etc.). Pass through as
        // unverified so the user can retry via Run Analysis.
        return {
          symbol,
          status: "unverified",
          result: final,
          reason: "stage34_incomplete",
        };
      }

      return { symbol, status: "scored", result: final };
    }),
  );

  const scored = rows.filter((r) => r.status === "scored").length;
  const unverified = rows.filter((r) => r.status === "unverified").length;
  const dropped = rows.filter((r) => r.status === "dropped").length;
  console.log(
    `[verify-chains] batch=${candidates.length} scored=${scored} unverified=${unverified} dropped=${dropped} · ${Date.now() - t0}ms`,
  );

  return NextResponse.json({ rows });
}

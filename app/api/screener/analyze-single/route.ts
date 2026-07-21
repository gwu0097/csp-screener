import { NextRequest, NextResponse } from "next/server";
import { getBatchPrices } from "@/lib/price";
import { isSchwabConnected } from "@/lib/schwab";
import {
  runStagesThreeFour,
  calculateThreeLayerGrade,
  getPersonalHistory,
  ScreenerResult,
} from "@/lib/screener";
import { getEarningsNewsContext } from "@/lib/perplexity";
import { getMarketContext } from "@/lib/market";
import { getCachedCompanyName } from "@/lib/market-snapshot";
import { requireUserId, authErrorResponse } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;
// Per-symbol refresh of pass 2 + pass 3 logic. CSP screener candidates
// live in localStorage, not a DB table, so the client passes the row
// in. We re-run Schwab options + Perplexity news + grade for that one
// candidate. Skips tracked_tickers / position snapshots / encyclopedia
// maintenance — those run on the full-table analyze path.
export const maxDuration = 60;

type Body = {
  candidate?: unknown;
  // Sandbox ("Test any ticker") calls set this so the pipeline skips
  // its earnings_history market-data writes — the sandbox candidate
  // carries a synthetic earnings date. Nothing else here persists.
  sandbox?: unknown;
  // When true, the user has opted into analyzing a symbol that the
  // Stage 2 quality floor would normally fail. The route-level
  // pipeline doesn't currently gate on Stage 2 (see lib/screener.ts
  // recommendation logic — purely Stage 3+4 driven), so `force` is a
  // breadcrumb for future gating + a clearer log line today.
  force?: unknown;
};

function isCandidate(v: unknown): v is ScreenerResult {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.symbol === "string" &&
    typeof o.earningsDate === "string" &&
    typeof o.expiry === "string"
  );
}

export async function POST(req: NextRequest) {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch (e) {
    return authErrorResponse(e);
  }
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
  if (!isCandidate(body.candidate)) {
    return NextResponse.json(
      { error: "Missing or malformed candidate object" },
      { status: 400 },
    );
  }
  const base = body.candidate;
  const upper = base.symbol.toUpperCase();
  const force = body.force === true;
  const sandbox = body.sandbox === true;
  if (force) {
    console.log(`[analyze-single] ${upper} force=true — Stage 2 quality floor explicitly bypassed`);
  }

  const [priceMap, market] = await Promise.all([
    getBatchPrices([upper]),
    getMarketContext().catch(() => ({
      vix: null,
      spyPrice: null,
      regime: null,
      warning: null,
    })),
  ]);
  const refreshedPrice = priceMap[upper] ?? base.price ?? 0;
  const vix = market.vix;

  // ---- Pass 2 — Schwab options + stages 3/4 ----
  let scored: ScreenerResult;
  try {
    scored = await runStagesThreeFour({ ...base, price: refreshedPrice }, { skipPersist: sandbox });
  } catch (e) {
    return NextResponse.json(
      {
        error: `Stages 3/4 failed: ${e instanceof Error ? e.message : String(e)}`,
      },
      { status: 502 },
    );
  }

  // ---- Pass 3 — Perplexity news + personal history + three-layer grade ----
  if (!scored.stageThree || !scored.stageFour) {
    return NextResponse.json({ result: scored, vix });
  }
  const companyName = (await getCachedCompanyName(upper).catch(() => null)) ?? upper;
  const [news, personal] = await Promise.all([
    getEarningsNewsContext(upper, companyName, base.earningsDate).catch(() => ({
      summary: "News fetch failed",
      sentiment: "neutral" as const,
      hasActiveOverhang: false,
      overhangDescription: null,
      sources: [],
      gradePenalty: 0,
    })),
    getPersonalHistory(userId, upper).catch(() => ({
      tradeCount: 0,
      winRate: null,
      avgRoc: null,
      dataInsufficient: true,
    })),
  ]);
  const threeLayer = calculateThreeLayerGrade(
    scored.stageThree,
    scored.stageFour,
    news,
    personal,
    vix,
    scored.price,
  );

  return NextResponse.json({ result: { ...scored, threeLayer }, vix });
}

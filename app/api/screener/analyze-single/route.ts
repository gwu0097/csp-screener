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
import { createServerClient } from "@/lib/supabase";
import {
  resolveSandboxEarnings,
  sandboxExpiryFor,
  SANDBOX_LOOKAHEAD_DAYS,
  SANDBOX_LOOKBACK_DAYS,
  type SandboxEarnings,
  type SandboxEarningsRow,
} from "@/lib/sandbox-earnings";

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
  // may carry a stand-in earnings date (see withSandboxEarnings). Nothing else here persists.
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

// Sandbox candidates arrive with today's date as a stand-in. Swap in the
// symbol's real print from earnings_history when one is near today so
// the dump header, the saved-flags lookup and the paste-back box all key
// on the actual event. stageOne.details.earningsDateSource tells the UI
// which it got; "stand_in" means nothing may be saved against the date.
async function withSandboxEarnings(candidate: ScreenerResult, symbol: string): Promise<ScreenerResult> {
  const today = new Date().toISOString().slice(0, 10);
  const shift = (days: number) => new Date(Date.parse(today + "T00:00:00Z") + days * 86400000).toISOString().slice(0, 10);
  let resolved: SandboxEarnings | null = null;
  try {
    const res = await createServerClient()
      .from("earnings_history")
      .select("earnings_date,timing")
      .eq("symbol", symbol)
      .gte("earnings_date", shift(-SANDBOX_LOOKBACK_DAYS))
      .lte("earnings_date", shift(SANDBOX_LOOKAHEAD_DAYS));
    if (res.error) throw new Error(res.error.message);
    resolved = resolveSandboxEarnings(today, (res.data ?? []) as SandboxEarningsRow[]);
  } catch (e) {
    console.warn(`[analyze-single] ${symbol} sandbox earnings lookup failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!resolved) {
    return {
      ...candidate,
      stageOne: { ...candidate.stageOne, details: { ...candidate.stageOne.details, earningsDateSource: "stand_in" } },
    };
  }
  const expiry = sandboxExpiryFor(today, resolved);
  const daysToExpiry = Math.max(1, Math.round((Date.parse(expiry) - Date.parse(today)) / 86400000));
  return {
    ...candidate,
    earningsDate: resolved.earningsDate,
    earningsTiming: resolved.timing,
    expiry,
    daysToExpiry,
    stageOne: {
      ...candidate.stageOne,
      details: {
        ...candidate.stageOne.details,
        earningsDateSource: "earnings_history",
        earningsTimingAssumed: resolved.timingAssumed,
      },
    },
  };
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
  const upper = body.candidate.symbol.toUpperCase();
  const force = body.force === true;
  const sandbox = body.sandbox === true;
  const base = sandbox ? await withSandboxEarnings(body.candidate, upper) : body.candidate;
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
      priorCspEarningsLoss: false,
    })),
  ]);
  // Saved research_analyses flags for this candidate — feeds
  // riskScore's measured-flag contributions only; [] when unsaved.
  let flagsFired: string[] = [];
  try {
    const sb = createServerClient();
    const flagsRes = await sb
      .from("research_analyses")
      .select("flags_fired")
      .eq("symbol", upper)
      .eq("earnings_date", base.earningsDate)
      .maybeSingle();
    flagsFired = (flagsRes.data as { flags_fired: string[] } | null)?.flags_fired ?? [];
  } catch (e) {
    console.warn(`[analyze-single] flags_fired fetch failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  const threeLayer = calculateThreeLayerGrade(
    scored.stageThree,
    scored.stageFour,
    news,
    personal,
    vix,
    scored.price,
    undefined,
    scored.expirySource,
    flagsFired,
  );

  return NextResponse.json({ result: { ...scored, threeLayer }, vix });
}

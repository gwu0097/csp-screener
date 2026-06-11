import { NextRequest, NextResponse } from "next/server";
import {
  calculateThreeLayerGrade,
  getPersonalHistory,
  type ScreenerResult,
} from "@/lib/screener";
import { type PerplexityNewsResult } from "@/lib/perplexity";
import { createServerClient } from "@/lib/supabase";
import { requireUserId, authErrorResponse } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;
// Pass 3b — given a batch of candidates plus a pre-fetched news map
// (from pass3a), compute the three-layer grade per candidate and
// upsert tracked_tickers entry rows for the batch. News fetching is
// handled in pass3a; the slow maintenance work (position snapshots +
// encyclopedia upkeep) lives in /post-actions, which the client fires
// without awaiting after the final batch — so this route stays bounded
// by the (fast) personal-history queries + a few upserts and the user
// gets grades back without waiting on bookkeeping.
export const maxDuration = 60;

type NewsByKey = Record<string, PerplexityNewsResult>;

type Body = {
  candidates?: unknown;
  // { "SYM|YYYY-MM-DD": NewsContext } — same key shape pass3a returns.
  newsByKey?: NewsByKey;
  vix?: number | null;
  trackedSymbols?: string[];
};

const NEUTRAL_NEWS: PerplexityNewsResult = {
  summary: "News not yet fetched",
  sentiment: "neutral",
  hasActiveOverhang: false,
  overhangDescription: null,
  sources: [],
  gradePenalty: 0,
};

function keyOf(symbol: string, earningsDate: string): string {
  return `${symbol}|${earningsDate}`;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

async function upsertTrackedTickers(
  userId: string,
  results: ScreenerResult[],
  tracked: Set<string>,
  vix: number | null,
): Promise<{ upserted: number; errors: string[] }> {
  const errors: string[] = [];
  let upserted = 0;
  if (tracked.size === 0) return { upserted: 0, errors: [] };
  try {
    const supabase = createServerClient();
    const screenedDate = todayIso();
    for (const r of results) {
      if (!tracked.has(r.symbol.toUpperCase())) continue;
      if (!r.threeLayer) continue;
      const row = {
        user_id: userId,
        symbol: r.symbol.toUpperCase(),
        expiry: r.expiry,
        screened_date: screenedDate,
        suggested_strike: r.stageFour?.suggestedStrike ?? null,
        entry_crush_grade: r.threeLayer.industryFactors.crushGrade,
        entry_opportunity_grade: r.threeLayer.industryFactors.opportunityGrade,
        entry_final_grade: r.threeLayer.finalGrade,
        entry_iv_edge: r.threeLayer.industryFactors.ivEdge,
        entry_em_pct: r.stageThree?.details?.expectedMovePct ?? null,
        entry_vix: vix,
        entry_news_summary: r.threeLayer.regimeFactors.newsSummary,
        entry_stock_price: r.price,
      };
      const { error: uErr } = await supabase
        .from("tracked_tickers")
        .upsert(row, { onConflict: "user_id,symbol,expiry,screened_date" });
      if (uErr) {
        errors.push(`${r.symbol}: ${uErr.message}`);
        continue;
      }
      upserted += 1;
    }
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
  }
  return { upserted, errors };
}

export async function POST(req: NextRequest) {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch (e) {
    return authErrorResponse(e);
  }
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!Array.isArray(body.candidates)) {
    return NextResponse.json(
      { error: "Missing candidates array" },
      { status: 400 },
    );
  }
  const candidates = body.candidates as ScreenerResult[];
  const newsByKey = (body.newsByKey ?? {}) as NewsByKey;
  const tracked = new Set(
    (body.trackedSymbols ?? []).map((s) => String(s).toUpperCase()),
  );
  const vix = typeof body.vix === "number" ? body.vix : null;

  const t0 = Date.now();

  // Personal history + grade compute per candidate, in parallel.
  // Personal history is a Supabase query (fast). The grade is pure
  // compute. News falls back to a neutral object when pass3a hasn't
  // landed yet for this stock — keeps the route robust to client
  // ordering bugs without spuriously penalizing the grade.
  const results = await Promise.all(
    candidates.map(async (base): Promise<ScreenerResult> => {
      if (!base.stageThree || !base.stageFour) return base;
      const personal = await getPersonalHistory(userId, base.symbol).catch(() => ({
        tradeCount: 0,
        winRate: null,
        avgRoc: null,
        dataInsufficient: true,
      }));
      const news =
        newsByKey[keyOf(base.symbol, base.earningsDate)] ?? NEUTRAL_NEWS;
      const threeLayer = calculateThreeLayerGrade(
        base.stageThree,
        base.stageFour,
        news,
        personal,
        vix,
        base.price,
      );
      return { ...base, threeLayer };
    }),
  );

  const scoredCount = results.filter((r) => r.threeLayer !== null).length;

  // Tracked upsert runs on EVERY batch, scoped to this batch's results.
  // It's a handful of idempotent upserts (no external APIs), and the
  // candidate sort puts tracked symbols in the earliest batches — the
  // old final-batch-only gate meant tracked rows from earlier batches
  // never got their entry snapshot written.
  const trackedResult = await upsertTrackedTickers(userId, results, tracked, vix);
  if (trackedResult.errors.length > 0) {
    console.warn(
      `[analyze/pass3b] tracked upsert errors: ${trackedResult.errors.join("; ")}`,
    );
  }

  const elapsed = Date.now() - t0;
  console.log(
    `[analyze/pass3b] ${candidates.length} candidates (${scoredCount} scored) · ${elapsed}ms · tracked=${trackedResult.upserted}`,
  );

  return NextResponse.json({
    results,
    scoredCount,
    trackedUpserted: trackedResult.upserted,
    elapsedMs: elapsed,
  });
}

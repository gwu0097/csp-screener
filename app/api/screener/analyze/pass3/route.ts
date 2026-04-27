import { NextRequest, NextResponse } from "next/server";
import { getOptionsChain } from "@/lib/schwab";
import {
  calculateThreeLayerGrade,
  getPersonalHistory,
  ScreenerResult,
} from "@/lib/screener";
import { getEarningsNewsContext } from "@/lib/perplexity";
import { createServerClient } from "@/lib/supabase";
import { type Fill } from "@/lib/positions";
import { buildSnapshotRow } from "@/lib/snapshots";
import { runEncyclopediaMaintenance } from "@/lib/encyclopedia";

export const dynamic = "force-dynamic";
export const revalidate = 0;
// Pass 3 = Perplexity news per candidate + three-layer grade calc, then
// tracked_tickers upsert + position snapshots + encyclopedia
// maintenance. Each block is bounded so the whole route fits inside the
// 60s Hobby ceiling.
export const maxDuration = 60;

type Body = {
  candidates?: unknown;
  vix?: number | null;
  trackedSymbols?: string[];
};

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

// Snapshots current option price + P&L + Greeks for every open position.
// Writes one row per position into position_snapshots. Same logic as
// the close-time snapshot path in /api/trades/bulk-create.
async function writePositionSnapshots(): Promise<{ written: number; errors: string[] }> {
  const errors: string[] = [];
  let written = 0;
  try {
    const supabase = createServerClient();
    const { data: opens, error: pErr } = await supabase
      .from("positions")
      .select(
        "id, symbol, strike, expiry, total_contracts, avg_premium_sold, opened_date, entry_stock_price, entry_em_pct",
      )
      .eq("status", "open");
    if (pErr) {
      return { written: 0, errors: [`fetch open positions: ${pErr.message}`] };
    }
    const positions = (opens ?? []) as Array<{
      id: string;
      symbol: string;
      strike: number;
      expiry: string;
      total_contracts: number;
      avg_premium_sold: number | null;
      opened_date: string | null;
      entry_stock_price: number | null;
      entry_em_pct: number | null;
    }>;
    if (positions.length === 0) return { written: 0, errors: [] };

    const positionIds = positions.map((p) => p.id);
    const { data: fillsRaw } = await supabase
      .from("fills")
      .select("position_id, fill_type, contracts, premium, fill_date")
      .in("position_id", positionIds);
    const fillsByPosition = new Map<string, Fill[]>();
    for (const f of (fillsRaw ?? []) as Array<Fill & { position_id: string }>) {
      const arr = fillsByPosition.get(f.position_id) ?? [];
      arr.push({
        fill_type: f.fill_type,
        contracts: f.contracts,
        premium: f.premium,
        fill_date: f.fill_date,
      });
      fillsByPosition.set(f.position_id, arr);
    }

    // One chain fetch per unique symbol.
    const chainCache = new Map<string, Awaited<ReturnType<typeof getOptionsChain>> | null>();
    await Promise.all(
      Array.from(new Set(positions.map((p) => p.symbol))).map(async (sym) => {
        try {
          const chain = await getOptionsChain(sym);
          chainCache.set(sym, chain);
        } catch (e) {
          console.warn(`[snapshots] chain(${sym}) failed: ${e instanceof Error ? e.message : e}`);
          chainCache.set(sym, null);
        }
      }),
    );

    const nowIso = new Date().toISOString();
    const todayStr = nowIso.slice(0, 10);
    for (const p of positions) {
      const chain = chainCache.get(p.symbol) ?? null;
      const isExpiryDay = (p.expiry ?? "") <= todayStr;
      const row = buildSnapshotRow(p, chain, fillsByPosition.get(p.id) ?? [], {
        nowIso,
        closeSnapshot: isExpiryDay,
      });
      const { error: iErr } = await supabase.from("position_snapshots").insert(row);
      if (iErr) {
        errors.push(`${p.symbol}: ${iErr.message}`);
        continue;
      }
      written += 1;
    }
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
  }
  return { written, errors };
}

async function upsertTrackedTickers(
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
        .upsert(row, { onConflict: "symbol,expiry,screened_date" });
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
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!Array.isArray(body.candidates)) {
    return NextResponse.json({ error: "Missing candidates array" }, { status: 400 });
  }

  const scored = body.candidates as ScreenerResult[];
  const tracked = new Set(
    (body.trackedSymbols ?? []).map((s) => String(s).toUpperCase()),
  );
  const vix = typeof body.vix === "number" ? body.vix : null;

  // News + personal history + three-layer grade per candidate, in
  // parallel so the wall-clock stays bounded by the slowest Perplexity
  // call rather than summed.
  const results = await Promise.all(
    scored.map(async (base): Promise<ScreenerResult> => {
      if (!base.stageThree || !base.stageFour) return base;
      const [news, personal] = await Promise.all([
        getEarningsNewsContext(base.symbol, base.symbol).catch(() => ({
          summary: "News fetch failed",
          sentiment: "neutral" as const,
          hasActiveOverhang: false,
          overhangDescription: null,
          sources: [],
          gradePenalty: 0,
        })),
        getPersonalHistory(base.symbol).catch(() => ({
          tradeCount: 0,
          winRate: null,
          avgRoc: null,
          dataInsufficient: true,
        })),
      ]);
      const threeLayer = calculateThreeLayerGrade(
        base.stageThree,
        base.stageFour,
        news,
        personal,
        vix,
      );
      return { ...base, threeLayer };
    }),
  );

  const scoredCount = results.filter((r) => r.threeLayer !== null).length;

  // Tracked + snapshots + encyclopedia in parallel after grading.
  const [trackedResult, snapshotResult, encyclopediaUpdates] = await Promise.all([
    upsertTrackedTickers(results, tracked, vix),
    writePositionSnapshots(),
    (async () => {
      try {
        const report = await runEncyclopediaMaintenance();
        return (
          report.t0Captured.length +
          report.t1Captured.length +
          report.expiryBackfilled.length +
          report.perplexityBackfilled.length
        );
      } catch (e) {
        console.warn(
          `[analyze/pass3:encyclopedia] failed: ${e instanceof Error ? e.message : e}`,
        );
        return 0;
      }
    })(),
  ]);

  console.log(
    `[analyze/pass3] ${results.length} candidates (${scoredCount} scored), tracked=${trackedResult.upserted}, snapshots=${snapshotResult.written}, encyclopedia=${encyclopediaUpdates}`,
  );

  return NextResponse.json({
    results,
    scoredCount,
    trackedUpserted: trackedResult.upserted,
    snapshotsWritten: snapshotResult.written,
    encyclopediaUpdates,
  });
}

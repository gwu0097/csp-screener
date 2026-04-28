import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import {
  getOptionsChain,
  getOptionsChainWide,
  SchwabOptionContract,
} from "@/lib/schwab";
import { getCurrentPrice, getHistoricalPrices } from "@/lib/yahoo";
import { getMarketContext } from "@/lib/market";
import {
  computePositionBadge,
  recommendPosition,
  postEarningsMomentum,
  isTwoDayDrop,
  remainingContracts,
  URGENCY_ORDER,
  type BadgeColor,
  type Urgency,
  type Momentum,
  type Fill,
  type PositionRow,
} from "@/lib/positions";
import { runAutoExpire, type AutoExpireReport } from "@/lib/expire-positions";
import { buildSnapshotRow, shouldWriteSnapshot } from "@/lib/snapshots";

export const dynamic = "force-dynamic";
// Loops over every open position to pull a Schwab options chain + Yahoo
// quote + earnings snapshot. Per-call timeouts in lib/positions keep a
// single slow upstream from blowing the 60s Hobby ceiling on users
// with many open legs.
export const maxDuration = 60;

type PostEarningsRecView = {
  recommendation: "CLOSE" | "HOLD" | "PARTIAL" | "MONITOR";
  confidence: "HIGH" | "MEDIUM" | "LOW";
  reasoning: string;
  ruleFired: string;
  analysisDate: string;
  moveRatio: number | null;
  ivCrushed: boolean | null;
  ivCrushMagnitude: number | null;
  breachedTwoXem: boolean | null;
  analystSentiment: string | null;
  recoveryLikelihood: string | null;
  stockPctFromStrike: number | null;
};

type OpenPosition = {
  id: string;
  symbol: string;
  broker: string;
  strike: number;
  expiry: string;
  optionType: "put" | "call";
  totalContracts: number;      // contracts originally opened
  remainingContracts: number;  // contracts still open
  avgPremiumSold: number | null;
  openedDate: string;
  currentStockPrice: number | null;
  currentMark: number | null;
  currentBid: number | null;
  currentAsk: number | null;
  currentDelta: number | null;
  currentTheta: number | null;
  currentIv: number | null;
  dte: number;
  pnlDollars: number | null;
  pnlPct: number | null;
  distanceToStrikePct: number | null;
  thetaDecayTotal: number | null;
  momentum: Momentum | null;
  urgency: Urgency;
  recommendationReason: string;
  // Priority-cascade status badge — supersedes the urgency enum for
  // the collapsed-row status column. urgency is retained for the
  // (soft-deprecated) existing consumers. Fields come straight from
  // computePositionBadge().
  badge: string;
  badgeLabel: string;
  badgeColor: BadgeColor;
  badgeTooltip: string;
  ruleFired: string;
  postEarningsRec: PostEarningsRecView | null;
  fills: Fill[];
  // Expiry classification (from runAutoExpire):
  //   active             — expiry >= today, normal open position
  //   needs_verification — expiry < today, within 2% of strike —
  //                        user must decide expired vs. assigned
  //   pending            — expiry < today but no snapshot to classify
  expiryStatus: "active" | "needs_verification" | "pending";
  // Only populated when expiryStatus != "active".
  expiryPctFromStrike: number | null;
  expiryLastStockPrice: number | null;
  // Entry snapshot — populated at position-open time from the screener's
  // three-layer grade. Used by the expanded position card for the
  // left-column "what did we see at entry" panel.
  entryFinalGrade: string | null;
  entryCrushGrade: string | null;
  entryOpportunityGrade: string | null;
  entryIndustryGrade: string | null;
  entryRegimeGrade: string | null;
  entryIvEdge: number | null;
  entryEmPct: number | null;
  entryVix: number | null;
  entryStockPrice: number | null;
};

function daysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / (24 * 60 * 60 * 1000));
}

function pickContractFromChain(
  chain: Awaited<ReturnType<typeof getOptionsChain>>,
  strike: number,
  expiry: string,
): SchwabOptionContract | null {
  const keys = Object.keys(chain.putExpDateMap ?? {});
  const expKey = keys.find((k) => k.startsWith(expiry));
  if (!expKey) return null;
  const strikes = chain.putExpDateMap[expKey];
  const wanted = String(Number(strike));
  const direct = strikes[wanted] ?? strikes[strike.toFixed(2)] ?? null;
  if (direct && direct.length > 0) return direct[0];
  let best: SchwabOptionContract | null = null;
  let bestDiff = Infinity;
  for (const contracts of Object.values(strikes)) {
    for (const c of contracts) {
      const d = Math.abs(c.strikePrice - strike);
      if (d < bestDiff) {
        best = c;
        bestDiff = d;
      }
    }
  }
  return best;
}

// Wraps an async upstream with a hard timeout; resolves to null on timeout
// or throw so a single slow/failed call can't stall the whole batch.
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      console.warn(`[positions] ${label} timed out after ${ms}ms`);
      resolve(null);
    }, ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        console.warn(`[positions] ${label} threw: ${e instanceof Error ? e.message : e}`);
        resolve(null);
      },
    );
  });
}

export async function GET(req: NextRequest) {
  const opportunityAvailable =
    req.nextUrl.searchParams.get("opportunityAvailable") === "true";
  const live = req.nextUrl.searchParams.get("live") === "true";

  // Auto-expire sweep BEFORE fetching open positions. Clearly-worthless
  // expired positions flip to status='expired_worthless' in place; the
  // subsequent open-list query then correctly excludes them. The report
  // is also returned to the caller so the UI can toast the auto-expired
  // names and surface the remaining needs_verification positions.
  let expireReport: AutoExpireReport;
  try {
    expireReport = await runAutoExpire();
  } catch (e) {
    console.warn(
      `[positions] runAutoExpire failed: ${e instanceof Error ? e.message : e}`,
    );
    expireReport = {
      auto_expired: [],
      needs_verification: [],
      pending: [],
      skipped: false,
      skipReason: e instanceof Error ? e.message : "unknown",
    };
  }

  const supabase = createServerClient();

  // 1. Open positions + all their fills.
  const { data: posRows, error: pErr } = await supabase
    .from<PositionRow>("positions")
    .select("*")
    .eq("status", "open")
    .order("opened_date", { ascending: true });
  if (pErr) {
    return NextResponse.json({ error: pErr.message }, { status: 500 });
  }
  const positionsList = (posRows ?? []) as PositionRow[];

  // Fetch all fills for these positions in one call.
  const positionIds = positionsList.map((p) => p.id);
  const fillsByPosition = new Map<string, Fill[]>();
  if (positionIds.length > 0) {
    const { data: fillsRows } = await supabase
      .from<Fill & { position_id: string }>("fills")
      .select("id, position_id, fill_type, contracts, premium, fill_date")
      .in("position_id", positionIds);
    for (const f of (fillsRows ?? []) as Array<Fill & { position_id: string }>) {
      const arr = fillsByPosition.get(f.position_id) ?? [];
      arr.push({
        id: f.id,
        fill_type: f.fill_type,
        contracts: f.contracts,
        premium: f.premium,
        fill_date: f.fill_date,
      });
      fillsByPosition.set(f.position_id, arr);
    }
  }

  const now = new Date();

  // Build a lookup of (positionId → expiry classification) from the
  // auto-expire report. Positions in auto_expired are already flipped
  // to expired_worthless in the DB and won't reach the open list, so
  // they're not in this map. Remaining expired open positions get
  // 'needs_verification' or 'pending' annotations that the UI surfaces.
  const expiryByPosition = new Map<
    string,
    {
      status: "needs_verification" | "pending";
      pctFromStrike: number | null;
      stockPrice: number | null;
    }
  >();
  for (const e of expireReport.needs_verification) {
    expiryByPosition.set(e.positionId, {
      status: "needs_verification",
      pctFromStrike: e.pctFromStrike,
      stockPrice: e.stockPrice,
    });
  }
  for (const e of expireReport.pending) {
    expiryByPosition.set(e.positionId, {
      status: "pending",
      pctFromStrike: e.pctFromStrike,
      stockPrice: e.stockPrice,
    });
  }

  // Entry-grade fallback: positions that opened before the grade-merge
  // feature (or via screenshot import that didn't find a tracked_tickers
  // row) have entry_final_grade = null. Look up the most recent
  // tracked_tickers row per symbol so the UI can still show a badge.
  // This makes the display consistent across brokers — both Schwab NOW
  // and Robinhood NOW end up with the same fallback grade.
  const gradeFallbackBySymbol = new Map<string, string | null>();
  {
    const symbols = Array.from(new Set(positionsList.map((p) => p.symbol.toUpperCase())));
    if (symbols.length > 0) {
      const trRes = await supabase
        .from("tracked_tickers")
        .select("symbol,entry_final_grade,screened_date")
        .in("symbol", symbols)
        .order("screened_date", { ascending: false });
      const trRows = ((trRes.data ?? []) as Array<{
        symbol: string;
        entry_final_grade: string | null;
      }>);
      for (const r of trRows) {
        const sym = r.symbol.toUpperCase();
        if (gradeFallbackBySymbol.has(sym)) continue;
        if (r.entry_final_grade) gradeFallbackBySymbol.set(sym, r.entry_final_grade);
      }
    }
  }

  // Latest position_snapshot per position — feeds computePositionBadge
  // (pct_premium_remaining, move_ratio, current_delta, last known
  // stock / option prices). One query, dedupe in memory to keep the
  // latest row per position_id.
  type LatestSnapshot = {
    stock_price: number | null;
    option_price: number | null;
    current_delta: number | null;
    move_ratio: number | null;
    pct_premium_remaining: number | null;
  };
  const latestSnapshotByPosition = new Map<string, LatestSnapshot>();
  if (positionIds.length > 0) {
    const snapRes = await supabase
      .from("position_snapshots")
      .select(
        "position_id,snapshot_time,stock_price,option_price,current_delta,move_ratio,pct_premium_remaining",
      )
      .in("position_id", positionIds)
      .order("snapshot_time", { ascending: false });
    const snapRows = (snapRes.data ?? []) as Array<{
      position_id: string;
      snapshot_time: string;
      stock_price: number | null;
      option_price: number | null;
      current_delta: number | null;
      move_ratio: number | null;
      pct_premium_remaining: number | null;
    }>;
    for (const row of snapRows) {
      if (latestSnapshotByPosition.has(row.position_id)) continue;
      latestSnapshotByPosition.set(row.position_id, {
        stock_price: row.stock_price,
        option_price: row.option_price,
        current_delta: row.current_delta,
        move_ratio: row.move_ratio,
        pct_premium_remaining: row.pct_premium_remaining,
      });
    }
  }

  // Fetch the latest post-earnings recommendation per position in one
  // query. We take the newest row per position (by analysis_date desc)
  // and dedupe in memory, so a same-day rerun still shows today's rec.
  const recsByPosition = new Map<string, PostEarningsRecView>();
  if (positionIds.length > 0) {
    const recRes = await supabase
      .from("post_earnings_recommendations")
      .select(
        "position_id,analysis_date,move_ratio,iv_crushed,iv_crush_magnitude,breached_two_x_em,analyst_sentiment,recovery_likelihood,stock_pct_from_strike,recommendation,confidence,reasoning,rule_fired",
      )
      .in("position_id", positionIds)
      .order("analysis_date", { ascending: false });
    const allRecs = (recRes.data ?? []) as Array<{
      position_id: string;
      analysis_date: string;
      move_ratio: number | null;
      iv_crushed: boolean | null;
      iv_crush_magnitude: number | null;
      breached_two_x_em: boolean | null;
      analyst_sentiment: string | null;
      recovery_likelihood: string | null;
      stock_pct_from_strike: number | null;
      recommendation: "CLOSE" | "HOLD" | "PARTIAL" | "MONITOR";
      confidence: "HIGH" | "MEDIUM" | "LOW";
      reasoning: string;
      rule_fired: string;
    }>;
    for (const r of allRecs) {
      if (recsByPosition.has(r.position_id)) continue;
      recsByPosition.set(r.position_id, {
        recommendation: r.recommendation,
        confidence: r.confidence,
        reasoning: r.reasoning,
        ruleFired: r.rule_fired,
        analysisDate: r.analysis_date,
        moveRatio: r.move_ratio,
        ivCrushed: r.iv_crushed,
        ivCrushMagnitude: r.iv_crush_magnitude,
        breachedTwoXem: r.breached_two_x_em,
        analystSentiment: r.analyst_sentiment,
        recoveryLikelihood: r.recovery_likelihood,
        stockPctFromStrike: r.stock_pct_from_strike,
      });
    }
  }

  const marketPromise = getMarketContext();

  const positionPromises = positionsList.map(async (p) => {
    const fills = fillsByPosition.get(p.id) ?? [];
    const remaining = remainingContracts(fills);
    const strike = Number(p.strike);
    const expiry = p.expiry;
    const dte = daysBetween(now, new Date(expiry + "T00:00:00Z"));

    const spotPromise = withTimeout(getCurrentPrice(p.symbol), 5000, `spot(${p.symbol})`);
    // Wide chain (strikeCount=200) so deep-OTM positions like SPOT $410
    // on a $495 stock are actually in the response — the default 30-
    // strike chain centers on ATM and silently fuzzy-snaps a far-OTM
    // strike to the nearest in-window contract, producing the wrong
    // mark + a wildly wrong P&L on the position card.
    const chainPromise = live
      ? withTimeout(getOptionsChainWide(p.symbol, expiry), 15000, `chain(${p.symbol})`)
      : Promise.resolve(null);
    const barsPromise = live
      ? withTimeout(
          getHistoricalPrices(
            p.symbol,
            new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000),
            now,
          ),
          5000,
          `bars(${p.symbol})`,
        ).then((r) => r ?? [])
      : Promise.resolve([] as Awaited<ReturnType<typeof getHistoricalPrices>>);

    const [yahooPrice, chain, bars] = await Promise.all([
      spotPromise,
      chainPromise,
      barsPromise,
    ]);

    const contract = chain ? pickContractFromChain(chain, strike, expiry) : null;
    const currentStockPrice =
      chain?.underlying?.mark ??
      chain?.underlying?.last ??
      chain?.underlyingPrice ??
      yahooPrice ??
      null;

    const mark = contract?.mark ?? null;
    const bid = contract?.bid ?? null;
    const ask = contract?.ask ?? null;
    const delta = contract?.delta ?? null;
    const theta = contract?.theta ?? null;
    const rawIv = contract?.volatility ?? null;
    const iv = rawIv !== null ? (rawIv > 1 ? rawIv / 100 : rawIv) : null;

    const premiumSold = Number(p.avg_premium_sold ?? 0);
    const pnlDollars =
      mark !== null && premiumSold > 0
        ? (premiumSold - mark) * remaining * 100
        : null;
    const pnlPct =
      mark !== null && premiumSold > 0 ? ((premiumSold - mark) / premiumSold) * 100 : null;

    const distanceToStrikePct =
      currentStockPrice !== null && currentStockPrice > 0
        ? ((currentStockPrice - strike) / currentStockPrice) * 100
        : null;

    const closesArr = bars.map((b) => b.close).filter((c) => c > 0);
    const twoDayDrop = isTwoDayDrop(closesArr);

    const momentum =
      currentStockPrice !== null ? postEarningsMomentum(null, currentStockPrice) : null;

    const rec = recommendPosition({
      profitPct: pnlPct ?? 0,
      distanceToStrikePct: distanceToStrikePct ?? 100,
      dte: Math.max(0, dte),
      entryDelta: null,
      currentDelta: delta,
      currentTheta: theta,
      entryStockPrice: null,
      currentStockPrice: currentStockPrice ?? 0,
      twoDayDrop,
      opportunityAvailable,
    });

    const thetaDecayTotal =
      theta !== null && dte > 0 ? theta * dte * remaining * 100 : null;

    // Priority-cascade badge — replaces the mechanical urgency-derived
    // status for the collapsed row.
    const badgeResult = computePositionBadge({
      position: { strike, expiry },
      latestSnapshot: latestSnapshotByPosition.get(p.id) ?? null,
      postEarningsRec: recsByPosition.get(p.id)
        ? {
            recommendation: (recsByPosition.get(p.id) as PostEarningsRecView).recommendation,
            confidence: (recsByPosition.get(p.id) as PostEarningsRecView).confidence,
            reasoning: (recsByPosition.get(p.id) as PostEarningsRecView).reasoning,
          }
        : null,
      currentStockPrice,
    });

    const out: OpenPosition = {
      id: p.id,
      symbol: p.symbol,
      broker: p.broker,
      strike,
      expiry,
      optionType: "put",
      totalContracts: p.total_contracts,
      remainingContracts: remaining,
      avgPremiumSold: p.avg_premium_sold !== null ? Number(p.avg_premium_sold) : null,
      openedDate: p.opened_date,
      currentStockPrice,
      currentMark: mark,
      currentBid: bid,
      currentAsk: ask,
      currentDelta: delta,
      currentTheta: theta,
      currentIv: iv,
      dte: Math.max(0, dte),
      pnlDollars,
      pnlPct,
      distanceToStrikePct,
      thetaDecayTotal,
      momentum,
      urgency: rec.urgency,
      recommendationReason: rec.reason,
      badge: badgeResult.badge,
      badgeLabel: badgeResult.label,
      badgeColor: badgeResult.color,
      badgeTooltip: badgeResult.tooltip,
      ruleFired: badgeResult.ruleFired,
      postEarningsRec: recsByPosition.get(p.id) ?? null,
      expiryStatus: expiryByPosition.get(p.id)?.status ?? "active",
      expiryPctFromStrike: expiryByPosition.get(p.id)?.pctFromStrike ?? null,
      expiryLastStockPrice: expiryByPosition.get(p.id)?.stockPrice ?? null,
      fills: fills
        .slice()
        .sort((a, b) => a.fill_date.localeCompare(b.fill_date)),
      entryFinalGrade:
        (p as unknown as { entry_final_grade?: string | null }).entry_final_grade ??
        gradeFallbackBySymbol.get(p.symbol.toUpperCase()) ??
        null,
      entryCrushGrade: (p as unknown as { entry_crush_grade?: string | null }).entry_crush_grade ?? null,
      entryOpportunityGrade:
        (p as unknown as { entry_opportunity_grade?: string | null }).entry_opportunity_grade ?? null,
      entryIndustryGrade:
        (p as unknown as { entry_industry_grade?: string | null }).entry_industry_grade ?? null,
      entryRegimeGrade:
        (p as unknown as { entry_regime_grade?: string | null }).entry_regime_grade ?? null,
      entryIvEdge: (p as unknown as { entry_iv_edge?: number | null }).entry_iv_edge ?? null,
      entryEmPct: (p as unknown as { entry_em_pct?: number | null }).entry_em_pct ?? null,
      entryVix: (p as unknown as { entry_vix?: number | null }).entry_vix ?? null,
      entryStockPrice:
        (p as unknown as { entry_stock_price?: number | null }).entry_stock_price ?? null,
    };

    // Snapshot-on-refresh: in live mode, after we've resolved the chain
    // + contract, persist a position_snapshots row. Skip when:
    //   - not live (no live data to snapshot anyway)
    //   - chain or contract missing (partial writes are worse than none)
    //   - rate limit hits (< 60 min since last snapshot for this position)
    // Result tracked so the caller can surface a count in the response.
    let snapshotResult: "written" | "skipped_rate" | "skipped_no_data" = "skipped_no_data";
    if (live && chain && contract) {
      try {
        const allowed = await shouldWriteSnapshot(p.id);
        if (!allowed) {
          snapshotResult = "skipped_rate";
        } else {
          const todayStr = new Date().toISOString().slice(0, 10);
          const isExpiryDay = (expiry ?? "") <= todayStr;
          const snapshotRow = buildSnapshotRow(
            {
              id: p.id,
              symbol: p.symbol,
              strike,
              expiry,
              avg_premium_sold: p.avg_premium_sold,
              opened_date: p.opened_date,
              entry_stock_price:
                (p as unknown as { entry_stock_price?: number | null })
                  .entry_stock_price ?? null,
              entry_em_pct:
                (p as unknown as { entry_em_pct?: number | null }).entry_em_pct ?? null,
            },
            chain,
            fills,
            { nowIso: new Date().toISOString(), closeSnapshot: isExpiryDay },
          );
          // Guard against partial writes: buildSnapshotRow's strict
          // strike lookup is stricter than pickContractFromChain's
          // fuzzy fallback, so a contract pass at the outer gate can
          // still produce a snapshot with null option_price/IV/delta
          // (deep OTM strike no longer listed in the chain on expiry
          // day). Per spec, partial data is worse than no data — skip.
          if (snapshotRow.option_price === null || snapshotRow.current_iv === null) {
            console.warn(
              `[positions:refresh-snapshot] ${p.symbol} $${strike} exp=${expiry}: partial snapshot (option=${snapshotRow.option_price} iv=${snapshotRow.current_iv}) — skipping write`,
            );
            snapshotResult = "skipped_no_data";
          } else {
            const ins = await supabase.from("position_snapshots").insert(snapshotRow);
            if (ins.error) {
              console.warn(
                `[positions:refresh-snapshot] ${p.symbol} insert failed: ${ins.error.message}`,
              );
              snapshotResult = "skipped_no_data";
            } else {
              snapshotResult = "written";
            }
          }
        }
      } catch (e) {
        console.warn(
          `[positions:refresh-snapshot] ${p.symbol} threw: ${e instanceof Error ? e.message : e}`,
        );
      }
    }
    return { out, snapshotResult };
  });

  const [market, resolved] = await Promise.all([
    marketPromise,
    Promise.all(positionPromises),
  ]);

  // Tally snapshot outcomes so the UI can show "2 snapshots saved"
  // vs "snapshots up to date". Only written/skipped_rate are user-
  // visible — skipped_no_data is the common case (no chain, no
  // contract, or live=false) and doesn't warrant surfacing.
  let snapshotsWritten = 0;
  let snapshotsSkipped = 0;
  for (const r of resolved) {
    if (r.snapshotResult === "written") snapshotsWritten += 1;
    else if (r.snapshotResult === "skipped_rate") snapshotsSkipped += 1;
  }
  const positions = resolved.map((r) => r.out);

  positions.sort((a, b) => {
    const u = URGENCY_ORDER[a.urgency] - URGENCY_ORDER[b.urgency];
    if (u !== 0) return u;
    return a.dte - b.dte;
  });

  return NextResponse.json({
    market,
    positions,
    opportunityAvailable,
    live,
    expireReport,
    snapshotsWritten,
    snapshotsSkipped,
  });
}

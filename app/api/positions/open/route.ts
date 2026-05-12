import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import {
  getOptionsChain,
  getOptionsChainWide,
  SchwabOptionContract,
} from "@/lib/schwab";
import { getQuoteWithExtended, getHistoricalPrices } from "@/lib/yahoo";
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
  // 'pre' = pre-market quote, 'post' = after-hours quote, 'regular' =
  // normal session, null = no live data resolved. The UI shows an
  // AH/PM badge for the non-regular sessions so the user knows the
  // figure isn't the official close.
  priceSource: "pre" | "post" | "regular" | null;
  currentMark: number | null;
  currentBid: number | null;
  currentAsk: number | null;
  currentDelta: number | null;
  currentTheta: number | null;
  currentIv: number | null;
  dte: number;
  pnlDollars: number | null;
  pnlPct: number | null;
  // Why pnlDollars is what it is. 'mark' = computed off the live
  // option mark (most accurate). 'intrinsic' = ITM put estimate
  // when the option mark is unavailable: pnl = (entry - intrinsic)
  // × qty × 100. 'maxProfitOtm' = OTM put with no mark — assume
  // worthless and credit full premium. null = no P&L computed.
  pnlSource: "mark" | "intrinsic" | "maxProfitOtm" | null;
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
  // True when the stored expiry doesn't exist in Schwab's chain
  // (drifted by more than the picker tolerance or rejected outright).
  // Drives the ⚠️ badge on the row so the user can correct the
  // strike/expiry — see the SE 2026-05-26 vs 2026-05-22 case.
  expiryNotInChain: boolean;
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

// Picker tolerances. Both used to be generous (14d drift, unbounded
// strike snap) which silently picked the wrong contract when an
// expiry was misread on import — see the SE $64P 2026-05-26 case
// where the date didn't exist (Tuesday, no listed weekly) and the
// picker drifted to 2026-05-29 then snapped $64 → $65, returning a
// completely different contract's mark and producing a -$1,290
// phantom P&L. Tightened so a true miss returns null and the row
// shows "—" with a warning badge instead.
const MAX_EXP_DRIFT_MS = 7 * 86400000;
const MAX_STRIKE_SNAP = 1.0;

// `reason` flags the failure mode so the route can decide whether
// to fall through to an intrinsic-value estimate (chain present but
// uninformative — fine to estimate) or suppress P&L entirely
// (chain mismatch — estimates would also be wrong).
type PickReason =
  | "ok"
  | "no_chain"
  | "drift_too_large"
  | "snap_too_large"
  | "drift_and_snap";

function pickContractFromChain(
  chain: Awaited<ReturnType<typeof getOptionsChain>>,
  strike: number,
  expiry: string,
): {
  contract: SchwabOptionContract | null;
  pickedExpKey: string | null;
  expDriftDays: number | null;
  strikeSnap: number | null;
  reason: PickReason;
} {
  const keys = Object.keys(chain.putExpDateMap ?? {});
  if (keys.length === 0) {
    return {
      contract: null,
      pickedExpKey: null,
      expDriftDays: null,
      strikeSnap: null,
      reason: "no_chain",
    };
  }
  let expKey: string | undefined = keys.find((k) => k.startsWith(expiry));
  let driftDays = 0;
  if (!expKey) {
    const target = new Date(`${expiry}T00:00:00Z`).getTime();
    let bestKey: string | null = null;
    let bestDiff = Infinity;
    for (const k of keys) {
      const datePart = k.split(":")[0];
      const t = new Date(`${datePart}T00:00:00Z`).getTime();
      if (Number.isNaN(t)) continue;
      const diff = Math.abs(t - target);
      if (diff < bestDiff) {
        bestKey = k;
        bestDiff = diff;
      }
    }
    if (bestKey === null || bestDiff > MAX_EXP_DRIFT_MS) {
      return {
        contract: null,
        pickedExpKey: null,
        expDriftDays:
          bestKey !== null ? Math.round(bestDiff / 86400000) : null,
        strikeSnap: null,
        reason: "drift_too_large",
      };
    }
    expKey = bestKey;
    driftDays = Math.round(bestDiff / 86400000);
  }
  const strikes = chain.putExpDateMap[expKey];
  const wanted = String(Number(strike));
  const direct = strikes[wanted] ?? strikes[strike.toFixed(2)] ?? null;
  if (direct && direct.length > 0) {
    return {
      contract: direct[0],
      pickedExpKey: expKey,
      expDriftDays: driftDays,
      strikeSnap: 0,
      reason: "ok",
    };
  }
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
  if (best === null) {
    return {
      contract: null,
      pickedExpKey: expKey,
      expDriftDays: driftDays,
      strikeSnap: null,
      reason: "snap_too_large",
    };
  }
  if (bestDiff > MAX_STRIKE_SNAP) {
    return {
      contract: null,
      pickedExpKey: expKey,
      expDriftDays: driftDays,
      strikeSnap: bestDiff,
      reason: "snap_too_large",
    };
  }
  if (driftDays > 0 && bestDiff > 0) {
    // Both axes had to fudge — that's two layers of "best guess"
    // stacked, which is the SE failure mode. Refuse rather than
    // return a doubly-approximated contract.
    return {
      contract: null,
      pickedExpKey: expKey,
      expDriftDays: driftDays,
      strikeSnap: bestDiff,
      reason: "drift_and_snap",
    };
  }
  return {
    contract: best,
    pickedExpKey: expKey,
    expDriftDays: driftDays,
    strikeSnap: bestDiff,
    reason: "ok",
  };
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
      pending_confirmation: [],
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
  const allRows = (posRows ?? []) as PositionRow[];

  // Partition by position_type. Pre-migration rows have NULL
  // position_type and are treated as options (the original meaning
  // of the table). Stock rows are surfaced via a separate
  // stockPositions[] in the response so the UI can render them in a
  // dedicated section without the option-specific columns.
  const positionsList: PositionRow[] = [];
  const stockRows: PositionRow[] = [];
  for (const r of allRows) {
    const t = (r as unknown as { position_type?: string | null }).position_type;
    if (t === "stock_long" || t === "stock_short") stockRows.push(r);
    else positionsList.push(r);
  }

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

    const spotPromise = withTimeout(
      getQuoteWithExtended(p.symbol),
      5000,
      `spot(${p.symbol})`,
    );
    // Wide chain (strikeCount=200) so deep-OTM positions like SPOT $410
    // on a $495 stock are actually in the response — the default 30-
    // strike chain centers on ATM and silently fuzzy-snaps a far-OTM
    // strike to the nearest in-window contract, producing the wrong
    // mark + a wildly wrong P&L on the position card.
    const chainPromise = live
      ? withTimeout(
          getOptionsChainWide(p.symbol, expiry, 7),
          15000,
          `chain(${p.symbol})`,
        )
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

    const [yahooQuote, chain, bars] = await Promise.all([
      spotPromise,
      chainPromise,
      barsPromise,
    ]);

    const pickResult: {
      contract: SchwabOptionContract | null;
      pickedExpKey: string | null;
      expDriftDays: number | null;
      strikeSnap?: number | null;
      reason?: PickReason;
    } = chain
      ? pickContractFromChain(chain, strike, expiry)
      : {
          contract: null,
          pickedExpKey: null,
          expDriftDays: null,
          strikeSnap: null,
          reason: "no_chain",
        };
    const contract = pickResult.contract;
    // Picker rejected the chain on tolerance — neither the live
    // mark nor a stock-price fallback estimate would line up with
    // the actual position. Surface "—" instead, with a warning
    // badge so the user can see the row needs verification.
    const pickerRejected =
      pickResult.reason === "drift_too_large" ||
      pickResult.reason === "snap_too_large" ||
      pickResult.reason === "drift_and_snap";
    const expiryNotInChain =
      chain !== null &&
      (pickResult.reason === "drift_too_large" ||
        pickResult.reason === "drift_and_snap" ||
        // Expiry was found but strike couldn't be matched within
        // tolerance — likely a wrong strike, but the expiry is fine.
        // Not surfaced as an expiry warning.
        false);

    // Stock-price source priority. Yahoo's extended-hours quote
    // (PRE/POST) takes precedence so % OTM reflects the latest
    // tradable price the user can actually act on. Schwab's chain
    // underlying.mark tracks regular session and is the right answer
    // during market hours OR when Yahoo doesn't have an extended
    // quote available.
    const yahooPrice = yahooQuote?.price ?? null;
    let currentStockPrice: number | null;
    let priceSource: "pre" | "post" | "regular" | null;
    if (
      yahooQuote &&
      (yahooQuote.source === "pre" || yahooQuote.source === "post") &&
      yahooQuote.price !== null &&
      yahooQuote.price > 0
    ) {
      currentStockPrice = yahooQuote.price;
      priceSource = yahooQuote.source;
    } else {
      currentStockPrice =
        chain?.underlying?.mark ??
        chain?.underlying?.last ??
        chain?.underlyingPrice ??
        yahooPrice ??
        null;
      priceSource = currentStockPrice !== null ? "regular" : null;
    }

    const mark = contract?.mark ?? null;
    const bid = contract?.bid ?? null;
    const ask = contract?.ask ?? null;
    const delta = contract?.delta ?? null;
    const theta = contract?.theta ?? null;
    const rawIv = contract?.volatility ?? null;
    const iv = rawIv !== null ? (rawIv > 1 ? rawIv / 100 : rawIv) : null;

    const premiumSold = Number(p.avg_premium_sold ?? 0);
    let pnlDollars: number | null = null;
    let pnlPct: number | null = null;
    let pnlSource: "mark" | "intrinsic" | "maxProfitOtm" | null = null;
    if (mark !== null && premiumSold > 0) {
      pnlDollars = (premiumSold - mark) * remaining * 100;
      pnlPct = ((premiumSold - mark) / premiumSold) * 100;
      pnlSource = "mark";
    } else if (
      !pickerRejected &&
      currentStockPrice !== null &&
      currentStockPrice > 0 &&
      premiumSold > 0
    ) {
      // Mark missing — fall back to an intrinsic-value estimate so
      // the position card still shows a number on expiry day when
      // option chains stop quoting. ITM puts: subtract intrinsic
      // from the entry premium. OTM puts: assume worthless and
      // credit full premium.
      //
      // Skipped when the picker rejected the chain on tolerance
      // (drift > 7d, strike snap > $1, or both axes drifted). In
      // that case the chain doesn't agree with the stored row and
      // an estimate would also be wrong — better to show "—" with
      // a warning badge.
      if (currentStockPrice < strike) {
        const intrinsic = strike - currentStockPrice;
        pnlDollars = (premiumSold - intrinsic) * remaining * 100;
        pnlPct = ((premiumSold - intrinsic) / premiumSold) * 100;
        pnlSource = "intrinsic";
      } else {
        pnlDollars = premiumSold * remaining * 100;
        pnlPct = 100;
        pnlSource = "maxProfitOtm";
      }
    }
    if (pickerRejected) {
      console.log(
        `[positions] ${p.symbol} $${strike}P ${expiry}: no contract match within tolerance (${pickResult.reason}, drift=${pickResult.expDriftDays ?? "—"}d snap=${pickResult.strikeSnap ?? "—"}) — showing P&L as null`,
      );
    }

    const distanceToStrikePct =
      currentStockPrice !== null && currentStockPrice > 0
        ? ((currentStockPrice - strike) / currentStockPrice) * 100
        : null;

    // Per-position mark/entry/pnl log — runs for every position on
    // every live request so server logs surface the math for any
    // reported anomaly. Format intentionally short so a 20-position
    // refresh isn't visual spam. expDriftDays != 0 flags rows whose
    // expiry was fuzzy-matched (a common silent-miss source).
    if (live) {
      const fmt2 = (v: number | null) => (v === null ? "—" : v.toFixed(2));
      const drift = pickResult.expDriftDays;
      const driftFlag = drift !== null && drift > 0 ? ` exp-drift=${drift}d` : "";
      const pickedStrike = pickResult.contract?.strikePrice ?? null;
      const strikeMismatch =
        pickedStrike !== null && Math.abs(pickedStrike - strike) > 0.01
          ? ` strike-snap=${strike}→${pickedStrike}`
          : "";
      console.log(
        `[positions] ${p.symbol} $${strike}P ${expiry}: mark=${fmt2(mark)} entry=${fmt2(premiumSold > 0 ? premiumSold : null)} pnl=${fmt2(pnlDollars)}${driftFlag}${strikeMismatch}`,
      );
    }

    // Diagnostic: when Live refresh leaves a position without a P&L or
    // POP (delta) figure, log exactly which step dropped it. Includes
    // broker so we can correlate with Robinhood / Schwab2 patterns.
    // The cascade is chain → contract → mark/delta → premium; the
    // first null wins as `fail`.
    if (live) {
      const popMissing = delta === null;
      const pnlMissing = pnlDollars === null;
      const drifted =
        pickResult.expDriftDays !== null && pickResult.expDriftDays > 0;
      if (popMissing || pnlMissing || drifted) {
        const premiumSoldOk = premiumSold > 0;
        const failStep =
          chain === null
            ? "chain"
            : contract === null
              ? "contract"
              : mark === null && delta === null
                ? "mark+delta"
                : mark === null
                  ? "mark"
                  : delta === null
                    ? "delta"
                    : !premiumSoldOk
                      ? "no_premium"
                      : "ok_drifted";
        const fmt = (v: number | null) => (v === null ? "null" : String(v));
        const expKeys = chain
          ? Object.keys(chain.putExpDateMap ?? {})
              .slice(0, 6)
              .join(",")
          : "";
        console.log(
          `[positions:live-diag] broker=${p.broker ?? "null"} symbol=${p.symbol} strike=${strike} expiry=${expiry} qty=${remaining} chain=${chain === null ? "miss" : "hit"} contract=${contract === null ? "miss" : "hit"} pickedExpKey=${pickResult.pickedExpKey ?? "null"} expDriftDays=${pickResult.expDriftDays ?? "null"} chainKeys=[${expKeys}] mark=${fmt(mark)} delta=${fmt(delta)} iv=${fmt(iv)} stock=${fmt(currentStockPrice)} yahooStock=${fmt(yahooPrice)} entryPremium=${fmt(p.avg_premium_sold !== null ? Number(p.avg_premium_sold) : null)} pnlDollars=${fmt(pnlDollars)} pnlPct=${fmt(pnlPct)} fail=${failStep}`,
        );
      }
    }

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
      priceSource,
      currentMark: mark,
      currentBid: bid,
      currentAsk: ask,
      currentDelta: delta,
      currentTheta: theta,
      currentIv: iv,
      dte: Math.max(0, dte),
      pnlDollars,
      pnlPct,
      pnlSource,
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
      expiryNotInChain,
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

  // Stock positions (assigned shares, etc.) — fetch live spot once
  // per unique symbol and zip into the response. No chain lookup
  // (stocks don't have one). Cost basis is stored as
  // entry_stock_price; total_contracts on a stock row holds the
  // share count.
  type StockOut = {
    id: string;
    symbol: string;
    broker: string;
    positionType: "stock_long" | "stock_short";
    shares: number;
    costBasis: number | null;
    currentStockPrice: number | null;
    priceSource: "pre" | "post" | "regular" | null;
    pnlDollars: number | null;
    pnlPct: number | null;
    openedDate: string | null;
    notes: string | null;
    assignmentSourceId: string | null;
  };
  const stockPositions: StockOut[] = [];
  if (stockRows.length > 0) {
    const uniqueSymbols = Array.from(
      new Set(stockRows.map((r) => r.symbol.toUpperCase())),
    );
    const quoteMap = new Map<
      string,
      { price: number | null; source: "pre" | "post" | "regular" | null }
    >();
    // Always fetch spot for stocks regardless of `live` — they're
    // single Yahoo calls, fast, and the user expects a current
    // unrealized P&L on every Refresh, not just on Live.
    await Promise.all(
      uniqueSymbols.map(async (sym) => {
        const q = await withTimeout(
          getQuoteWithExtended(sym),
          5000,
          `stock-spot(${sym})`,
        );
        quoteMap.set(sym, {
          price: q?.price ?? null,
          source: q?.source ?? null,
        });
      }),
    );
    for (const r of stockRows) {
      const sym = r.symbol.toUpperCase();
      const shares = Number(
        (r as unknown as { total_contracts: number }).total_contracts ?? 0,
      );
      const costBasis =
        (r as unknown as { entry_stock_price?: number | null })
          .entry_stock_price ?? null;
      const q = quoteMap.get(sym) ?? { price: null, source: null };
      const direction =
        (r as unknown as { position_type?: string }).position_type ===
        "stock_short"
          ? "stock_short"
          : "stock_long";
      const pnl =
        q.price !== null && costBasis !== null
          ? direction === "stock_long"
            ? (q.price - costBasis) * shares
            : (costBasis - q.price) * shares
          : null;
      const pnlPct =
        pnl !== null && costBasis !== null && costBasis > 0
          ? (pnl / (costBasis * shares)) * 100
          : null;
      stockPositions.push({
        id: r.id,
        symbol: r.symbol,
        broker:
          (r as unknown as { broker?: string }).broker ?? "schwab",
        positionType: direction,
        shares,
        costBasis: costBasis !== null ? Number(costBasis) : null,
        currentStockPrice: q.price,
        priceSource: q.source,
        pnlDollars: pnl !== null ? Math.round(pnl * 100) / 100 : null,
        pnlPct: pnlPct !== null ? Math.round(pnlPct * 100) / 100 : null,
        openedDate:
          (r as unknown as { opened_date?: string | null }).opened_date ?? null,
        notes:
          (r as unknown as { notes?: string | null }).notes ?? null,
        assignmentSourceId:
          (r as unknown as { assignment_source_id?: string | null })
            .assignment_source_id ?? null,
      });
    }
  }

  return NextResponse.json({
    market,
    positions,
    stockPositions,
    opportunityAvailable,
    live,
    expireReport,
    snapshotsWritten,
    snapshotsSkipped,
  });
}

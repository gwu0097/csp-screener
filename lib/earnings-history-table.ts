// Helpers for the per-quarter crush history surfaced on the screener
// expanded row. Reads earnings_history rows for a symbol, derives a
// per-event ratio + grade, and labels each row by calendar quarter.

import { createServerClient } from "@/lib/supabase";
import type { OptionsFlow } from "@/lib/options-flow";

export type CrushHistoryEvent = {
  earningsDate: string;
  qtrLabel: string;
  impliedMovePct: number | null;
  actualMovePct: number | null;
  ratio: number | null;
  grade: "A" | "B" | "C" | "D" | "F" | null;
  impliedMoveSource: string | null;
};

// Quarter label from earnings date. Companies typically report a
// fiscal quarter ~1 month after it ends, so:
//   Jan-Mar → prior year Q4
//   Apr-Jun → current year Q1
//   Jul-Sep → current year Q2
//   Oct-Dec → current year Q3
export function quarterLabel(dateIso: string): string {
  const [y, m] = dateIso.split("-").map(Number);
  if (!y || !m) return "—";
  if (m <= 3) return `Q4 ${y - 1}`;
  if (m <= 6) return `Q1 ${y}`;
  if (m <= 9) return `Q2 ${y}`;
  return `Q3 ${y}`;
}

// Per-event grade from ratio (matches the global crush bands the user
// described — A < 0.7, B < 0.85, C < 1.0, D < 1.2, F otherwise).
export function gradeFromRatio(ratio: number | null): CrushHistoryEvent["grade"] {
  if (ratio === null || !Number.isFinite(ratio)) return null;
  if (ratio < 0.7) return "A";
  if (ratio < 0.85) return "B";
  if (ratio < 1.0) return "C";
  if (ratio < 1.2) return "D";
  return "F";
}

// Pulls the last `limit` earnings_history rows for a symbol with the
// fields the crush table needs. Caller can run this in parallel with
// other stage-3 work.
export async function getCrushHistory(
  symbol: string,
  limit = 8,
): Promise<CrushHistoryEvent[]> {
  const sb = createServerClient();
  const res = await sb
    .from("earnings_history")
    .select(
      "earnings_date,implied_move_pct,actual_move_pct,move_ratio,implied_move_source",
    )
    .eq("symbol", symbol.toUpperCase())
    .order("earnings_date", { ascending: false })
    .limit(limit);
  if (res.error) {
    console.warn(
      `[earnings-history-table] ${symbol} fetch failed: ${res.error.message}`,
    );
    return [];
  }
  type Row = {
    earnings_date: string;
    implied_move_pct: number | null;
    actual_move_pct: number | null;
    move_ratio: number | null;
    implied_move_source: string | null;
  };
  const rows = (res.data ?? []) as Row[];
  return rows.map((r) => {
    const ratio =
      r.move_ratio ??
      (r.actual_move_pct !== null &&
      r.implied_move_pct !== null &&
      r.implied_move_pct > 0
        ? Math.abs(r.actual_move_pct) / r.implied_move_pct
        : null);
    return {
      earningsDate: r.earnings_date,
      qtrLabel: quarterLabel(r.earnings_date),
      impliedMovePct: r.implied_move_pct,
      actualMovePct: r.actual_move_pct,
      ratio,
      grade: gradeFromRatio(ratio),
      impliedMoveSource: r.implied_move_source,
    };
  });
}

// ---------- Fix B: empirical E[loss|breach] shrinkage ladder ----------
//
// Reads (implied_move_pct, actual_move_pct) pairs directly — NOT the
// two_x_em_strike/breached_two_x_em columns, which calculateBreachAnalysis
// computes but which are populated on only ~1% of rows (the encyclopedia
// backfill that would run it broadly is out of scope this pass). This
// recomputes the same breach test at read time from data that's actually
// there.
//
// Ladder: ticker -> sector -> global pool, weight scales with each tier's
// own BREACH count (not total event count — see LOSS_LADDER_MIN_BREACH_N).
// Mirrors getPersonalHistory's ticker/sector pattern (same industry-join
// query), rescaled: breach events are far rarer than trade outcomes, so
// Layer 2's 1/2/5 thresholds would promote on 1-4 anecdotes here.

export type LossMultiplierResult = {
  // E[loss | breach] expressed as a multiple of the candidate's OWN
  // implied move — e.g. 0.331 means "when a 2xEM strike breaches, it
  // lands ~0.331 EM further past it, on average." Applying this through
  // the candidate's own emPct is a units conversion (dimensionless
  // multiplier -> today's dollars), not a re-derivation of the multiplier
  // itself — the multiplier comes from pooled historical ratios, never
  // from this candidate's own emPct.
  multiplier: number;
  // Which tier actually has nonzero weight in the blend — "pool" when
  // both ticker and sector are dark. Parallel to termStructureExcluded /
  // expirySource: visible and segmentable, not folded away.
  source: "ticker" | "sector" | "pool";
  tickerBreachN: number;
  sectorBreachN: number;
  poolBreachN: number;
  poolEventN: number;
};

// Below this many BREACH events (not total events) in a tier, that
// tier's "mean overshoot" is 1-4 anecdotes, not a distribution — the
// PASS_2A sector gate check found all 6 global breaches land in 6
// different sectors, so a bar keyed on total events would promote a
// bucket the moment classification happens to fill in, not when there's
// real tail evidence. Rescaled from Layer 2's ticker sampleWeight
// thresholds (1/2/5 trades) since breach events are far rarer than trade
// outcomes; 5/10 is the same "graduated, capped at full weight" shape at
// a magnitude that fits how few breaches exist at all today (6 globally).
// Judgment call — tune if breach volume grows and this reads too strict
// or too loose in practice.
const LOSS_LADDER_MIN_BREACH_N = 5;
const LOSS_LADDER_FULL_WEIGHT_BREACH_N = 10;

// Only used if the live pool query returns literally zero breach events
// anywhere — shouldn't happen given current earnings_history volume
// (100+ paired events, 6+ breaches as of PASS_2A). A trip of this path
// is a data-availability incident worth investigating, not a normal
// code path; frozen at the pool's PASS_2A-measured value rather than 0
// so a transient query hiccup doesn't understate risk to zero.
const FALLBACK_LOSS_MULTIPLIER_NO_POOL_DATA = 0.331;

type NormalizedMoveRow = { symbol: string; normMove: number };

// Shared pool cache — the global-tier query is identical for every
// candidate, so fetch it once per process and reuse rather than
// re-querying ~1000 rows per candidate scored. Refreshed hourly; the
// pool only grows a handful of rows a week (new earnings prints), so
// staleness within an hour is a non-issue. Same shape as the existing
// daily_bars_cache pattern used elsewhere in this codebase.
let poolCache: { rows: NormalizedMoveRow[]; fetchedAt: number } | null = null;
const POOL_CACHE_TTL_MS = 60 * 60 * 1000;

async function getPoolEvents(): Promise<NormalizedMoveRow[]> {
  if (poolCache && Date.now() - poolCache.fetchedAt < POOL_CACHE_TTL_MS) {
    return poolCache.rows;
  }
  const sb = createServerClient();
  const res = await sb
    .from("earnings_history")
    .select("symbol,implied_move_pct,actual_move_pct")
    .limit(1000); // wrapper's read cap — see supabase-wrapper-limitations memory
  const rows = ((res.data ?? []) as Array<{
    symbol: string;
    implied_move_pct: number | null;
    actual_move_pct: number | null;
  }>)
    .filter((r) => r.implied_move_pct !== null && r.actual_move_pct !== null && r.implied_move_pct > 0)
    .map((r) => ({ symbol: r.symbol, normMove: r.actual_move_pct! / r.implied_move_pct! }));
  poolCache = { rows, fetchedAt: Date.now() };
  return rows;
}

// Mean overshoot beyond -2 EM-units among events that breached it — the
// building block for every tier. n is the BREACH count, not the input
// event count.
function conditionalOvershoot(events: NormalizedMoveRow[]): { n: number; multiplier: number | null } {
  const breaches = events.filter((e) => e.normMove < -2);
  if (breaches.length === 0) return { n: 0, multiplier: null };
  const mean = breaches.reduce((sum, b) => sum + (-2 - b.normMove), 0) / breaches.length;
  return { n: breaches.length, multiplier: mean };
}

function ladderWeight(breachN: number): number {
  if (breachN >= LOSS_LADDER_FULL_WEIGHT_BREACH_N) return 1.0;
  if (breachN >= LOSS_LADDER_MIN_BREACH_N) return 0.5;
  return 0;
}

export async function computeLossMultiplierLadder(symbol: string): Promise<LossMultiplierResult> {
  const upper = symbol.toUpperCase();
  const pool = await getPoolEvents();
  const poolStats = conditionalOvershoot(pool);
  const poolMultiplier = poolStats.multiplier ?? FALLBACK_LOSS_MULTIPLIER_NO_POOL_DATA;

  const tickerStats = conditionalOvershoot(pool.filter((r) => r.symbol === upper));

  const sb = createServerClient();
  let sectorStats: { n: number; multiplier: number | null } = { n: 0, multiplier: null };
  const profRes = await sb.from("stock_profiles").select("industry").eq("symbol", upper).limit(1);
  const industry = ((profRes.data ?? []) as Array<{ industry: string | null }>)[0]?.industry ?? null;
  if (industry) {
    const symsRes = await sb.from("stock_profiles").select("symbol").eq("industry", industry).limit(300);
    const peers = new Set(
      ((symsRes.data ?? []) as Array<{ symbol: string }>).map((r) => r.symbol.toUpperCase()),
    );
    sectorStats = conditionalOvershoot(pool.filter((r) => peers.has(r.symbol)));
  }

  const tickerWeight = ladderWeight(tickerStats.n);
  const sectorWeight = (1 - tickerWeight) * ladderWeight(sectorStats.n);
  const globalWeight = 1 - tickerWeight - sectorWeight;

  const multiplier =
    tickerWeight * (tickerStats.multiplier ?? poolMultiplier) +
    sectorWeight * (sectorStats.multiplier ?? poolMultiplier) +
    globalWeight * poolMultiplier;

  const source: LossMultiplierResult["source"] =
    tickerWeight > 0 ? "ticker" : sectorWeight > 0 ? "sector" : "pool";

  return {
    multiplier,
    source,
    tickerBreachN: tickerStats.n,
    sectorBreachN: sectorStats.n,
    poolBreachN: poolStats.n,
    poolEventN: pool.length,
  };
}

// Persists the live IV-implied move for a candidate's upcoming earnings
// event. Called from the screener when stage 3 computes emPct so we
// build a real per-event EM history over time. Only writes the two
// fields — other earnings_history columns stay untouched on update.
export async function persistLiveImpliedMove(
  symbol: string,
  earningsDate: string,
  emPct: number | null,
  source: "schwab" | "perplexity" = "schwab",
): Promise<void> {
  if (emPct === null || !Number.isFinite(emPct) || emPct <= 0) return;
  const sb = createServerClient();
  const upsert = await sb
    .from("earnings_history")
    .upsert(
      {
        symbol: symbol.toUpperCase(),
        earnings_date: earningsDate,
        implied_move_pct: emPct,
        implied_move_source: source,
      },
      { onConflict: "symbol,earnings_date" },
    );
  if (upsert.error) {
    console.warn(
      `[earnings-history-table] persist live EM ${symbol}@${earningsDate} failed: ${upsert.error.message}`,
    );
  }
}

// Persists a small options-flow snapshot for the upcoming earnings
// event alongside implied_move_pct. Captured during the screener's
// stage-3 analyze pass so future quarters can compare pre-print
// positioning against the actual outcome. Non-blocking on failure;
// the screener UI doesn't depend on this row write succeeding.
export async function persistFlowSnapshot(
  symbol: string,
  earningsDate: string,
  flow: OptionsFlow,
): Promise<void> {
  if (!earningsDate || !Number.isFinite(flow.putCallRatio)) return;
  const top3 = flow.unusualStrikes.slice(0, 3).map((u) => ({
    type: u.type,
    strike: u.strike,
    volume: u.volume,
    oi: u.oi,
    ratio: Number(u.volOiRatio.toFixed(2)),
    note: u.note,
  }));
  const sb = createServerClient();
  const upsert = await sb
    .from("earnings_history")
    .upsert(
      {
        symbol: symbol.toUpperCase(),
        earnings_date: earningsDate,
        flow_pc_ratio: Number(flow.putCallRatio.toFixed(3)),
        flow_bias: flow.flowBias,
        flow_deep_otm_put_pct: Number(
          flow.deepOtmPutCluster.pctOfTotalPutVolume.toFixed(2),
        ),
        flow_unusual_top3: top3,
        flow_captured_at: new Date().toISOString(),
      },
      { onConflict: "symbol,earnings_date" },
    );
  if (upsert.error) {
    console.warn(
      `[earnings-history-table] persist flow ${symbol}@${earningsDate} failed: ${upsert.error.message}`,
    );
  }
}

// Phase 2B: autonomous post-earnings recommendation engine.
//
// Reads Phase 2A outputs (earnings_history.move_ratio, iv_crushed,
// analyst_sentiment, recovery_likelihood) plus live snapshot/chain data,
// applies a small deterministic rule cascade, and emits one verdict per
// open position per day. Verdicts are stored on post_earnings_recommendations
// with the input snapshot attached so each row is a self-contained audit
// artifact.
//
// Design rules:
//   - Independent of the user's trading thesis. Data in → verdict out.
//   - Missing data → LOW-confidence MONITOR. Never fabricate.
//   - Idempotent per (position_id, YYYY-MM-DD) — same-day re-runs overwrite.
//   - Outcomes are recorded on close so the alignment flag can be tracked
//     without needing a separate post-mortem system.
import { createServerClient } from "@/lib/supabase";
import type { PositionRow } from "@/lib/positions";

export type Recommendation = "CLOSE" | "HOLD" | "PARTIAL" | "MONITOR";
export type Confidence = "HIGH" | "MEDIUM" | "LOW";

export type RuleFired =
  | "CLOSE_HIGH"
  | "CLOSE_MEDIUM_MOVE"
  | "CLOSE_MEDIUM_ITM"
  | "HOLD_HIGH"
  | "HOLD_MEDIUM"
  | "PARTIAL"
  | "MONITOR_DEFAULT"
  | "DATA_GATE";

export type RecommendationRow = {
  id: string;
  position_id: string;
  earnings_history_id: string | null;
  analysis_date: string;
  move_ratio: number | null;
  iv_crushed: boolean | null;
  iv_crush_magnitude: number | null;
  breached_two_x_em: boolean | null;
  analyst_sentiment: string | null;
  recovery_likelihood: string | null;
  stock_pct_from_strike: number | null;
  recommendation: Recommendation;
  confidence: Confidence;
  reasoning: string;
  rule_fired: RuleFired;
  position_outcome: string | null;
  actual_pnl_pct: number | null;
  outcome_recorded_at: string | null;
  was_system_aligned: boolean | null;
  created_at: string;
};

type EarningsHistoryRow = {
  id: string;
  symbol: string;
  earnings_date: string;
  move_ratio: number | null;
  iv_crushed: boolean | null;
  iv_crush_magnitude: number | null;
  breached_two_x_em: boolean | null;
  analyst_sentiment: string | null;
  news_summary: string | null;
};

type PerplexityPayloadRelevant = {
  recovery_likelihood?: "high" | "medium" | "low" | string;
  primary_reason_for_move?: string;
};

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function addDaysIso(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function parsePerplexity(raw: string | null): PerplexityPayloadRelevant | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PerplexityPayloadRelevant;
  } catch {
    return null;
  }
}

// Finds the earnings_history row most relevant to an open position:
// same symbol, earnings_date within the last 48 hours. Phase 1 quarter-end
// rows won't match this window — we only pick up Phase 2A live-captured
// announcement-date rows.
async function findRecentEarningsRow(
  symbol: string,
): Promise<EarningsHistoryRow | null> {
  const sb = createServerClient();
  const windowStart = addDaysIso(todayIso(), -2);
  const r = await sb
    .from("earnings_history")
    .select(
      "id,symbol,earnings_date,move_ratio,iv_crushed,iv_crush_magnitude,breached_two_x_em,analyst_sentiment,news_summary",
    )
    .eq("symbol", symbol.toUpperCase())
    .gte("earnings_date", windowStart)
    .lte("earnings_date", todayIso())
    .order("earnings_date", { ascending: false })
    .limit(1);
  const rows = (r.data ?? []) as EarningsHistoryRow[];
  return rows[0] ?? null;
}

// Latest snapshot stock price for the position. Run Analysis just took a
// fresh one in writePositionSnapshots, so this is usually seconds old.
// Falls back to null if no snapshots — analyzePositionPostEarnings will
// still produce a rec without stock_pct_from_strike in that case.
async function latestSnapshotStockPrice(positionId: string): Promise<number | null> {
  const sb = createServerClient();
  const r = await sb
    .from("position_snapshots")
    .select("stock_price,snapshot_time")
    .eq("position_id", positionId)
    .order("snapshot_time", { ascending: false })
    .limit(1);
  const rows = (r.data ?? []) as Array<{ stock_price: number | null }>;
  return rows[0]?.stock_price ?? null;
}

// Core rule cascade. First match wins. Each case returns the tuple
// (recommendation, confidence, reasoning, rule_fired). Keep the
// branches tight and data-only — no side effects, no logging here so
// the tests can exercise rules in isolation.
export function applyPostEarningsRules(input: {
  move_ratio: number | null;
  iv_crushed: boolean | null;
  analyst_sentiment: string | null;
  recovery_likelihood: string | null;
  stock_pct_from_strike: number | null;
}): {
  recommendation: Recommendation;
  confidence: Confidence;
  reasoning: string;
  rule_fired: RuleFired;
} {
  const { move_ratio, iv_crushed, analyst_sentiment, recovery_likelihood, stock_pct_from_strike } =
    input;

  if (move_ratio === null || iv_crushed === null) {
    return {
      recommendation: "MONITOR",
      confidence: "LOW",
      reasoning:
        "T0/T1 data not yet captured. Recommendation unavailable until next market open.",
      rule_fired: "DATA_GATE",
    };
  }

  const moveExceeded = move_ratio > 1.2;
  const noCrush = iv_crushed === false;
  const unfavorableNarrative =
    analyst_sentiment === "negative" || recovery_likelihood === "low";

  if (moveExceeded && noCrush && unfavorableNarrative) {
    return {
      recommendation: "CLOSE",
      confidence: "HIGH",
      reasoning:
        "Move exceeded implied by >20%, IV did not crush, and narrative is unfavorable. High probability of further downside. Exit.",
      rule_fired: "CLOSE_HIGH",
    };
  }

  if (moveExceeded) {
    return {
      recommendation: "CLOSE",
      confidence: "MEDIUM",
      reasoning:
        "Move exceeded implied by >20%. Premium likely expanded despite event resolution. Data favors exit even though IV/sentiment signals are mixed.",
      rule_fired: "CLOSE_MEDIUM_MOVE",
    };
  }

  if (
    stock_pct_from_strike !== null &&
    stock_pct_from_strike < -0.01 &&
    recovery_likelihood === "low"
  ) {
    return {
      recommendation: "CLOSE",
      confidence: "MEDIUM",
      reasoning:
        "Position ITM and Perplexity flags low recovery likelihood. Delta risk outweighs remaining theta.",
      rule_fired: "CLOSE_MEDIUM_ITM",
    };
  }

  const sentimentNotNegative =
    analyst_sentiment !== null && analyst_sentiment !== "negative";

  if (
    move_ratio < 0.8 &&
    iv_crushed === true &&
    stock_pct_from_strike !== null &&
    stock_pct_from_strike > 0.03 &&
    sentimentNotNegative
  ) {
    return {
      recommendation: "HOLD",
      confidence: "HIGH",
      reasoning:
        "Move came in under implied, IV crushed as expected, position is >3% OTM, narrative is non-negative. Classic successful setup — let theta finish.",
      rule_fired: "HOLD_HIGH",
    };
  }

  if (
    move_ratio < 1.0 &&
    iv_crushed === true &&
    (recovery_likelihood === "medium" || recovery_likelihood === "high")
  ) {
    return {
      recommendation: "HOLD",
      confidence: "MEDIUM",
      reasoning:
        "Move within implied and IV crushed. Narrative supports recovery. Hold through expiry.",
      rule_fired: "HOLD_MEDIUM",
    };
  }

  if (move_ratio >= 1.0 && move_ratio <= 1.2 && iv_crushed === true) {
    return {
      recommendation: "PARTIAL",
      confidence: "MEDIUM",
      reasoning:
        "Slightly exceeded implied but IV crushed. Mixed signal. Consider closing 50% to reduce exposure, hold remainder for theta into expiry.",
      rule_fired: "PARTIAL",
    };
  }

  return {
    recommendation: "MONITOR",
    confidence: "LOW",
    reasoning: "Signals don't match a clear rule. Monitor position manually.",
    rule_fired: "MONITOR_DEFAULT",
  };
}

export type AnalysisResult = RecommendationRow | null;

// Main per-position entry point. Reads Phase 2A data, runs rules, upserts
// one row per (position, day). Returns the stored recommendation row so
// the orchestrator can report on what fired.
export async function analyzePositionPostEarnings(
  position: PositionRow,
): Promise<AnalysisResult> {
  const sb = createServerClient();

  const history = await findRecentEarningsRow(position.symbol);
  if (!history) return null;

  const perplexity = parsePerplexity(history.news_summary);
  const recovery_likelihood = perplexity?.recovery_likelihood ?? null;

  const stockPrice = await latestSnapshotStockPrice(position.id);
  const stock_pct_from_strike =
    stockPrice !== null && Number(position.strike) > 0
      ? (stockPrice - Number(position.strike)) / Number(position.strike)
      : null;

  const verdict = applyPostEarningsRules({
    move_ratio: history.move_ratio,
    iv_crushed: history.iv_crushed,
    analyst_sentiment: history.analyst_sentiment,
    recovery_likelihood,
    stock_pct_from_strike,
  });

  // Idempotency: one rec per (position, day) via the DB-side unique
  // constraint on (position_id, analysis_day). analysis_day is a
  // generated column (analysis_date::date) so we never write it — just
  // set analysis_date and let Postgres compute the day. Same-day reruns
  // collide on the constraint and UPDATE instead of INSERT.
  const payload = {
    position_id: position.id,
    earnings_history_id: history.id,
    analysis_date: new Date().toISOString(),
    move_ratio: history.move_ratio,
    iv_crushed: history.iv_crushed,
    iv_crush_magnitude: history.iv_crush_magnitude,
    breached_two_x_em: history.breached_two_x_em,
    analyst_sentiment: history.analyst_sentiment,
    recovery_likelihood,
    stock_pct_from_strike,
    recommendation: verdict.recommendation,
    confidence: verdict.confidence,
    reasoning: verdict.reasoning,
    rule_fired: verdict.rule_fired,
  };

  const up = await sb
    .from("post_earnings_recommendations")
    .upsert(payload, { onConflict: "position_id,analysis_day" })
    .select()
    .single();
  if (up.error) {
    console.warn(`[post-earnings] upsert failed for ${position.symbol}: ${up.error.message}`);
    return null;
  }
  return up.data as RecommendationRow;
}

// Called when a position flips to closed. Derives outcome and alignment
// against the most recent recommendation we emitted. Silent no-op when
// there's no rec to close the loop on.
export async function recordPositionOutcome(positionId: string): Promise<void> {
  const sb = createServerClient();

  const posRes = await sb
    .from("positions")
    .select("id,symbol,strike,expiry,avg_premium_sold,total_contracts,realized_pnl,closed_date,opened_date,status")
    .eq("id", positionId)
    .limit(1);
  const position = ((posRes.data ?? []) as Array<{
    id: string;
    symbol: string;
    strike: number;
    expiry: string;
    avg_premium_sold: number | null;
    total_contracts: number;
    realized_pnl: number | null;
    closed_date: string | null;
    opened_date: string;
    status: string;
  }>)[0];
  if (!position) return;

  const recRes = await sb
    .from("post_earnings_recommendations")
    .select("*")
    .eq("position_id", positionId)
    .order("analysis_date", { ascending: false })
    .limit(1);
  const rec = ((recRes.data ?? []) as RecommendationRow[])[0];
  if (!rec) return;

  // actual_pnl_pct: fraction of collected premium kept. 1.0 = kept all,
  // 0.0 = break-even, negative = lost more than premium collected.
  const premiumSold = Number(position.avg_premium_sold ?? 0);
  const contracts = Number(position.total_contracts ?? 0);
  const totalPremium = premiumSold * contracts * 100;
  const realizedPnl = Number(position.realized_pnl ?? 0);
  const actual_pnl_pct = totalPremium > 0 ? realizedPnl / totalPremium : null;

  // Derive position_outcome.
  let position_outcome: string;
  const recDate = rec.analysis_date.slice(0, 10);
  const closedDate = position.closed_date ?? todayIso();
  const expiryDate = position.expiry;
  const closedSameDay = closedDate <= addDaysIso(recDate, 1);
  if (closedSameDay) {
    position_outcome = "CLOSED_EARLY";
  } else if (closedDate >= expiryDate) {
    position_outcome = "HELD_TO_EXPIRY";
  } else if (realizedPnl > 0) {
    position_outcome = "HELD_TO_PROFIT";
  } else {
    position_outcome = "HELD_TO_LOSS";
  }

  // was_system_aligned — only set for CLOSE and HOLD recs; PARTIAL and
  // MONITOR are too ambiguous to score cleanly, stay null.
  let was_system_aligned: boolean | null = null;
  if (rec.recommendation === "CLOSE") {
    // A CLOSE rec is "correct" if the position hadn't already captured
    // most of its premium — i.e., closing actually saved capital.
    // actual_pnl_pct < 0.3 = we hadn't reached 30% of max profit yet,
    // so closing at that point was a meaningful save.
    was_system_aligned = actual_pnl_pct !== null ? actual_pnl_pct < 0.3 : null;
  } else if (rec.recommendation === "HOLD") {
    if (position_outcome === "HELD_TO_PROFIT" || position_outcome === "HELD_TO_EXPIRY") {
      was_system_aligned = realizedPnl > 0;
    } else if (position_outcome === "HELD_TO_LOSS") {
      was_system_aligned = false;
    }
  }
  // PARTIAL / MONITOR remain null.

  const update = await sb
    .from("post_earnings_recommendations")
    .update({
      position_outcome,
      actual_pnl_pct,
      outcome_recorded_at: new Date().toISOString(),
      was_system_aligned,
    })
    .eq("id", rec.id);
  if (update.error) {
    console.warn(
      `[post-earnings] recordPositionOutcome(${positionId}) update failed: ${update.error.message}`,
    );
  }
}

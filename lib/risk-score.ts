// Risk Score — display only, does NOT modify the Tradable grade.
// Starts at 0; rising is worse.
//
// Measured contributions come from the 2026-08-12 flag-scoring pass
// (n=12 settled research_analyses, base rate = median move_ratio 0.431
// across that population). A flag "clears" when its fired-group median
// move_ratio holds up after leave-one-out (removing the single largest
// |actual_move_pct| event, to check the signal isn't one outlier print
// carrying it) — that LOO median is `effect` below, not the raw fired
// median. Flags that don't clear (downside_fat_tail, live_narrative_risk)
// contribute 0 and are always listed under "measured, no effect": a
// flag found not to predict is a finding, and hiding it means never
// learning which checklist items are narrative.
//
//   points = round(RISK_POINTS_SCALE * effect * n/(n+RISK_K))
//
// n/(n+RISK_K) is the confidence weight (k=10) — at n=4-7 these are all
// small, which is correct; a flag doesn't get to swing the score hard
// off four observations.
//
// Overhang, VIX, and "prior documented loss on this ticker at this
// event" have NO outcome study behind them (unlike the measured flags
// above, or lib/liquidity.ts's distribution-anchored thresholds) — they
// carry fixed, hand-picked point values as a placeholder magnitude,
// roughly scaled against what a strongly-clearing measured flag
// contributes. Adjust RISK_CONFIG_VERSION if these numbers change, so a
// score frozen under the old weights stays visibly distinct from one
// scored under the new ones.
//
// Zero server dependencies — shared verbatim by lib/screener.ts
// (server, calculateThreeLayerGrade) and components/screener-view.tsx /
// research-analysis-paste.tsx (client: the live expanded-row display,
// and the risk snapshot frozen onto research_analyses at save time).

export const RISK_K = 10;
export const RISK_POINTS_SCALE = 20;
export const RISK_BASE_RATE = 0.431;

export type MeasuredFlagConfig = {
  key: string;
  // LOO median move_ratio for the fired group, from the flag-scoring
  // pass — this is `effect`, not the raw fired-group median.
  effect: number;
  n: number;
  clearsBaseRate: boolean;
};

// Frozen at RISK_CONFIG_VERSION below — see the flag-scoring report
// this pass is based on (n=12 settled research_analyses,
// 2026-07 to 2026-08-12 earnings window).
export const MEASURED_FLAGS: MeasuredFlagConfig[] = [
  { key: "consensus_above_guide", effect: 1.002, n: 5, clearsBaseRate: true },
  { key: "consecutive_deceleration", effect: 0.878, n: 4, clearsBaseRate: true },
  { key: "guidance_beat_streak", effect: 0.878, n: 4, clearsBaseRate: true },
  { key: "runup_into_print", effect: 0.628, n: 7, clearsBaseRate: true },
  { key: "downside_fat_tail", effect: 0.366, n: 6, clearsBaseRate: false },
  { key: "live_narrative_risk", effect: 0.35, n: 5, clearsBaseRate: false },
];

// Structural (unmeasured) contributions — flat point values, no n/
// effect/confidence to show since there's no outcome study behind
// them. Distinct from MEASURED_FLAGS in both source and display.
export const OVERHANG_RISK_POINTS = 15;
export const VIX_ELEVATED_RISK_POINTS = 5; // 25 <= vix <= 30
export const VIX_PANIC_RISK_POINTS = 10; // vix > 30
export const PRIOR_LOSS_RISK_POINTS = 8;

export const RISK_CONFIG_VERSION = "2026-08-12-flagscore-v1";

// v1/v2 checklist name for the item now called guidance_beat_streak —
// mirrors migrations/2026-08-11-add-flag-vocabulary-mapping.sql's
// flag_vocabulary_mapping table (the only rename that table has ever
// held). Update both if that table gains a new row.
const FLAG_ALIASES: Record<string, string> = {
  guidance_streak_extrapolated: "guidance_beat_streak",
};

export function canonicalizeFlags(rawFlags: string[]): Set<string> {
  return new Set(rawFlags.map((f) => FLAG_ALIASES[f] ?? f));
}

export function confidenceWeight(n: number): number {
  return n / (n + RISK_K);
}

function pointsFor(effect: number, n: number): number {
  return Math.round(RISK_POINTS_SCALE * effect * confidenceWeight(n));
}

export type RiskContribution = {
  key: string;
  label: string;
  points: number;
  kind: "measured" | "structural";
  n?: number;
  effect?: number;
  confidencePct?: number;
};

export type RiskNoEffectItem = {
  key: string;
  n: number;
  effect: number;
};

export type RiskScoreResult = {
  score: number;
  // Only non-zero contributions that actually fired for this candidate.
  contributions: RiskContribution[];
  // The full non-clearing measured-flag list, always present regardless
  // of what fired for THIS candidate — a standing reference, not a
  // per-candidate read. See the module comment.
  noEffect: RiskNoEffectItem[];
  configVersion: string;
};

// Event-scoped: true when a CSP campaign on THIS symbol, tied to an
// earnings event, realized a net loss — computed upstream by
// lib/campaigns.ts's hasPriorCspEarningsLoss (campaigns rows only ever
// exist for a chain that resolved to an earnings_history match, so
// querying campaigns.symbol alone already means "at an earnings
// event"). Previously read tickerTradeCount>=1 && tickerWinRate<100 —
// ANY terminal position on the ticker, including swing trades and
// non-earnings CSPs; that was the loose reading, not this one.
export function hasPriorLossOnTicker(history: { priorCspEarningsLoss: boolean }): boolean {
  return history.priorCspEarningsLoss;
}

export function computeRiskScore(params: {
  firedFlags: Set<string>;
  hasOverhang: boolean;
  vix: number | null;
  priorLossOnTicker: boolean;
}): RiskScoreResult {
  const { firedFlags, hasOverhang, vix, priorLossOnTicker } = params;
  const contributions: RiskContribution[] = [];

  for (const f of MEASURED_FLAGS) {
    if (!f.clearsBaseRate) continue;
    if (!firedFlags.has(f.key)) continue;
    contributions.push({
      key: f.key,
      label: f.key,
      points: pointsFor(f.effect, f.n),
      kind: "measured",
      n: f.n,
      effect: f.effect,
      confidencePct: Math.round(confidenceWeight(f.n) * 100),
    });
  }

  if (hasOverhang) {
    contributions.push({
      key: "overhang",
      label: "Active overhang",
      points: OVERHANG_RISK_POINTS,
      kind: "structural",
    });
  }
  if (vix !== null && vix > 30) {
    contributions.push({
      key: "vix",
      label: `VIX ${vix.toFixed(1)} (panic)`,
      points: VIX_PANIC_RISK_POINTS,
      kind: "structural",
    });
  } else if (vix !== null && vix >= 25) {
    contributions.push({
      key: "vix",
      label: `VIX ${vix.toFixed(1)} (elevated)`,
      points: VIX_ELEVATED_RISK_POINTS,
      kind: "structural",
    });
  }
  if (priorLossOnTicker) {
    contributions.push({
      key: "prior_loss",
      label: "Prior documented loss on this ticker",
      points: PRIOR_LOSS_RISK_POINTS,
      kind: "structural",
    });
  }

  const score = contributions.reduce((s, c) => s + c.points, 0);
  const noEffect: RiskNoEffectItem[] = MEASURED_FLAGS.filter((f) => !f.clearsBaseRate).map((f) => ({
    key: f.key,
    n: f.n,
    effect: f.effect,
  }));

  return { score, contributions, noEffect, configVersion: RISK_CONFIG_VERSION };
}

// Earnings Watch scoring: a data-driven CUT/TRIM/HOLD call for a held
// position reporting soon, built the same way Buy Zone's composite is
// — small, named 0-N components that are literally summed into the
// badge, so every number the badge shows is traceable to a visible
// input next to it. No hidden weighting, no thesis override: the
// COMPOUNDER/TURNAROUND/VALUE_TRAP flag from the Portfolio watchlist
// is context shown alongside the badge, never an input to it.
import type { DirectionalMoveCoverage } from "@/lib/earnings-history-table";

export type SizeTier = "small" | "medium" | "large" | null;

export type DownsideSeverityInput = {
  worstDownsidePct: number | null; // signed fraction, e.g. -0.12
};

// 0-4: how bad the worst historical down-move was. No data scores 0 —
// this component contributes nothing when there's nothing to go on;
// the caller's data-quality flag is what surfaces "we don't actually
// know," not a fabricated mid-range score here.
export function scoreDownsideSeverity(input: DownsideSeverityInput): number {
  const w = input.worstDownsidePct;
  if (w === null || !Number.isFinite(w)) return 0;
  const mag = Math.abs(w);
  if (mag >= 0.2) return 4;
  if (mag >= 0.12) return 3;
  if (mag >= 0.07) return 2;
  if (mag >= 0.02) return 1;
  return 0;
}

// 0-3: how much is actually exposed to that downside. Not held scores
// 0 (nothing to cut/trim). Tier is relative to the user's own other
// open positions (lib/positions.ts has no portfolio-NAV concept to
// compare against, so this is the only grounded reference available).
export function scoreExposure(sizeTier: SizeTier, held: boolean): number {
  if (!held) return 0;
  if (sizeTier === "large") return 3;
  if (sizeTier === "medium") return 2;
  if (sizeTier === "small") return 1;
  return 0;
}

export type IvRichnessLabel = "elevated" | "normal" | "low" | "unavailable";

// 0-2: options pricing richness vs this name's own historical norm.
// FACT input only — never itself a hedge suggestion, and scores 0
// (contributes nothing) whenever a live current-cycle reading isn't
// available, which is the common case more than a day or two out from
// the print (the pre-earnings EM is normally only captured the trading
// day of the report — see computeIvRichness below).
export function scoreIvRichness(label: IvRichnessLabel): number {
  if (label === "elevated") return 2;
  if (label === "normal") return 1;
  return 0;
}

export type EarningsWatchBadge = {
  verdict: "CUT" | "TRIM" | "HOLD";
  severityScore: number; // 0-4
  exposureScore: number; // 0-3
  ivRichnessScore: number; // 0-2
  composite: number; // literal sum, 0-9
};

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export function computeEarningsWatchBadge(input: {
  worstDownsidePct: number | null;
  sizeTier: SizeTier;
  held: boolean;
  ivRichnessLabel: IvRichnessLabel;
}): EarningsWatchBadge {
  const severityScore = scoreDownsideSeverity({ worstDownsidePct: input.worstDownsidePct });
  const exposureScore = scoreExposure(input.sizeTier, input.held);
  const ivRichnessScore = scoreIvRichness(input.ivRichnessLabel);
  const composite = round1(severityScore + exposureScore + ivRichnessScore);
  const verdict: EarningsWatchBadge["verdict"] =
    composite >= 6 ? "CUT" : composite >= 3 ? "TRIM" : "HOLD";
  return { verdict, severityScore, exposureScore, ivRichnessScore, composite };
}

export type DataQuality = {
  quartersUsed: number; // history rows with a real actualMovePct
  unverifiedCount: number; // of those, how many are NOT schwab/schwab_t0 sourced
  thin: boolean; // fewer than 3 usable quarters — same floor screener-view uses
  hasWarning: boolean; // thin OR any unverified quarter feeds the badge
};

const VERIFIED_SOURCES = new Set(["schwab", "schwab_t0"]);

// Derived straight from the same history rows directionalMoveCoverage
// already consumed for this symbol — no second fetch. A quarter with a
// null/unrecognized implied_move_source counts as unverified (there is
// no dedicated actual_move_pct provenance column at all; the row's
// implied_move_source is the only signal available, per the confirmed
// GLW Q2 2025 hallucination — perplexity read 11.8% against a true
// ~6% — on the SAME kind of row this flags).
export function assessDataQuality(
  history: Array<{ actualMovePct: number | null; impliedMoveSource: string | null }>,
): DataQuality {
  const withMoves = history.filter((h) => h.actualMovePct !== null);
  const unverifiedCount = withMoves.filter(
    (h) => !h.impliedMoveSource || !VERIFIED_SOURCES.has(h.impliedMoveSource),
  ).length;
  const thin = withMoves.length < 3;
  return {
    quartersUsed: withMoves.length,
    unverifiedCount,
    thin,
    hasWarning: thin || unverifiedCount > 0,
  };
}

export type DownsideSummary = DirectionalMoveCoverage & {
  hardDownCount: number; // subset of downCount at or beyond HARD_DOWN_THRESHOLD
};

// "Gapped down hard" needs a concrete bar — chosen as a round number
// clearly past ordinary post-earnings noise (single-digit moves are
// common and not what "hard" means here), not fit to any one ticker.
export const HARD_DOWN_THRESHOLD_PCT = -0.07;

export function summarizeDownside(
  coverage: DirectionalMoveCoverage,
  history: Array<{ actualMovePct: number | null }>,
): DownsideSummary {
  const hardDownCount = history.filter(
    (h) => h.actualMovePct !== null && h.actualMovePct <= HARD_DOWN_THRESHOLD_PCT,
  ).length;
  return { ...coverage, hardDownCount };
}

// "Buy Zone" score for the Long Term Watchlist: how close a name is
// to an oversold bullish turnaround (RSI approaching oversold + a
// MACD bullish cross out of negative territory). Two 0-5 components
// that are literally summed into the 0-10 composite — no hidden math,
// so the displayed component scores always add up to the badge.
import type { MACDPoint } from "@/lib/indicators";

export type BuyZoneScore = {
  rsiScore: number;
  macdScore: number;
  composite: number;
  macdStatus: string;
};

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

// RSI <= 20 -> 5 (full marks, capped — no extra credit for being
// deeper below 20). RSI >= 50 -> 0. Linear in between: the gradient
// lives in the 20-50 approach zone, not below the threshold.
export function computeRsiScore(rsi: number | null): number {
  if (rsi === null || !Number.isFinite(rsi)) return 0;
  if (rsi <= 20) return 5;
  if (rsi >= 50) return 0;
  return round1((5 * (50 - rsi)) / 30);
}

// MACD component — below-zero activity only. A bullish cross above
// zero is a different, weaker event (uptrend continuation, not a
// turnaround) and scores 0 regardless of recency.
//
// history: oldest-first {macd, signal, histogram} points, one per
// trading day (the same series computeMACD returns) — index distance
// from the last entry IS trading-day distance, no dates needed.
export function computeMacdScore(
  history: MACDPoint[] | null | undefined,
): { score: number; status: string } {
  if (!history || history.length < 2) return { score: 0, status: "no data" };
  const n = history.length;
  const latest = history[n - 1];

  // Bucket 1 — full marks: the most recent histogram sign flip
  // (negative -> positive) within the last 5 trading days, that
  // emerged from below-zero territory (both lines negative on the
  // bar immediately before the cross). Search backward from today so
  // the MOST RECENT cross event decides the outcome; a cross found
  // here (qualifying or not) short-circuits bucket 2 below.
  const lookbackStart = Math.max(1, n - 5);
  for (let i = n - 1; i >= lookbackStart; i -= 1) {
    const prev = history[i - 1];
    const cur = history[i];
    const isCross = prev.histogram <= 0 && cur.histogram > 0;
    if (isCross) {
      const daysAgo = n - 1 - i;
      const wasBelowZero = prev.macd < 0 && prev.signal < 0;
      if (wasBelowZero) {
        return { score: 5, status: `crossed ${daysAgo}d ago` };
      }
      return { score: 0, status: "above zero" };
    }
  }

  // Bucket 2 — currently below signal AND below zero: scale by how
  // much the histogram has narrowed toward zero over the recent
  // window. Widening (moving away from a cross) scores 0.
  const belowZero = latest.macd < 0 && latest.signal < 0;
  const belowSignal = latest.histogram < 0;
  if (belowZero && belowSignal) {
    const lookback = Math.min(5, n);
    const window = history.slice(n - lookback);
    const mags = window.map((p) => Math.abs(p.histogram));
    const refMag = mags[0];
    const curMag = mags[mags.length - 1];
    const lastStepNarrowing =
      mags.length < 2 || mags[mags.length - 1] <= mags[mags.length - 2];
    const narrowing = refMag > 0 && curMag < refMag && lastStepNarrowing;
    if (narrowing) {
      const closeness = Math.max(0, Math.min(1, 1 - curMag / refMag));
      return { score: round1(closeness * 5), status: "approaching" };
    }
    return { score: 0, status: "widening" };
  }

  // Bucket 3 — at/above zero with no qualifying recent cross: healthy
  // or neutral territory, not a turnaround signal.
  return {
    score: 0,
    status: latest.macd >= 0 && latest.signal >= 0 ? "above zero" : "neutral",
  };
}

export function computeBuyZoneScore(
  rsi: number | null,
  macdHistory: MACDPoint[] | null | undefined,
): BuyZoneScore {
  const rsiScore = computeRsiScore(rsi);
  const { score: macdScore, status: macdStatus } = computeMacdScore(macdHistory);
  return {
    rsiScore,
    macdScore,
    composite: round1(rsiScore + macdScore),
    macdStatus,
  };
}

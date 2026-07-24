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
  // window, using SIGNED values throughout — not magnitude. A bearish
  // cross anywhere inside the window means the histogram was on the
  // POSITIVE side of zero earlier in this same stretch: that's a
  // histogram shrinking toward a BEARISH cross from above (worth 0 per
  // spec), which, once it flips negative, looks IDENTICAL to a
  // genuinely narrowing negative histogram if you take Math.abs()
  // first and compare magnitudes — both "shrank." Comparing signed
  // values (and hard-gating on any non-negative point in the window)
  // is what tells them apart.
  const belowZero = latest.macd < 0 && latest.signal < 0;
  const belowSignal = latest.histogram < 0;
  if (belowZero && belowSignal) {
    const lookback = Math.min(5, n);
    const window = history.slice(n - lookback);
    const hist = window.map((p) => p.histogram); // signed, oldest-first

    // Any non-negative point in this window is a bearish cross (or the
    // bar immediately before one) within the lookback — today's
    // negative reading is fresh off THAT cross, moving away from any
    // bullish cross, not approaching one. Hard zero regardless of how
    // the raw magnitudes look.
    if (hist.some((h) => h >= 0)) {
      return { score: 0, status: "just crossed bearish" };
    }

    // Every point in the window is already negative — the histogram
    // has been below zero for the whole stretch, so "magnitude
    // shrinking toward zero" and "signed value rising toward zero"
    // are the same statement. No sign ambiguity left to resolve.
    const refMag = -hist[0];
    const curMag = -hist[hist.length - 1];
    const lastStepNarrowing =
      hist.length < 2 || hist[hist.length - 1] >= hist[hist.length - 2];
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

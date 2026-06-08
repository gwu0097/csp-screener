// Swing entry-timing signal derived from a cached SymbolSnapshot. Pure
// function — no fetching. Bullish direction is fully modeled per spec;
// bearish is a placeholder until Phase 2.
import type { SymbolSnapshot } from "@/lib/market-snapshot";

export type EntrySignal = {
  signal:
    | "OVERSOLD"
    | "PULLBACK_ENTRY"
    | "WAIT_PULLBACK"
    | "EXTENDED"
    | "NO_SIGNAL";
  reason: string;
  score: number; // 0-100
};

export type SwingIdea = {
  stage?: string; // 'entered' | 'setup_ready' | ...
  direction?: "bullish" | "bearish";
  ageDays?: number;
};

function clamp(n: number, lo = 0, hi = 100): number {
  return Math.max(lo, Math.min(hi, n));
}

export function computeEntrySignal(
  snapshot: SymbolSnapshot,
  direction: "bullish" | "bearish" = "bullish",
): EntrySignal {
  if (direction === "bearish") {
    // Bearish/short entry timing isn't modeled yet (Phase 2).
    return {
      signal: "NO_SIGNAL",
      reason: "Bearish entry modeling not implemented",
      score: 40,
    };
  }

  const rsi = snapshot.rsi14;
  const vs200 = snapshot.vs_sma200_pct;
  const vs20 = snapshot.vs_sma20_pct;
  const offHigh = snapshot.pct_from_52w_high;
  const price = snapshot.price;
  const hist = snapshot.price_history_5d ?? [];

  // ---- Big move TODAY → wait for the pullback ----
  // Today's intraday change often isn't in the daily 5d history yet, so
  // check the live quote directly: a >5% up day means the stock just
  // moved and hasn't pulled back, so don't chase it.
  const todayChange = snapshot.change_pct;
  if (todayChange !== null && todayChange > 5) {
    return {
      signal: "WAIT_PULLBACK",
      reason: `Big move today (+${todayChange.toFixed(1)}%) — wait for a 3-8% pullback`,
      score: 20,
    };
  }

  // ---- Recent big move in the 5d window → pullback logic ----
  if (price !== null && hist.length > 0) {
    const hadBigMove = hist.some(
      (d) => d.change_pct !== null && Math.abs(d.change_pct) > 5,
    );
    if (hadBigMove) {
      const closes = hist.map((d) => d.close);
      const fiveDayHigh = Math.max(...closes);
      const fiveDayLow = Math.min(...closes);
      const pullbackPct =
        fiveDayHigh > 0 ? ((fiveDayHigh - price) / fiveDayHigh) * 100 : 0;

      if (pullbackPct >= 3 && pullbackPct <= 12 && price > fiveDayLow) {
        return {
          signal: "PULLBACK_ENTRY",
          reason: `Pulled back ${pullbackPct.toFixed(1)}% from recent ${fiveDayHigh.toFixed(2)} high — entry zone`,
          score: 80,
        };
      }
      if (pullbackPct < 3) {
        return {
          signal: "WAIT_PULLBACK",
          reason: "Big move recently — wait for a 3-8% pullback",
          score: 20,
        };
      }
      // pullback > 12% → too deep for the pullback play; fall through to
      // the oversold/extended checks below.
    }
  }

  // ---- Oversold ----
  if (
    rsi !== null &&
    vs200 !== null &&
    offHigh !== null &&
    rsi < 40 &&
    vs200 > -25 &&
    offHigh < -20
  ) {
    return {
      signal: "OVERSOLD",
      reason: `Oversold — RSI ${rsi.toFixed(0)}, ${offHigh.toFixed(0)}% off highs`,
      score: clamp(75 + (40 - rsi) * 0.5),
    };
  }

  // ---- Extended (overbought, avoid chasing) ----
  if (
    vs20 !== null &&
    vs200 !== null &&
    rsi !== null &&
    vs20 > 8 &&
    vs200 > 20 &&
    rsi > 70
  ) {
    return {
      signal: "EXTENDED",
      reason: `Extended — RSI ${rsi.toFixed(0)}, ${vs20.toFixed(0)}% above 20d SMA`,
      score: 10,
    };
  }

  return { signal: "NO_SIGNAL", reason: "No clear entry signal", score: 40 };
}

// Composite score for ranking ideas (e.g. top 10 on the dashboard).
export function computeSwingScore(
  snapshot: SymbolSnapshot,
  idea: SwingIdea,
): number {
  const direction = idea.direction ?? "bullish";
  let base = computeEntrySignal(snapshot, direction).score;

  if (idea.stage === "entered") base += 40;
  else if (idea.stage === "setup_ready") base += 20;

  if (snapshot.change_pct !== null && Math.abs(snapshot.change_pct) > 5) {
    base += 25;
  }
  if (typeof idea.ageDays === "number" && idea.ageDays > 180) base -= 15;
  if (
    snapshot.return_3m !== null &&
    snapshot.return_3m < 0 &&
    direction === "bullish"
  ) {
    base -= 10;
  }

  return clamp(base);
}

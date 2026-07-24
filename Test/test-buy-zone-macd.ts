// Unit test for computeMacdScore's "approaching a cross" bucket.
// Regression for: a fresh BEARISH cross scored 4.4/5 as "Approaching"
// (AMZN, 2026-07-24) because the narrowing check compared Math.abs()
// magnitudes only, discarding sign — a histogram that was positive and
// shrinking toward a bearish cross, then flipped negative, looks
// identical to a genuinely narrowing negative histogram once you drop
// the sign. Every case here is signed-direction sensitive; case 1 is
// AMZN's real fetched history (symbol_market_snapshot, macd_history).
// Run: npx tsx Test/test-buy-zone-macd.ts
import { computeMacdScore } from "../lib/buy-zone";

type P = { macd: number; signal: number; histogram: number };

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  ✓ ${label}`);
    passed += 1;
  } else {
    console.log(`  ✗ ${label} ${detail ?? ""}`);
    failed += 1;
  }
}

// -------- Case 1: AMZN's real history — fresh bearish cross --------
// Histogram positive and declining (2.08 -> 1.70 -> 1.56 -> 1.24 ->
// 0.81) for the preceding stretch, then flips to -0.207 on the latest
// bar. This is "approaching a bearish cross" all the way through, not
// "approaching a bullish cross" — must score 0.
{
  const amzn: P[] = [
    { macd: -1.9087, signal: -3.8392, histogram: 1.9305 },
    { macd: -1.4076, signal: -3.3528, histogram: 1.9453 },
    { macd: -0.9845, signal: -2.8792, histogram: 1.8946 },
    { macd: -0.046, signal: -2.3125, histogram: 2.2666 },
    { macd: 0.2854, signal: -1.7929, histogram: 2.0784 },
    { macd: 0.3296, signal: -1.3684, histogram: 1.6981 },
    { macd: 0.5807, signal: -0.9786, histogram: 1.5593 },
    { macd: 0.5761, signal: -0.6677, histogram: 1.2438 },
    { macd: 0.3506, signal: -0.464, histogram: 0.8146 },
    { macd: -0.7228, signal: -0.5158, histogram: -0.207 },
  ];
  const r = computeMacdScore(amzn);
  console.log(`  AMZN: score=${r.score} status=${r.status}`);
  check("AMZN fresh bearish cross scores 0, not 4.4", r.score === 0);
}

// -------- Case 2: genuine bullish cross below zero, held --------
{
  const bullishBelowZero: P[] = [
    { macd: -3.0, signal: -2.0, histogram: -1.0 },
    { macd: -2.6, signal: -1.9, histogram: -0.7 },
    { macd: -2.2, signal: -1.7, histogram: -0.5 },
    { macd: -1.9, signal: -1.6, histogram: -0.3 },
    { macd: -1.6, signal: -1.65, histogram: 0.05 }, // crosses bullish
    { macd: -1.4, signal: -1.55, histogram: 0.15 }, // held
  ];
  const r = computeMacdScore(bullishBelowZero);
  console.log(`  bullish cross below zero: score=${r.score} status=${r.status}`);
  check("genuine bullish cross below zero still scores 5", r.score === 5);
}

// -------- Case 3: positive histogram approaching a bearish cross --------
// Not yet crossed — histogram still positive on the latest bar.
{
  const approachingBearish: P[] = [
    { macd: 1.5, signal: 0.5, histogram: 1.0 },
    { macd: 1.3, signal: 0.6, histogram: 0.7 },
    { macd: 1.0, signal: 0.65, histogram: 0.35 },
    { macd: 0.8, signal: 0.68, histogram: 0.12 },
    { macd: 0.7, signal: 0.69, histogram: 0.01 },
  ];
  const r = computeMacdScore(approachingBearish);
  console.log(`  approaching bearish cross: score=${r.score} status=${r.status}`);
  check("positive histogram shrinking toward a bearish cross scores 0", r.score === 0);
}

// -------- Case 4: NFLX-style widening negative --------
// Histogram negative and growing MORE negative (moving away from
// zero), far from any cross throughout. Must still score 0.
{
  const widening: P[] = [
    { macd: -2.0, signal: -1.5, histogram: -0.5 },
    { macd: -2.5, signal: -1.7, histogram: -0.8 },
    { macd: -3.2, signal: -2.0, histogram: -1.2 },
    { macd: -4.0, signal: -2.3, histogram: -1.7 },
    { macd: -4.8, signal: -2.6, histogram: -2.2 },
  ];
  const r = computeMacdScore(widening);
  console.log(`  NFLX-style widening: score=${r.score} status=${r.status}`);
  check("widening-negative (NFLX-style) still scores 0", r.score === 0);
}

console.log(`\n=== Summary: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);

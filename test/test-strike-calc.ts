// Verifies runStageFour's strike picker now prefers IV-implied EM over
// historical median for a 2x-EM CSP strategy. Uses a mocked AXP chain
// so we don't depend on Schwab connectivity.
//
// Run: env -u GEMINI_API_KEY -u PERPLEXITY_API_KEY node --env-file=.env.local --import=tsx test/test-strike-calc.ts
import { runStageFour, type EarningsCandidate } from "../lib/screener";
import type { SchwabOptionsChain, SchwabOptionContract } from "../lib/schwab";

function mkContract(strike: number, mark: number, delta: number): SchwabOptionContract {
  const bid = Math.max(0, mark - 0.05);
  const ask = mark + 0.05;
  return {
    putCall: "PUT",
    symbol: `AXP_260425P${strike}`,
    bid,
    ask,
    last: mark,
    mark,
    delta,
    gamma: 0,
    theta: -0.05,
    vega: 0,
    volatility: 45,
    strikePrice: strike,
    daysToExpiration: 5,
    expirationDate: "2026-04-25",
  };
}

// Sparse AXP-shaped chain: a few strikes around the 2x-EM zone with
// deltas roughly consistent with 45% IV at 5 DTE.
const chain: SchwabOptionsChain = {
  symbol: "AXP",
  underlying: { symbol: "AXP", last: 335, mark: 335 },
  underlyingPrice: 335,
  putExpDateMap: {
    "2026-04-25:5": {
      "335": [mkContract(335, 4.1, -0.48)],
      "320": [mkContract(320, 1.6, -0.28)],
      "310": [mkContract(310, 0.95, -0.18)],
      "305": [mkContract(305, 0.7, -0.14)],
      "300": [mkContract(300, 0.5, -0.11)],
      "297.5": [mkContract(297.5, 0.4, -0.09)],
      "295": [mkContract(295, 0.3, -0.07)],
    },
  },
  callExpDateMap: {},
};

const candidate: EarningsCandidate = {
  symbol: "AXP",
  price: 335,
  earningsDate: "2026-04-23",
  earningsTiming: "AMC",
  daysToExpiry: 5,
  expiry: "2026-04-25",
};

// Historical moves on AXP are typically 3-4% — low relative to what IV
// is currently pricing (5.3%). That gap is the original bug.
const medianHistoricalMovePct = 0.035;
const emPct = 0.0527;

console.log("\n=== Strike calc: historical preferred (old behavior) would give ===");
console.log(`  suggestedStrike = 335 * (1 - 2*0.035) = ${(335 * (1 - 2 * 0.035)).toFixed(2)}  (too aggressive)`);

console.log("\n=== Strike calc: IV preferred (new behavior) should give ===");
const newExpected = 335 * (1 - 2 * 0.0527);
console.log(`  suggestedStrike = 335 * (1 - 2*0.0527) = ${newExpected.toFixed(2)}  (target ~$298)`);

console.log("\n=== Actual runStageFour() output ===");
const result = runStageFour(candidate, chain, medianHistoricalMovePct, emPct);
console.log(`  suggestedStrike: ${result.suggestedStrike}`);
console.log(`  premium: ${result.premium}`);
console.log(`  delta: ${result.delta}`);
console.log(`  contractSymbol: ${result.details.contractSymbol}`);

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean): void {
  if (cond) {
    console.log(`  ✓ ${label}`);
    passed += 1;
  } else {
    console.log(`  ✗ ${label}`);
    failed += 1;
  }
}

console.log("\n=== assertions ===");
check(
  "suggestedStrike ≈ 335 * (1 - 2 * emPct) = ~$297.74",
  result.suggestedStrike !== null && Math.abs(result.suggestedStrike - newExpected) < 0.5,
);
check(
  "did NOT fall back to historical-based $311",
  result.suggestedStrike !== null && result.suggestedStrike < 305,
);
check(
  "picked a real contract from chain",
  result.details.contractSymbol !== null && result.details.contractSymbol !== "",
);

// POP sanity check — the picked contract's delta should place POP ≥ 85%.
const pop = result.delta !== null ? 1 - Math.abs(result.delta) : 0;
console.log(`\n  probabilityOfProfit at picked strike: ${(pop * 100).toFixed(0)}%`);
check("POP ≥ 85% (target ~89%)", pop >= 0.85);

// When emPct is null we should fall back to historical (backward compat).
console.log("\n=== fallback: emPct=null, use historical ===");
const fbResult = runStageFour(candidate, chain, medianHistoricalMovePct, null);
console.log(
  `  suggestedStrike: ${fbResult.suggestedStrike} (expected ~${(335 * (1 - 2 * 0.035)).toFixed(2)})`,
);
check(
  "fallback to historical when emPct null",
  fbResult.suggestedStrike !== null && Math.abs(fbResult.suggestedStrike - 311.55) < 1,
);

console.log(`\n=== Summary: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);

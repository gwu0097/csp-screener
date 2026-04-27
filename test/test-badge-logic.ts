// Unit tests for computePositionBadge — the priority-cascade status
// badge engine in lib/positions.ts. Pure function, no DB, no network.
// All 13 rule paths covered + explicit priority-ordering assertion.
//
// Run: node --env-file=.env.local --import=tsx test/test-badge-logic.ts
import { computePositionBadge, type PositionBadgeInput } from "../lib/positions";

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
function section(title: string): void {
  console.log(`\n=============== ${title} ===============`);
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}
function daysFromTodayIso(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Common inputs with sensible defaults; each test overrides what it needs.
function base(overrides: Partial<PositionBadgeInput> = {}): PositionBadgeInput {
  return {
    position: { strike: 100, expiry: daysFromTodayIso(7) },
    latestSnapshot: null,
    postEarningsRec: null,
    currentStockPrice: null,
    ...overrides,
  };
}

// -------- Test 1: expiry day, ITM (-2%) --------
function test1_expiryItm() {
  section("Test 1: expiry day, stock 2% below strike → EMERGENCY CUT");
  const r = computePositionBadge(
    base({
      position: { strike: 100, expiry: todayIso() },
      currentStockPrice: 98, // -2% from strike
    }),
  );
  check("badge = EMERGENCY_CUT", r.badge === "EMERGENCY_CUT", r.badge);
  check("color = red", r.color === "red");
  check("ruleFired = EXPIRY_ITM", r.ruleFired === "EXPIRY_ITM", r.ruleFired);
}

// -------- Test 2: expiry day, 0.3% OTM (pin risk) --------
function test2_pinRisk() {
  section("Test 2: expiry day, 0.3% OTM → PIN RISK");
  const r = computePositionBadge(
    base({
      position: { strike: 100, expiry: todayIso() },
      currentStockPrice: 100.3,
    }),
  );
  check("badge = PIN_RISK", r.badge === "PIN_RISK", r.badge);
  check("color = amber", r.color === "amber");
  check("ruleFired = EXPIRY_PIN_RISK", r.ruleFired === "EXPIRY_PIN_RISK");
}

// -------- Test 3: expiry day, 3% OTM, opt=$0.13 → EXPIRING --------
function test3_expiringNormal() {
  section("Test 3: expiry day, 3% OTM, option=$0.13 → EXPIRING ✓");
  const r = computePositionBadge(
    base({
      position: { strike: 100, expiry: todayIso() },
      currentStockPrice: 103,
      latestSnapshot: {
        stock_price: 103,
        option_price: 0.13,
        current_delta: null,
        move_ratio: null,
        pct_premium_remaining: null,
      },
    }),
  );
  check("badge = EXPIRING", r.badge === "EXPIRING", r.badge);
  check("color = green", r.color === "green");
  check("ruleFired = EXPIRY_WORTHLESS", r.ruleFired === "EXPIRY_WORTHLESS");
}

// -------- Test 4: expiry day, 50% OTM, opt=null → EXPIRING --------
function test4_expiringDeepOtmNoPrice() {
  section("Test 4: expiry day, 50% OTM, option price null → EXPIRING ✓");
  const r = computePositionBadge(
    base({
      position: { strike: 100, expiry: todayIso() },
      currentStockPrice: 150,
      latestSnapshot: {
        stock_price: 150,
        option_price: null,
        current_delta: null,
        move_ratio: null,
        pct_premium_remaining: null,
      },
    }),
  );
  check("badge = EXPIRING", r.badge === "EXPIRING", r.badge);
  check("color = green", r.color === "green");
  check("ruleFired = EXPIRY_WORTHLESS", r.ruleFired === "EXPIRY_WORTHLESS");
}

// -------- Test 5: post-earnings CLOSE HIGH --------
function test5_postEarningsCloseHigh() {
  section("Test 5: post-earnings CLOSE HIGH → CLOSE");
  const r = computePositionBadge(
    base({
      currentStockPrice: 98, // irrelevant, not expiry day
      postEarningsRec: {
        recommendation: "CLOSE",
        confidence: "HIGH",
        reasoning: "Move exceeded implied by >20%. Exit.",
      },
    }),
  );
  check("badge = CLOSE", r.badge === "CLOSE", r.badge);
  check("color = red", r.color === "red");
  check("ruleFired = POST_EARNINGS_CLOSE_HIGH", r.ruleFired === "POST_EARNINGS_CLOSE_HIGH");
}

// -------- Test 6: post-earnings HOLD HIGH --------
function test6_postEarningsHoldHigh() {
  section("Test 6: post-earnings HOLD HIGH → HOLD");
  const r = computePositionBadge(
    base({
      postEarningsRec: {
        recommendation: "HOLD",
        confidence: "HIGH",
        reasoning: "Classic successful setup — let theta finish.",
      },
    }),
  );
  check("badge = HOLD", r.badge === "HOLD", r.badge);
  check("color = green", r.color === "green");
  check("ruleFired = POST_EARNINGS_HOLD_HIGH", r.ruleFired === "POST_EARNINGS_HOLD_HIGH");
}

// -------- Test 7: MAX PROFIT via pct_premium_remaining=0.09 --------
function test7_maxProfit() {
  section("Test 7: pct_premium_remaining=0.09 → MAX PROFIT");
  const r = computePositionBadge(
    base({
      latestSnapshot: {
        stock_price: 105,
        option_price: 0.09,
        current_delta: -0.05,
        move_ratio: null,
        pct_premium_remaining: 0.09,
      },
    }),
  );
  check("badge = MAX_PROFIT", r.badge === "MAX_PROFIT", r.badge);
  check("color = green", r.color === "green");
  check("ruleFired = MAX_PROFIT", r.ruleFired === "MAX_PROFIT");
  check("tooltip mentions 91% captured", r.tooltip.includes("91%"));
}

// -------- Test 8: MAX PROFIT deep-OTM fallback (no pct_premium_remaining) --------
function test8_maxProfitDeepOtm() {
  section("Test 8: deep OTM (stock=100, strike=70) + no pct_premium → MAX PROFIT");
  const r = computePositionBadge(
    base({
      position: { strike: 70, expiry: daysFromTodayIso(3) },
      currentStockPrice: 100, // 42.9% OTM
      latestSnapshot: {
        stock_price: 100,
        option_price: null,
        current_delta: null,
        move_ratio: null,
        pct_premium_remaining: null,
      },
    }),
  );
  check("badge = MAX_PROFIT", r.badge === "MAX_PROFIT", r.badge);
  check("ruleFired = MAX_PROFIT", r.ruleFired === "MAX_PROFIT");
  check("tooltip uses >90% placeholder", r.tooltip.includes(">90%"));
}

// -------- Test 9: move_ratio exceeded --------
function test9_moveRatioExceeded() {
  section("Test 9: move_ratio=1.35 with DTE>0 → CLOSE");
  const r = computePositionBadge(
    base({
      position: { strike: 100, expiry: daysFromTodayIso(2) },
      latestSnapshot: {
        stock_price: 98,
        option_price: 0.8,
        current_delta: -0.15,
        move_ratio: 1.35,
        pct_premium_remaining: 0.6,
      },
    }),
  );
  check("badge = CLOSE", r.badge === "CLOSE", r.badge);
  check("color = red", r.color === "red");
  check("ruleFired = MOVE_RATIO_EXCEEDED", r.ruleFired === "MOVE_RATIO_EXCEEDED");
}

// -------- Test 10: delta high → EMERGENCY CUT --------
function test10_deltaHigh() {
  section("Test 10: delta=-0.38 → EMERGENCY CUT");
  const r = computePositionBadge(
    base({
      position: { strike: 100, expiry: daysFromTodayIso(3) },
      latestSnapshot: {
        stock_price: 98,
        option_price: 0.9,
        current_delta: -0.38,
        move_ratio: 0.9,
        pct_premium_remaining: 0.6,
      },
    }),
  );
  check("badge = EMERGENCY_CUT", r.badge === "EMERGENCY_CUT", r.badge);
  check("color = red", r.color === "red");
  check("ruleFired = DELTA_HIGH", r.ruleFired === "DELTA_HIGH");
}

// -------- Test 11: delta elevated → MONITOR --------
function test11_deltaElevated() {
  section("Test 11: delta=-0.22 → MONITOR");
  const r = computePositionBadge(
    base({
      position: { strike: 100, expiry: daysFromTodayIso(5) },
      latestSnapshot: {
        stock_price: 99,
        option_price: 0.4,
        current_delta: -0.22,
        move_ratio: 0.8,
        pct_premium_remaining: 0.5,
      },
    }),
  );
  check("badge = MONITOR", r.badge === "MONITOR", r.badge);
  check("color = amber", r.color === "amber");
  check("ruleFired = DELTA_ELEVATED", r.ruleFired === "DELTA_ELEVATED");
}

// -------- Test 12: default HOLD (nothing to act on) --------
function test12_defaultHold() {
  section("Test 12: no snapshot, no rec, not expiry → DEFAULT HOLD");
  const r = computePositionBadge(base({}));
  check("badge = HOLD", r.badge === "HOLD", r.badge);
  check("color = green", r.color === "green");
  check("ruleFired = DEFAULT_HOLD", r.ruleFired === "DEFAULT_HOLD");
}

// -------- Test 13: priority ordering --------
function test13_priorityOrdering() {
  section("Test 13: priority — expiry day beats post-earnings rec");
  const r = computePositionBadge(
    base({
      position: { strike: 100, expiry: todayIso() }, // expiry today
      currentStockPrice: 103, // OTM
      latestSnapshot: {
        stock_price: 103,
        option_price: 0.05,
        current_delta: -0.05,
        move_ratio: null,
        pct_premium_remaining: null,
      },
      postEarningsRec: {
        recommendation: "CLOSE",
        confidence: "HIGH",
        reasoning: "Should be ignored because expiry day wins.",
      },
    }),
  );
  check(
    "EXPIRING wins over POST_EARNINGS_CLOSE_HIGH",
    r.ruleFired === "EXPIRY_WORTHLESS",
    r.ruleFired,
  );
  check("badge = EXPIRING", r.badge === "EXPIRING");
  check("color = green (expiring worthless is good news)", r.color === "green");
}

async function main() {
  test1_expiryItm();
  test2_pinRisk();
  test3_expiringNormal();
  test4_expiringDeepOtmNoPrice();
  test5_postEarningsCloseHigh();
  test6_postEarningsHoldHigh();
  test7_maxProfit();
  test8_maxProfitDeepOtm();
  test9_moveRatioExceeded();
  test10_deltaHigh();
  test11_deltaElevated();
  test12_defaultHold();
  test13_priorityOrdering();
  console.log(`\n=== Summary: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error("test error:", e);
  process.exit(1);
});

// Tests for the auto-expire / assignment pipeline. Pure logic in
// classifyFromSnapshot + computeAutoExpirePnl + computeAssignmentPnl +
// isWeekendUTC — no DB mocking required. Test 7 queries the live DB
// read-only to classify whatever expired open positions actually exist.
//
// Run: node --env-file=.env.local --import=tsx test/test-auto-expire.ts
import {
  classifyFromSnapshot,
  computeAssignmentPnl,
  computeAutoExpirePnl,
  isWeekendUTC,
  classifyExpiredPosition,
  getExpiredPositions,
} from "../lib/expire-positions";

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
function section(title: string) {
  console.log(`\n=============== ${title} ===============`);
}

// -------- Test 1: NOW barely OTM → auto_expire --------
function test1_nowAutoExpire() {
  section("Test 1: NOW strike=85, stock=87.05, opt=0.13 → auto_expire");
  const r = classifyFromSnapshot(85, { stock_price: 87.05, option_price: 0.13 });
  check(
    "classification = 'auto_expire'",
    r.classification === "auto_expire",
    r.classification,
  );
  check(
    "pctFromStrike ≈ 2.41%",
    r.pctFromStrike !== null && Math.abs(r.pctFromStrike - (87.05 - 85) / 85) < 1e-9,
  );
}

// -------- Test 2: AXP close to strike → verify_assignment --------
function test2_axpVerify() {
  section("Test 2: AXP strike=312.5, stock=313.17, opt=0.99 → verify_assignment");
  const r = classifyFromSnapshot(312.5, { stock_price: 313.17, option_price: 0.99 });
  check(
    "classification = 'verify_assignment'",
    r.classification === "verify_assignment",
    r.classification,
  );
  check(
    "pctFromStrike ≈ 0.21%",
    r.pctFromStrike !== null && Math.abs(r.pctFromStrike * 100 - 0.2144) < 1e-3,
  );
}

// -------- Test 3: INTC deep OTM + near-zero → auto_expire --------
function test3_intcAutoExpire() {
  section("Test 3: INTC strike=54, stock=81.19, opt=0.01 → auto_expire");
  const r = classifyFromSnapshot(54, { stock_price: 81.19, option_price: 0.01 });
  check("classification = 'auto_expire'", r.classification === "auto_expire", r.classification);
  check(
    "pctFromStrike > 0.5",
    r.pctFromStrike !== null && r.pctFromStrike > 0.5,
    String(r.pctFromStrike),
  );
}

// -------- Test 4: autoExpire P&L math --------
function test4_autoExpirePnl() {
  section("Test 4: computeAutoExpirePnl(0.17, 10) === 170.00");
  const pnl = computeAutoExpirePnl(0.17, 10);
  check("pnl === 170.00", pnl === 170.0, String(pnl));
}

// -------- Test 5: assignment P&L math --------
function test5_assignmentPnl() {
  section("Test 5: computeAssignmentPnl(85, 83, 0.27, 4)");
  const pnl = computeAssignmentPnl(85, 83, 0.27, 4);
  // premium collected: 0.27 * 4 * 100 = 108
  // option loss: (85-83) * 4 * 100 = 800
  // realized: 108 - 800 = -692
  check("pnl === -692.00", pnl === -692.0, String(pnl));
}

// -------- Test 6: weekend gate --------
function test6_weekendGate() {
  section("Test 6: isWeekendUTC");
  // 2026-04-25 is a Saturday (UTC).
  const sat = new Date("2026-04-25T12:00:00Z");
  const sun = new Date("2026-04-26T12:00:00Z");
  const mon = new Date("2026-04-27T12:00:00Z");
  const fri = new Date("2026-04-24T12:00:00Z");
  check("Saturday 2026-04-25 is weekend", isWeekendUTC(sat) === true);
  check("Sunday 2026-04-26 is weekend", isWeekendUTC(sun) === true);
  check("Monday 2026-04-27 is NOT weekend", isWeekendUTC(mon) === false);
  check("Friday 2026-04-24 is NOT weekend", isWeekendUTC(fri) === false);
}

// -------- Test 7: DB round-trip (read-only) --------
async function test7_realDb() {
  section("Test 7: live DB classification (read-only)");
  const expired = await getExpiredPositions();
  console.log(`  expired open positions: ${expired.length}`);
  if (expired.length === 0) {
    console.log(
      "  No expired positions found — classifications look correct from mock tests.",
    );
    return;
  }
  for (const p of expired) {
    const c = await classifyExpiredPosition(p);
    const pctStr = c.pctFromStrike !== null ? `${(c.pctFromStrike * 100).toFixed(2)}%` : "—";
    const stockStr = c.stockPrice !== null ? `$${c.stockPrice.toFixed(2)}` : "—";
    const optStr = c.optionPrice !== null ? `$${c.optionPrice.toFixed(2)}` : "—";
    console.log(
      `  ${p.symbol} strike=${p.strike} expiry=${p.expiry} → ${c.classification} pctFromStrike=${pctStr} stock=${stockStr} opt=${optStr}`,
    );
  }
}

async function main() {
  test1_nowAutoExpire();
  test2_axpVerify();
  test3_intcAutoExpire();
  test4_autoExpirePnl();
  test5_assignmentPnl();
  test6_weekendGate();
  await test7_realDb();
  console.log(`\n=== Summary: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error("test error:", e);
  process.exit(1);
});

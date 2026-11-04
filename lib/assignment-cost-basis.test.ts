import { test } from "node:test";
import assert from "node:assert/strict";
import { assignmentCostBasis } from "./assignment-cost-basis.ts";

test("plain assignment: same as strike − premium", () => {
  // 3 contracts sold at $0.36, all assigned → realized $108.
  assert.equal(assignmentCostBasis({ strike: 121, shares: 300, parentRealizedPnl: 108, avgPremiumSold: 0.36 }), 120.64);
});

test("round-tripped contracts on the same row don't credit their premium to assigned shares", () => {
  // NOW $122P 10-30: realized $147 over 300 assigned shares → $121.51, not $109.9567.
  assert.equal(assignmentCostBasis({ strike: 122, shares: 300, parentRealizedPnl: 147, avgPremiumSold: 12.0433 }), 121.51);
});

test("a loss on earlier round-trips raises the basis", () => {
  assert.equal(assignmentCostBasis({ strike: 50, shares: 100, parentRealizedPnl: -40, avgPremiumSold: 1 }), 50.4);
});

test("unknown realized P&L falls back to the average premium", () => {
  assert.equal(assignmentCostBasis({ strike: 50, shares: 100, parentRealizedPnl: null, avgPremiumSold: 1.25 }), 48.75);
  assert.equal(assignmentCostBasis({ strike: 50, shares: 100, parentRealizedPnl: null, avgPremiumSold: null }), 50);
});

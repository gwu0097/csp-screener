import { test } from "node:test";
import assert from "node:assert/strict";
import { recommendPosition, type PositionSignals } from "./position-urgency.ts";

// A short put 4% OTM on expiry day — TSM $395 on 2026-10-16.
const base: PositionSignals = {
  profitPct: 97.8,
  distanceToStrikePct: 4.0,
  dte: 0,
  entryDelta: null,
  currentDelta: null,
  currentTheta: null,
  entryStockPrice: null,
  currentStockPrice: 411.8,
  twoDayDrop: false,
  opportunityAvailable: false,
  optionType: "put",
};

test("a known 98% capture is CUT (take the win), not MONITOR on distance", () => {
  assert.equal(recommendPosition(base).urgency, "CUT");
});

test("unknown P&L is not read as 0% captured: profit rules are skipped, distance still flags", () => {
  const r = recommendPosition({ ...base, profitPct: null });
  assert.equal(r.urgency, "MONITOR");
  assert.match(r.reason, /P&L unverified/);
});

test("unknown P&L with a safe distance holds and says the P&L is unverified", () => {
  const r = recommendPosition({ ...base, profitPct: null, distanceToStrikePct: 12 });
  assert.equal(r.urgency, "HOLD");
  assert.match(r.reason, /unverified/);
});

test("unknown P&L never triggers the losing-position MONITOR rule", () => {
  const r = recommendPosition({ ...base, profitPct: null, distanceToStrikePct: 20, dte: 10 });
  assert.equal(r.urgency, "HOLD");
});

test("emergency distance rule is unaffected by unknown P&L", () => {
  assert.equal(recommendPosition({ ...base, profitPct: null, distanceToStrikePct: 1.5 }).urgency, "EMERGENCY_CUT");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveSandboxEarnings, sandboxExpiryFor } from "./sandbox-earnings.ts";

test("a print from yesterday is found (the NOW 2026-10-28 case)", () => {
  const r = resolveSandboxEarnings("2026-10-29", [
    { earnings_date: "2026-04-22", timing: "amc" },
    { earnings_date: "2026-10-28", timing: "amc" },
  ]);
  assert.deepEqual(r, { earningsDate: "2026-10-28", timing: "AMC", timingAssumed: false });
});

test("no print near today → null (caller must not save against a stand-in date)", () => {
  assert.equal(resolveSandboxEarnings("2026-10-29", [{ earnings_date: "2026-07-22", timing: "amc" }]), null);
  assert.equal(resolveSandboxEarnings("2026-10-29", [{ earnings_date: "2026-12-01", timing: "amc" }]), null);
  assert.equal(resolveSandboxEarnings("2026-10-29", []), null);
});

test("nearest wins; a tie goes to the upcoming print", () => {
  const r = resolveSandboxEarnings("2026-10-29", [
    { earnings_date: "2026-10-27", timing: "bmo" },
    { earnings_date: "2026-11-01", timing: "bmo" },
  ]);
  assert.equal(r?.earningsDate, "2026-10-27");
  const tie = resolveSandboxEarnings("2026-10-29", [
    { earnings_date: "2026-10-27", timing: "bmo" },
    { earnings_date: "2026-10-31", timing: "bmo" },
  ]);
  assert.equal(tie?.earningsDate, "2026-10-31");
});

test("timing maps from lowercase; missing timing is flagged as assumed AMC", () => {
  assert.equal(resolveSandboxEarnings("2026-10-29", [{ earnings_date: "2026-10-30", timing: "bmo" }])?.timing, "BMO");
  const r = resolveSandboxEarnings("2026-10-29", [{ earnings_date: "2026-10-30", timing: null }]);
  assert.deepEqual(r, { earningsDate: "2026-10-30", timing: "AMC", timingAssumed: true });
});

test("expiry: Friday after the print, never before next Friday", () => {
  const amcWed = { earningsDate: "2026-10-28", timing: "AMC" as const, timingAssumed: false };
  assert.equal(sandboxExpiryFor("2026-10-29", amcWed), "2026-10-30");
  // AMC on a Friday reacts Monday → following Friday.
  const amcFri = { earningsDate: "2026-11-06", timing: "AMC" as const, timingAssumed: false };
  assert.equal(sandboxExpiryFor("2026-10-29", amcFri), "2026-11-13");
  // BMO on a Friday reacts that day → same Friday.
  const bmoFri = { earningsDate: "2026-11-06", timing: "BMO" as const, timingAssumed: false };
  assert.equal(sandboxExpiryFor("2026-10-29", bmoFri), "2026-11-06");
  // A print last week can't use last week's (expired) Friday.
  const past = { earningsDate: "2026-10-22", timing: "AMC" as const, timingAssumed: false };
  assert.equal(sandboxExpiryFor("2026-10-29", past), "2026-10-30");
  // Run on a Friday → the following Friday (matches the old stand-in rule).
  assert.equal(sandboxExpiryFor("2026-10-30", amcWed), "2026-11-06");
});

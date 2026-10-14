import { test } from "node:test";
import assert from "node:assert/strict";
import { isAsiaPacificListing, usSessionFor } from "./foreign-listing-session.ts";

test("an Asia-Pacific listing's AMC is the next US day's BMO (TSM filed as 2330.TW)", () => {
  assert.deepEqual(usSessionFor("2330.TW", "2026-10-14", "AMC"), { date: "2026-10-15", timing: "BMO" });
  assert.deepEqual(usSessionFor("6758.T", "2026-12-31", "AMC"), { date: "2027-01-01", timing: "BMO" });
});

test("BMO, US and European listings are left as Finnhub says", () => {
  assert.deepEqual(usSessionFor("2330.TW", "2026-10-15", "BMO"), { date: "2026-10-15", timing: "BMO" });
  assert.deepEqual(usSessionFor("TSM", "2026-10-14", "AMC"), { date: "2026-10-14", timing: "AMC" });
  assert.deepEqual(usSessionFor("ASML.AS", "2026-10-14", "AMC"), { date: "2026-10-14", timing: "AMC" });
  assert.equal(isAsiaPacificListing("T"), false); // AT&T, not Tokyo
});

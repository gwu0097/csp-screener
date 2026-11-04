import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAndDedupeCalendarRows } from "./finnhub-calendar-parse.ts";

test("blank-hour rows are kept as unknown, not dropped (ARM 2026-11-05 had hour \"\")", () => {
  const out = parseAndDedupeCalendarRows([
    { symbol: "ARM", date: "2026-11-05", hour: "" },
    { symbol: "NOHOUR", date: "2026-11-05" },
    { symbol: "COHR", date: "2026-11-04", hour: "amc" },
    { symbol: "MID", date: "2026-11-04", hour: "dmh" },
  ]);
  const t = Object.fromEntries(out.map((r) => [r.symbol, r.timing]));
  assert.deepEqual(t, { ARM: "unknown", NOHOUR: "unknown", COHR: "AMC", MID: "DMH" });
});

test("an unknown row next to a timed row for the same symbol+date collapses to the timed one", () => {
  const out = parseAndDedupeCalendarRows([
    { symbol: "TGT", date: "2026-08-19", hour: "", epsEstimate: null },
    { symbol: "TGT", date: "2026-08-19", hour: "bmo", epsEstimate: 2.1 },
  ]);
  assert.deepEqual(out.map((r) => r.timing), ["BMO"]);
});

test("existing duplicate collapse still keeps the more complete row", () => {
  const out = parseAndDedupeCalendarRows([
    { symbol: "TGT", date: "2026-08-19", hour: "bmo", epsEstimate: null, revenueEstimate: null },
    { symbol: "TGT", date: "2026-08-19", hour: "bmo", epsEstimate: 2.1, revenueEstimate: 25e9 },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].estimatedEPS, 2.1);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { minRowsFloor, validateRobinhoodCalendarPayload, windowEndFor } from "./robinhood-calendar-validate.ts";

const W = { start: "2026-11-04", end: "2026-11-06" };
const ARM = ["ARM", "2026-11-04", "pm", true];

test("window of 3 days from D ends on D+2", () => {
  assert.equal(windowEndFor("2026-11-04"), "2026-11-06");
  assert.equal(windowEndFor("2026-12-30"), "2027-01-01");
});

test("accepts a well-formed batch and collapses Robinhood's verbatim repeats", () => {
  const r = validateRobinhoodCalendarPayload(
    { count: 4, rows: [ARM, ["AMCR", "2026-11-04", "pm", true], ["AMCR", "2026-11-04", "pm", true], ["X", "2026-11-05", null, false]] },
    W,
  );
  assert.ok(r.ok);
  assert.equal(r.rows.length, 3);
  assert.equal(r.duplicatesCollapsed, 1);
  assert.deepEqual(r.rows[0], { symbol: "ARM", reportDate: "2026-11-04", timing: "pm", verified: true });
  assert.equal(r.rows[2].timing, null);
});

test("an empty batch is legal (holiday weeks return 0 rows)", () => {
  const r = validateRobinhoodCalendarPayload({ count: 0, rows: [] }, W);
  assert.ok(r.ok);
});

test("rejects count mismatch (truncated transcription)", () => {
  const r = validateRobinhoodCalendarPayload({ count: 695, rows: [ARM] }, W);
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /count 695 != rows.length 1/);
});

test("rejects an impossible calendar date", () => {
  const r = validateRobinhoodCalendarPayload({ count: 1, rows: [["ARM", "2026-13-45", "pm", true]] }, W);
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /bad date/);
});

test("rejects a date outside the requested window", () => {
  const r = validateRobinhoodCalendarPayload({ count: 1, rows: [["ARM", "2026-11-09", "pm", true]] }, W);
  assert.equal(r.ok, false);
});

test("rejects timing other than am/pm/null", () => {
  for (const t of ["amc", "PM", "", "bmo"]) {
    const r = validateRobinhoodCalendarPayload({ count: 1, rows: [["ARM", "2026-11-04", t, true]] }, W);
    assert.equal(r.ok, false, `timing ${t}`);
  }
});

test("rejects bad symbol, non-boolean verified, wrong row arity, extra keys", () => {
  const bad: unknown[] = [
    { count: 1, rows: [["arm", "2026-11-04", "pm", true]] },
    { count: 1, rows: [["ARM", "2026-11-04", "pm", "true"]] },
    { count: 1, rows: [["ARM", "2026-11-04", "pm"]] },
    { count: 1, rows: [ARM], guide: "..." },
    [ARM],
    null,
  ];
  for (const b of bad) assert.equal(validateRobinhoodCalendarPayload(b, W).ok, false, JSON.stringify(b));
});

test("rejects a batch below the floor set by the previous batch for the same dates", () => {
  // Previous batch listed 640 rows on 11-04..11-05; this one only 1.
  const floor = { start: "2026-11-04", end: "2026-11-05", min: minRowsFloor(640) };
  assert.equal(floor.min, 320);
  const r = validateRobinhoodCalendarPayload({ count: 1, rows: [ARM] }, W, floor);
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /below the sanity floor of 320/);
});

test("rows on the new day outside the overlap don't count toward the floor", () => {
  const rows = Array.from({ length: 5 }, (_, i) => [`N${i}`, "2026-11-06", "am", true]);
  const r = validateRobinhoodCalendarPayload({ count: 5, rows }, W, { start: "2026-11-04", end: "2026-11-05", min: 2 });
  assert.equal(r.ok, false);
});

test("no previous batch means no floor", () => {
  assert.equal(minRowsFloor(null), 0);
  assert.equal(minRowsFloor(0), 0);
  assert.equal(minRowsFloor(3), 2);
});

test("symbol/date checks stay identical to lib/traded-status.ts", async () => {
  const v = await import("./robinhood-calendar-validate.ts");
  const t = await import("./traded-status.ts");
  assert.equal(v.SYMBOL_RE.source, t.SYMBOL_RE.source);
  for (const d of ["2026-11-04", "2026-13-45", "2026-02-30", "2028-02-29", "26-11-04"]) {
    assert.equal(v.isIsoDate(d), t.isIsoDate(d), d);
  }
});

test("source choice: accepts a pick that matches what the source showed", async () => {
  const { parseSourceChoice } = await import("./robinhood-calendar-validate.ts");
  const key = "F=2026-11-05:unknown|R=2026-11-04:AMC";
  assert.deepEqual(
    parseSourceChoice({ symbol: "arm", conflictKey: key, chosenSource: "robinhood", chosenDate: "2026-11-04", chosenTiming: "AMC" }),
    { symbol: "ARM", conflictKey: key, chosenSource: "robinhood", chosenDate: "2026-11-04", chosenTiming: "AMC" },
  );
  // Finnhub's blank timing can be filled in by the user's AMC/BMO pick.
  assert.ok(!("error" in parseSourceChoice({ symbol: "ARM", conflictKey: key, chosenSource: "finnhub", chosenDate: "2026-11-05", chosenTiming: "BMO" })));
  assert.ok(!("error" in parseSourceChoice({ symbol: "UNK", conflictKey: "F=2026-11-04:unknown|R=-", chosenSource: "user", chosenDate: "2026-11-04", chosenTiming: "AMC" })));
});

test("source choice: rejects picks the sources never showed and malformed keys", async () => {
  const { parseSourceChoice } = await import("./robinhood-calendar-validate.ts");
  const key = "F=2026-11-05:unknown|R=2026-11-04:AMC";
  const bad = [
    { symbol: "ARM", conflictKey: key, chosenSource: "robinhood", chosenDate: "2026-11-05", chosenTiming: "AMC" },
    { symbol: "ARM", conflictKey: key, chosenSource: "robinhood", chosenDate: "2026-11-04", chosenTiming: "BMO" },
    { symbol: "ARM", conflictKey: "F=-|R=-", chosenSource: "finnhub", chosenDate: "2026-11-05", chosenTiming: "BMO" },
    { symbol: "ARM", conflictKey: "garbage", chosenSource: "robinhood", chosenDate: "2026-11-04", chosenTiming: "AMC" },
    { symbol: "ARM", conflictKey: "F=2026-13-45:AMC|R=-", chosenSource: "finnhub", chosenDate: "2026-13-45", chosenTiming: "AMC" },
    { symbol: "ARM", conflictKey: key, chosenSource: "user", chosenDate: "2026-11-09", chosenTiming: "AMC" },
    { symbol: "ARM", conflictKey: key, chosenSource: "robinhood", chosenDate: "2026-11-04", chosenTiming: "DMH" },
  ];
  for (const b of bad) assert.ok("error" in parseSourceChoice(b), JSON.stringify(b));
});

test("source choice keys produced by the merge parse back", async () => {
  const { conflictKey } = await import("./earnings-source-merge.ts");
  const { parseSourceChoice } = await import("./robinhood-calendar-validate.ts");
  const key = conflictKey({ date: "2026-11-04", timing: "unknown" }, null);
  assert.ok(!("error" in parseSourceChoice({ symbol: "X", conflictKey: key, chosenSource: "finnhub", chosenDate: "2026-11-04", chosenTiming: "AMC" })));
});

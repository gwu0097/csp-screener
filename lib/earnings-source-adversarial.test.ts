// Adversarial tests (tester, 2026-11-04) for the Robinhood earnings-calendar
// cross-check: merge edge cases, ingest validation and the choice parser.
// Tests marked DEFECT fail on the current code and describe the expected
// behaviour.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  conflictKey,
  mergeEarningsSources,
  rhBatchAvailability,
  sourceCheckChip,
  type FinnhubCalRow,
  type RhBatchInput,
  type RhRowInput,
  type SourceChoice,
} from "./earnings-source-merge.ts";
import {
  minRowsFloor,
  parseSourceChoice,
  validateRobinhoodCalendarPayload,
} from "./robinhood-calendar-validate.ts";
import { calendarStatusLine, choiceOptions } from "./earnings-source-display.ts";

const today = "2026-11-04";
const tomorrow = "2026-11-05";
const now = new Date("2026-11-04T17:00:00Z");
const batch = (rows: RhRowInput[], over: Partial<RhBatchInput> = {}): RhBatchInput => ({
  fetchedAt: "2026-11-04T14:30:00Z",
  windowStart: "2026-11-04",
  windowEnd: "2026-11-06",
  rows,
  ...over,
});
const merge = (finnhub: FinnhubCalRow[], robinhood: RhBatchInput | null, choices: SourceChoice[] = [], w = { today, tomorrow, now }) =>
  mergeEarningsSources({ finnhub, robinhood, choices, ...w });
const one = (list: ReturnType<typeof merge>, sym: string) => list.find((c) => c.symbol === sym);

// ---------- merge ----------

test("ARM with NO batch (today's real state): screened provisionally as tomorrow BMO, flagged Timing?", () => {
  const m = one(merge([{ symbol: "ARM", date: tomorrow, timing: "unknown" }], null), "ARM")!;
  assert.equal(m.date, tomorrow);
  assert.equal(m.timing, "BMO");
  assert.equal(m.check.kind, "robinhood_unavailable");
  assert.deepEqual(sourceCheckChip(m.check), { label: "Timing?", tone: "amber" });
});

test("Finnhub BMO today (already reported) vs Robinhood pm today → Robinhood wins, Timing differs chip", () => {
  const m = one(merge([{ symbol: "X", date: today, timing: "BMO" }], batch([{ symbol: "X", reportDate: today, timing: "pm", verified: false }])), "X")!;
  assert.equal(m.timing, "AMC");
  assert.equal(m.check.resolvedSource, "robinhood");
  assert.equal(sourceCheckChip(m.check)?.label, "Timing differs");
});

test("Finnhub tomorrow BMO vs Robinhood tomorrow pm → Finnhub kept (more actionable) but flagged", () => {
  const m = one(merge([{ symbol: "X", date: tomorrow, timing: "BMO" }], batch([{ symbol: "X", reportDate: tomorrow, timing: "pm", verified: true }])), "X")!;
  assert.equal(m.check.resolvedSource, "finnhub");
  assert.equal(m.timing, "BMO");
  assert.equal(sourceCheckChip(m.check)?.tone, "amber");
});

test("Finnhub DMH today + Robinhood null today → excluded (DMH wins over an unknown)", () => {
  assert.equal(one(merge([{ symbol: "X", date: today, timing: "DMH" }], batch([{ symbol: "X", reportDate: today, timing: null, verified: false }])), "X"), undefined);
});

test("Finnhub DMH today + Robinhood pm today → included via Robinhood and flagged", () => {
  const m = one(merge([{ symbol: "X", date: today, timing: "DMH" }], batch([{ symbol: "X", reportDate: today, timing: "pm", verified: true }])), "X")!;
  assert.equal(m.check.kind, "dates_disagree");
  assert.equal(m.timing, "AMC");
});

test("Robinhood 'am' maps to BMO and 'pm' to AMC; am today is not actionable", () => {
  const r = merge([], batch([
    { symbol: "A", reportDate: today, timing: "am", verified: true },
    { symbol: "B", reportDate: tomorrow, timing: "am", verified: true },
    { symbol: "C", reportDate: tomorrow, timing: "pm", verified: true },
  ]));
  assert.equal(one(r, "A"), undefined);
  assert.equal(one(r, "B")?.timing, "BMO");
  assert.equal(one(r, "C"), undefined);
});

test("a saved choice whose answer falls outside the window removes the row (tomorrow AMC)", () => {
  const f: FinnhubCalRow[] = [{ symbol: "X", date: tomorrow, timing: "unknown" }];
  const key = conflictKey({ date: tomorrow, timing: "unknown" }, null);
  const r = merge(f, batch([]), [{ symbol: "X", conflictKey: key, chosenSource: "finnhub", chosenDate: tomorrow, chosenTiming: "AMC" }]);
  assert.equal(one(r, "X"), undefined);
});

test("a choice keyed to a fresh-batch conflict no longer applies once the batch goes stale", () => {
  const f: FinnhubCalRow[] = [{ symbol: "ARM", date: tomorrow, timing: "unknown" }];
  const rh = [{ symbol: "ARM", reportDate: today, timing: "pm" as const, verified: true }];
  const key = conflictKey({ date: tomorrow, timing: "unknown" }, { date: today, timing: "AMC" });
  const choice: SourceChoice = { symbol: "ARM", conflictKey: key, chosenSource: "robinhood", chosenDate: today, chosenTiming: "AMC" };
  assert.equal(one(merge(f, batch(rh), [choice]), "ARM")?.check.resolvedSource, "user");
  const stale = one(merge(f, batch(rh, { fetchedAt: "2026-11-03T00:00:00Z" }), [choice]), "ARM")!;
  assert.equal(stale.check.kind, "robinhood_unavailable");
  assert.notEqual(stale.check.resolvedSource, "user");
});

test("dotted share class symbols match across sources (BRK.B)", () => {
  const m = one(merge([{ symbol: "BRK.B", date: tomorrow, timing: "BMO" }], batch([{ symbol: "BRK.B", reportDate: tomorrow, timing: "am", verified: true }])), "BRK.B")!;
  assert.equal(m.check.kind, "agree");
});

test("Friday: tomorrow is Saturday, a Fri..Sun batch is usable and Monday BMO is out of window", () => {
  const w = { today: "2026-11-06", tomorrow: "2026-11-07", now: new Date("2026-11-06T17:00:00Z") };
  const b = batch([{ symbol: "M", reportDate: "2026-11-09", timing: "am", verified: true }], { fetchedAt: "2026-11-06T14:30:00Z", windowStart: "2026-11-06", windowEnd: "2026-11-08" });
  assert.deepEqual(rhBatchAvailability(b, w.now, w.today, w.tomorrow), { available: true });
  assert.equal(merge([], b, [], w).length, 0);
});

test("documents current behaviour: a future-stamped batch (clock skew) counts as fresh", () => {
  // Expected: fetchedAt more than a few minutes ahead of now is suspect.
  // Observed: negative age passes the staleness check. Low severity
  // (fetched_at is the DB's now()), documented here.
  const b = batch([], { fetchedAt: "2026-11-06T17:00:00Z" });
  const a = rhBatchAvailability(b, now, today, tomorrow);
  assert.equal(a.available, true, "documents current behaviour: future fetchedAt counts as fresh");
});

test("Finnhub failure + fresh batch: every row is labelled robinhood_only (status line must carry the explanation)", () => {
  const r = merge([], batch([{ symbol: "NVDA", reportDate: today, timing: "pm", verified: true }]));
  assert.equal(one(r, "NVDA")?.check.kind, "robinhood_only");
  assert.equal(
    calendarStatusLine(r.map((x) => x.check), () => "t", "HTTP 429")?.text,
    "Finnhub calendar failed — results are Robinhood-only",
  );
});

test("status line never claims Robinhood is fine when any row says unavailable", () => {
  const ok = merge([{ symbol: "A", date: today, timing: "AMC" }], batch([]));
  const bad = merge([{ symbol: "B", date: today, timing: "AMC" }], null);
  const line = calendarStatusLine([...ok, ...bad].map((x) => x.check), () => "t");
  assert.equal(line?.tone, "amber");
  assert.match(line!.text, /unavailable/);
});

test("choice options for both-unknown same date are not duplicated and never include DMH", () => {
  const m = one(merge([{ symbol: "X", date: today, timing: "unknown" }], batch([{ symbol: "X", reportDate: today, timing: null, verified: false }])), "X")!;
  const opts = choiceOptions(m.check);
  assert.equal(opts.length, 2);
  for (const o of opts) {
    const p = parseSourceChoice({ symbol: "X", conflictKey: m.check.conflictKey, ...o });
    assert.ok(!("error" in p), JSON.stringify(p));
  }
});

// ---------- choice parser ----------

test("parseSourceChoice: cannot pick a Robinhood date when Robinhood was absent, or a timing it contradicted", () => {
  assert.ok("error" in parseSourceChoice({ symbol: "X", conflictKey: "F=2026-11-05:BMO|R=-", chosenSource: "robinhood", chosenDate: "2026-11-05", chosenTiming: "BMO" }));
  assert.ok("error" in parseSourceChoice({ symbol: "X", conflictKey: "F=2026-11-05:BMO|R=2026-11-05:AMC", chosenSource: "robinhood", chosenDate: "2026-11-05", chosenTiming: "BMO" }));
  assert.ok("error" in parseSourceChoice({ symbol: "X", conflictKey: "F=2026-02-30:BMO|R=-", chosenSource: "finnhub", chosenDate: "2026-02-30", chosenTiming: "BMO" }));
  assert.ok("error" in parseSourceChoice({ symbol: "X;DROP", conflictKey: "F=-|R=-", chosenSource: "user", chosenDate: "2026-11-05", chosenTiming: "BMO" }));
  assert.ok("error" in parseSourceChoice({ symbol: "X", conflictKey: "F=-|R=-", chosenSource: "user", chosenDate: "2026-11-05", chosenTiming: "BMO" }));
});

// ---------- ingest validation ----------

const W = { start: "2026-11-04", end: "2026-11-06" };

test("count mismatch, out-of-window date, impossible date and lower-case symbol all reject the whole batch", () => {
  const good = ["ARM", "2026-11-04", "pm", true];
  assert.equal(validateRobinhoodCalendarPayload({ count: 2, rows: [good] }, W).ok, false);
  assert.equal(validateRobinhoodCalendarPayload({ count: 1, rows: [["ARM", "2026-11-07", "pm", true]] }, W).ok, false);
  assert.equal(validateRobinhoodCalendarPayload({ count: 1, rows: [["ARM", "2026-11-31", "pm", true]] }, W).ok, false);
  assert.equal(validateRobinhoodCalendarPayload({ count: 1, rows: [["arm", "2026-11-04", "pm", true]] }, W).ok, false);
  assert.equal(validateRobinhoodCalendarPayload({ count: 1, rows: [["ARM", "2026-11-04", "PM", true]] }, W).ok, false);
  assert.equal(validateRobinhoodCalendarPayload({ count: 1, rows: [good], guide: "x" }, W).ok, false);
});

test("duplicate symbol+date: verified beats unverified, timed beats null", () => {
  const v = validateRobinhoodCalendarPayload({ count: 3, rows: [["X", "2026-11-04", null, false], ["X", "2026-11-04", "pm", false], ["X", "2026-11-04", "am", true]] }, W);
  assert.ok(v.ok);
  if (v.ok) {
    assert.equal(v.duplicatesCollapsed, 2);
    assert.deepEqual(v.rows, [{ symbol: "X", reportDate: "2026-11-04", timing: "am", verified: true }]);
  }
});

test("two equally-scored repeats with conflicting timing store timing null", () => {
  // Expected: a same-day am vs pm repeat is a real disagreement inside
  // Robinhood's own data; it should not be resolved by array position
  // (reject, or store timing null so Screen Today flags it).
  const v = validateRobinhoodCalendarPayload({ count: 2, rows: [["X", "2026-11-04", "am", true], ["X", "2026-11-04", "pm", true]] }, W);
  assert.ok(v.ok);
  if (v.ok) assert.notEqual(v.rows[0].timing, "am", "conflicting repeat resolved by position (kept 'am')");
});

test("the sanity floor does not reject a reschedule when the previous overlap is tiny (holiday week)", () => {
  // Previous batch listed 1 row on the overlapping dates (the developer's
  // own 2026-12-28 window returned 1 row). That company moves its date
  // out of the window → today's batch has 0 rows there. minRowsFloor(1)
  // = 1, so EVERY run is rejected until the overlap rolls off: Screen
  // Today shows Robinhood unavailable and Discord gets a failure each run.
  const floor = { start: "2026-12-29", end: "2026-12-30", min: minRowsFloor(1) };
  const v = validateRobinhoodCalendarPayload({ count: 0, rows: [] }, { start: "2026-12-29", end: "2026-12-31" }, floor);
  assert.equal(v.ok, true, `rejected: ${v.ok ? "" : v.error}`);
});

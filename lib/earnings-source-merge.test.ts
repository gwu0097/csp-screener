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
const merge = (finnhub: FinnhubCalRow[], robinhood: RhBatchInput | null, choices: SourceChoice[] = []) =>
  mergeEarningsSources({ finnhub, robinhood, choices, today, tomorrow, now });
const one = (list: ReturnType<typeof merge>, sym: string) => list.find((c) => c.symbol === sym);

test("ARM (real 2026-11-04 case): Finnhub 11-05 blank, Robinhood 11-04 pm → in today's window, flagged", () => {
  const out = merge(
    [{ symbol: "ARM", date: "2026-11-05", timing: "unknown" }],
    batch([{ symbol: "ARM", reportDate: "2026-11-04", timing: "pm", verified: true }]),
  );
  const arm = one(out, "ARM");
  assert.ok(arm, "ARM must be a candidate");
  assert.equal(arm.date, "2026-11-04");
  assert.equal(arm.timing, "AMC");
  assert.equal(arm.check.kind, "dates_disagree");
  assert.equal(arm.check.resolvedSource, "robinhood");
  assert.equal(arm.check.timingProvisional, false);
  assert.deepEqual(arm.check.finnhub, { date: "2026-11-05", timing: "unknown" });
  assert.deepEqual(arm.check.robinhood, { date: "2026-11-04", timing: "AMC", verified: true });
  assert.deepEqual(sourceCheckChip(arm.check), { label: "Dates differ", tone: "amber" });
});

test("both sources agree → agree, no chip", () => {
  const out = merge(
    [{ symbol: "COHR", date: today, timing: "AMC" }],
    batch([{ symbol: "COHR", reportDate: today, timing: "pm", verified: true }]),
  );
  assert.equal(one(out, "COHR")?.check.kind, "agree");
  assert.equal(sourceCheckChip(one(out, "COHR")?.check), null);
});

test("Robinhood-only symbol enters the window and is flagged", () => {
  const out = merge([], batch([{ symbol: "NEWCO", reportDate: tomorrow, timing: "am", verified: false }]));
  const c = one(out, "NEWCO");
  assert.equal(c?.timing, "BMO");
  assert.equal(c?.check.kind, "robinhood_only");
  assert.deepEqual(sourceCheckChip(c?.check), { label: "RH only", tone: "amber" });
});

test("same day, Finnhub blank hour, Robinhood has timing → timing_from_robinhood", () => {
  const out = merge(
    [{ symbol: "XYZ", date: tomorrow, timing: "unknown" }],
    batch([{ symbol: "XYZ", reportDate: tomorrow, timing: "am", verified: true }]),
  );
  const c = one(out, "XYZ");
  assert.equal(c?.check.kind, "timing_from_robinhood");
  assert.equal(c?.timing, "BMO");
  assert.equal(c?.check.timingProvisional, false);
  // Finnhub said tomorrow; Robinhood says tomorrow PM → out of window, dropped.
  const later = merge(
    [{ symbol: "XYZ", date: tomorrow, timing: "unknown" }],
    batch([{ symbol: "XYZ", reportDate: tomorrow, timing: "pm", verified: true }]),
  );
  assert.equal(one(later, "XYZ"), undefined);
});

test("unknown timing on both sides is included with a provisional timing and flagged", () => {
  const out = merge([{ symbol: "UNK", date: today, timing: "unknown" }], batch([{ symbol: "UNK", reportDate: today, timing: null, verified: false }]));
  const c = one(out, "UNK");
  assert.equal(c?.check.kind, "timing_unknown");
  assert.equal(c?.timing, "AMC");
  assert.equal(c?.check.timingProvisional, true);
  assert.deepEqual(sourceCheckChip(c?.check), { label: "Timing?", tone: "amber" });
});

test("stale or missing batch → robinhood_unavailable, never agree", () => {
  const f: FinnhubCalRow[] = [{ symbol: "COHR", date: today, timing: "AMC" }];
  const rh = [{ symbol: "COHR", reportDate: today, timing: "pm" as const, verified: true }];
  for (const b of [null, batch(rh, { fetchedAt: "2026-11-03T10:00:00Z" })]) {
    const c = one(merge(f, b), "COHR");
    assert.equal(c?.check.kind, "robinhood_unavailable");
    assert.equal(c?.check.robinhood, null);
  }
  // A batch that doesn't reach tomorrow is unusable too.
  assert.equal(rhBatchAvailability(batch(rh, { windowEnd: today }), now, today, tomorrow).available, false);
  // Robinhood-only rows can't appear from an unusable batch.
  assert.equal(merge([], batch(rh, { fetchedAt: "2026-11-02T10:00:00Z" })).length, 0);
});

test("a saved user choice overrides the default resolution", () => {
  const f: FinnhubCalRow[] = [{ symbol: "ARM", date: "2026-11-05", timing: "unknown" }];
  const b = batch([{ symbol: "ARM", reportDate: "2026-11-04", timing: "pm", verified: true }]);
  const key = conflictKey({ date: "2026-11-05", timing: "unknown" }, { date: "2026-11-04", timing: "AMC" });
  const pickFinnhubBmo: SourceChoice = { symbol: "ARM", conflictKey: key, chosenSource: "finnhub", chosenDate: "2026-11-05", chosenTiming: "BMO" };
  const c = one(merge(f, b, [pickFinnhubBmo]), "ARM");
  assert.equal(c?.date, "2026-11-05");
  assert.equal(c?.timing, "BMO");
  assert.equal(c?.check.resolvedSource, "user");
  assert.deepEqual(sourceCheckChip(c?.check), { label: "Your pick", tone: "muted" });
  // A choice that moves it out of the window removes it.
  const out = merge(f, b, [{ ...pickFinnhubBmo, chosenTiming: "AMC" }]);
  assert.equal(one(out, "ARM"), undefined);
  // A choice for a different disagreement doesn't apply.
  const stale = { ...pickFinnhubBmo, conflictKey: "F=2026-11-06:AMC|R=-" };
  assert.equal(one(merge(f, b, [stale]), "ARM")?.check.resolvedSource, "robinhood");
});

test("DMH is still excluded", () => {
  assert.equal(merge([{ symbol: "MID", date: today, timing: "DMH" }], batch([])).length, 0);
  assert.equal(merge([{ symbol: "MID", date: today, timing: "DMH" }], null).length, 0);
});

test("Finnhub-only small cap with a fresh batch is not flagged as a discrepancy", () => {
  const c = one(merge([{ symbol: "TINY", date: today, timing: "AMC" }], batch([])), "TINY");
  assert.equal(c?.check.kind, "finnhub_only");
  assert.equal(sourceCheckChip(c?.check), null);
});

test("same date, BMO vs AMC is a disagreement; verified Robinhood wins the tie", () => {
  // Finnhub today BMO (out of window) vs Robinhood today PM (in window).
  const c = one(
    merge([{ symbol: "TT", date: today, timing: "BMO" }], batch([{ symbol: "TT", reportDate: today, timing: "pm", verified: false }])),
    "TT",
  );
  assert.equal(c?.check.kind, "dates_disagree");
  assert.equal(c?.check.resolvedSource, "robinhood");
  assert.deepEqual(sourceCheckChip(c?.check), { label: "Timing differs", tone: "amber" });
  // Both in window (today AMC vs tomorrow BMO): unverified Robinhood → Finnhub.
  const d = one(
    merge([{ symbol: "UU", date: today, timing: "AMC" }], batch([{ symbol: "UU", reportDate: tomorrow, timing: "am", verified: false }])),
    "UU",
  );
  assert.equal(d?.check.resolvedSource, "finnhub");
  assert.equal(d?.date, today);
});

test("neither source in the window → not a candidate", () => {
  assert.equal(merge([{ symbol: "L8R", date: "2026-11-06", timing: "AMC" }], batch([{ symbol: "L8R", reportDate: "2026-11-06", timing: "pm", verified: true }])).length, 0);
});

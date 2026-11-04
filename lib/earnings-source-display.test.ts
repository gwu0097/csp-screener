import { test } from "node:test";
import assert from "node:assert/strict";
import { calendarStatusLine, choiceOptions } from "./earnings-source-display.ts";
import type { EarningsSourceCheck } from "./earnings-source-merge.ts";

const base: EarningsSourceCheck = {
  kind: "agree",
  finnhub: { date: "2026-11-04", timing: "AMC" },
  robinhood: { date: "2026-11-04", timing: "AMC", verified: true },
  conflictKey: "F=2026-11-04:AMC|R=2026-11-04:AMC",
  resolvedSource: "finnhub",
  timingProvisional: false,
  rhFetchedAt: "2026-11-04T14:30:00Z",
};
const fmt = (iso: string) => `T(${iso.slice(11, 16)})`;

test("status line: fresh Robinhood batch", () => {
  assert.deepEqual(calendarStatusLine([base], fmt), { tone: "ok", text: "Robinhood calendar from T(14:30)" });
});

test("status line: unavailable batch is amber and says Finnhub-only", () => {
  const c = { ...base, kind: "robinhood_unavailable" as const, robinhood: null, rhFetchedAt: "2026-11-02T14:30:00Z" };
  assert.deepEqual(calendarStatusLine([c], fmt), {
    tone: "amber",
    text: "Robinhood calendar unavailable since T(14:30) — results are Finnhub-only",
  });
  assert.equal(calendarStatusLine([{ ...c, rhFetchedAt: null }], fmt)?.text, "Robinhood calendar unavailable — results are Finnhub-only");
});

test("status line: old saved runs without checks show nothing; Finnhub failure wins", () => {
  assert.equal(calendarStatusLine([undefined, undefined], fmt), null);
  assert.equal(calendarStatusLine([base], fmt, "429")?.text, "Finnhub calendar failed — results are Robinhood-only");
});

test("ARM sheet offers Use Robinhood plus Finnhub's date with an AMC/BMO pick", () => {
  const arm: EarningsSourceCheck = {
    ...base,
    kind: "dates_disagree",
    finnhub: { date: "2026-11-05", timing: "unknown" },
    robinhood: { date: "2026-11-04", timing: "AMC", verified: true },
  };
  assert.deepEqual(
    choiceOptions(arm).map((o) => `${o.label}:${o.chosenSource}:${o.chosenDate}:${o.chosenTiming}`),
    ["Use Robinhood:robinhood:2026-11-04:AMC", "Finnhub date, AMC:finnhub:2026-11-05:AMC", "Finnhub date, BMO:finnhub:2026-11-05:BMO"],
  );
});

test("timing unknown on both sides on the same date offers one AMC and one BMO button", () => {
  const c: EarningsSourceCheck = {
    ...base,
    kind: "timing_unknown",
    finnhub: { date: "2026-11-04", timing: "unknown" },
    robinhood: { date: "2026-11-04", timing: "unknown", verified: false },
  };
  assert.equal(choiceOptions(c).length, 2);
});

test("a DMH side gets no button", () => {
  const c: EarningsSourceCheck = { ...base, kind: "dates_disagree", finnhub: { date: "2026-11-04", timing: "DMH" } };
  assert.deepEqual(choiceOptions(c).map((o) => o.chosenSource), ["robinhood"]);
});

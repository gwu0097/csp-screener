import { test } from "node:test";
import assert from "node:assert/strict";
import { dominantSession, reactionSession, timingLabel } from "./earnings-session.ts";

test("today AMC and tomorrow BMO react in the same session", () => {
  // Wed 2026-11-04 AMC and Thu 2026-11-05 BMO both react Thursday.
  assert.equal(reactionSession("2026-11-04", "AMC"), reactionSession("2026-11-05", "BMO"));
});

test("Friday AMC reacts Monday", () => {
  assert.equal(reactionSession("2026-11-06", "AMC"), reactionSession("2026-11-09", "BMO"));
});

test("rows on the dominant session get a bare timing; others get a weekday", () => {
  const rows = [
    { earningsDate: "2026-11-04", earningsTiming: "AMC" as const },
    { earningsDate: "2026-11-04", earningsTiming: "AMC" as const },
    { earningsDate: "2026-11-05", earningsTiming: "BMO" as const },
    { earningsDate: "2026-11-05", earningsTiming: "AMC" as const },
  ];
  const dom = dominantSession(rows);
  assert.equal(timingLabel("2026-11-04", "AMC", dom), "AMC");
  assert.equal(timingLabel("2026-11-05", "BMO", dom), "BMO");
  assert.equal(timingLabel("2026-11-05", "AMC", dom), "Thu AMC");
});

test("tie goes to the earlier session; empty screen falls back to bare timing", () => {
  const dom = dominantSession([
    { earningsDate: "2026-11-05", earningsTiming: "AMC" },
    { earningsDate: "2026-11-04", earningsTiming: "AMC" },
  ]);
  assert.equal(timingLabel("2026-11-04", "AMC", dom), "AMC");
  assert.equal(timingLabel("2026-11-05", "AMC", dom), "Thu AMC");
  assert.equal(dominantSession([]), null);
  assert.equal(timingLabel("2026-11-05", "BMO", null), "BMO");
});

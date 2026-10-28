import { test } from "node:test";
import assert from "node:assert/strict";
import { crushIssueKeys, isAcknowledged } from "./crush-alert-ack.ts";

const day = (date: string, state: string, failed = 0) => ({ date, state, failed });

test("only failed and missed days are issues", () => {
  const keys = crushIssueKeys(
    [day("2026-10-27", "ran_failed", 2), day("2026-10-23", "ran_ok"), day("2026-10-22", "ran_nothing_due")],
    [day("2026-10-26", "no_run")],
    [],
  );
  assert.deepEqual(keys, ["t0|2026-10-27|failed:2", "t1|2026-10-26|no_run"]);
});

test("dismissed set stays dismissed, including when old days roll off", () => {
  const acked = crushIssueKeys([day("2026-10-27", "ran_failed", 2), day("2026-10-19", "ran_failed", 1)], [], ["a"]);
  const later = crushIssueKeys([day("2026-10-27", "ran_failed", 2)], [], ["a"]);
  assert.equal(isAcknowledged(later, acked), true);
});

test("a new failed day reshows", () => {
  const acked = crushIssueKeys([day("2026-10-27", "ran_failed", 2)], [], []);
  const now = crushIssueKeys([day("2026-10-28", "ran_failed", 1), day("2026-10-27", "ran_failed", 2)], [], []);
  assert.equal(isAcknowledged(now, acked), false);
});

test("a day that gets worse reshows", () => {
  const acked = crushIssueKeys([], [day("2026-10-27", "ran_failed", 1)], []);
  const now = crushIssueKeys([], [day("2026-10-27", "ran_failed", 3)], []);
  assert.equal(isAcknowledged(now, acked), false);
});

test("a new aged-out row reshows", () => {
  const acked = crushIssueKeys([], [], ["a"]);
  assert.equal(isAcknowledged(crushIssueKeys([], [], ["a", "b"]), acked), false);
});

test("nothing dismissed, or nothing wrong, is not acknowledged", () => {
  assert.equal(isAcknowledged(["t0|2026-10-27|failed:2"], null), false);
  assert.equal(isAcknowledged([], ["t0|2026-10-27|failed:2"]), false);
});

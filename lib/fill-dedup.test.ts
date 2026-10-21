import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyIncomingFill, partitionByRecordedExternalId } from "./fill-dedup.ts";

// ISRG $365P 2026-10-23: 3 opened @0.85, 3 closed @0.35. The 1pm poll
// timed out after inserting the close; the next run re-delivered it.
const isrgFills = [
  { fill_type: "open" as const, contracts: 3, premium: 0.85, fill_date: "2026-10-20", external_id: "133965665392" },
  { fill_type: "close" as const, contracts: 3, premium: 0.35, fill_date: "2026-10-20", external_id: "134045357464" },
];

test("a re-delivered close with a stored broker id is a duplicate, not a new close", () => {
  assert.equal(
    classifyIncomingFill({ action: "close", contracts: 3, premium: 0.35, externalId: "134045357464" }, "2026-10-20", isrgFills),
    "duplicate_by_id",
  );
});

test("a different broker id with identical terms is a separate execution", () => {
  assert.equal(
    classifyIncomingFill({ action: "close", contracts: 3, premium: 0.35, externalId: "999" }, "2026-10-20", isrgFills),
    "new",
  );
});

test("without a broker id, identical terms are only a fuzzy duplicate", () => {
  assert.equal(classifyIncomingFill({ action: "close", contracts: 3, premium: 0.35 }, "2026-10-20", isrgFills), "duplicate_fuzzy");
  assert.equal(classifyIncomingFill({ action: "close", contracts: 2, premium: 0.35 }, "2026-10-20", isrgFills), "new");
});

test("partition drops rows whose broker id is already recorded and keeps the rest in order", () => {
  const rows = [
    { n: 1, input: { externalId: "134045357464" } },
    { n: 2, input: { externalId: "134075171947" } },
    { n: 3, input: {} },
  ];
  const { recorded, fresh } = partitionByRecordedExternalId(rows, new Set(["134045357464"]));
  assert.deepEqual(recorded.map((r) => r.n), [1]);
  assert.deepEqual(fresh.map((r) => r.n), [2, 3]);
});

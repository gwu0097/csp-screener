import { test } from "node:test";
import assert from "node:assert/strict";
import { pickCloseBatch, pickStampBatch, stampCandidateCutoff, symbolsToEnrich } from "./import-enrichment-rules.ts";

test("cutoff is lookback days before today, across a month boundary", () => {
  assert.equal(stampCandidateCutoff("2026-10-21"), "2026-10-14");
  assert.equal(stampCandidateCutoff("2026-11-03"), "2026-10-27");
});

test("batch respects the limit and reports what is left", () => {
  const c = (id: string) => ({ id, symbol: "X", expiry: "2026-10-23", opened_date: "2026-10-20" });
  const r = pickStampBatch([c("a"), c("b"), c("c"), c("d")], 3);
  assert.deepEqual(r.batch.map((x) => x.id), ["a", "b", "c"]);
  assert.equal(r.remaining, 1);
});

test("a position that expired before it opened is never picked (it can't get entry_dte)", () => {
  const r = pickStampBatch([{ id: "bad", symbol: "X", expiry: "2026-10-01", opened_date: "2026-10-20" }], 3);
  assert.deepEqual(r.batch, []);
  assert.equal(r.remaining, 0);
});

test("symbols from both accounts are deduped in first-seen order; a report without the field is fine", () => {
  assert.deepEqual(
    symbolsToEnrich([{ enrichSymbols: ["NFLX", "ISRG"] }, { enrichSymbols: ["NFLX", "COF"] }, {}]),
    ["NFLX", "ISRG", "COF"],
  );
});

test("close snapshots skip positions already snapped and are capped per request", () => {
  const ids = ["a", "b", "c", "d", "e", "f"];
  const r = pickCloseBatch(ids, new Set(["b"]), 4);
  assert.deepEqual(r.batch, ["a", "c", "d", "e"]);
  assert.equal(r.remaining, 1);
});

// Adversarial tests for lib/traded-status.ts + loader input handling.
// Tests marked DEFECT encode the expected behaviour and currently fail.
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveTradedStatus, tradedKey, type TradedPositionRow } from "./traded-status.ts";

const put = (over: Partial<TradedPositionRow>): TradedPositionRow => ({
  symbol: "COHR",
  status: "open",
  open_contracts: 2,
  broker: "robinhood",
  strike: "150.00",
  expiry: "2026-11-06",
  opened_date: "2026-11-04",
  total_contracts: 2,
  option_type: "put",
  direction: "short",
  position_type: "option",
  campaign_earnings_date: null,
  ...over,
});
const ev = { symbol: "COHR", earningsDate: "2026-11-04" };
const key = tradedKey("COHR", "2026-11-04");
const none = new Map<string, string>();

// an open leg whose fills weren't loaded (open_contracts null)
// gives openContracts 0, which PositionCell renders as "Closed /
// traded, nothing open" instead of "Traded / capital unverified".
test("open leg with unknown contracts must not look closed", () => {
  const s = resolveTradedStatus([ev], [put({ open_contracts: null })], none, "2026-11-04").get(key);
  assert.equal(s?.status, "synced");
  if (s?.status !== "synced") return;
  assert.equal(s.openCapital, null);
  // PositionCell's "Closed" branch is `openContracts === 0`.
  assert.notEqual(s.openContracts, 0, "open leg with unknown fills is reported as 0 open contracts -> UI says Closed");
});

// DEFECT (real data, NOW 2026-10-28): two Robinhood legs expired
// 2026-10-30 are still status=open in positions; they add $72,900 of
// "open capital" on 2026-11-04. A leg past its expiry holds no capital.
test("a leg past expiry still status=open is counted as open capital", () => {
  const s = resolveTradedStatus(
    [{ symbol: "NOW", earningsDate: "2026-10-28" }],
    [
      put({ symbol: "NOW", strike: 122, open_contracts: 3, opened_date: "2026-10-28", expiry: "2026-10-30", campaign_earnings_date: "2026-10-28" }),
      put({ symbol: "NOW", strike: 122, open_contracts: 6, opened_date: "2026-10-30", expiry: "2026-11-06", campaign_earnings_date: "2026-10-28" }),
    ],
    none, "2026-11-04").get(tradedKey("NOW", "2026-10-28"));
  if (s?.status !== "synced") return assert.fail("expected synced");
  // Evaluated on 2026-11-04 the first leg expired five days ago.
  assert.equal(s.openCapital, 122 * 100 * 6, `openCapital ${s.openCapital} includes an expired leg`);
});

test("stock legs (strike 0), covered calls and long puts never count", () => {
  const s = resolveTradedStatus(
    [ev],
    [
      put({ position_type: "stock_long", option_type: "put", strike: 0 }),
      put({ option_type: "call" }),
      put({ direction: "long" }),
    ],
    none, "2026-11-04").get(key);
  assert.deepEqual(s, { status: "none" });
});

test("no campaign: opened after the print does not count; expiry on print day counts (range rule)", () => {
  const after = resolveTradedStatus([ev], [put({ opened_date: "2026-11-05" })], none, "2026-11-04").get(key);
  assert.deepEqual(after, { status: "none" });
  const sameDay = resolveTradedStatus([ev], [put({ opened_date: "2026-11-03", expiry: "2026-11-04" })], none, "2026-11-04").get(key);
  assert.equal(sameDay?.status, "synced");
});

test("timestamps are sliced to dates; lowercase symbols match", () => {
  const s = resolveTradedStatus(
    [{ symbol: "cohr", earningsDate: "2026-11-04T00:00:00Z" }],
    [put({ symbol: "cohr", opened_date: "2026-11-04T21:30:00+00:00", expiry: "2026-11-06T00:00:00Z" })],
    none, "2026-11-04").get(key);
  assert.equal(s?.status, "synced");
});

test("synced wins over a manual mark; manual shows when nothing synced", () => {
  const marks = new Map([[key, "2026-11-04T10:00:00Z"]]);
  assert.equal(resolveTradedStatus([ev], [put({})], marks, "2026-11-04").get(key)?.status, "synced");
  assert.deepEqual(resolveTradedStatus([ev], [], marks, "2026-11-04").get(key), { status: "manual", markedAt: "2026-11-04T10:00:00Z" });
});

test("missing strike -> capital unknown (null), never 0", () => {
  const s = resolveTradedStatus([ev], [put({ strike: null }), put({ strike: 100 })], none, "2026-11-04").get(key);
  if (s?.status !== "synced") return assert.fail("expected synced");
  assert.equal(s.openCapital, null);
});

test("closed-only legs: traded, zero capital, zero open", () => {
  const s = resolveTradedStatus([ev], [put({ status: "closed", open_contracts: 0 })], none, "2026-11-04").get(key);
  if (s?.status !== "synced") return assert.fail("expected synced");
  assert.equal(s.openCapital, 0);
  assert.equal(s.openContracts, 0);
});

// Impossible-date (2026-13-45) loader crash is reproduced in
// scripts/.tmp-traded-baddate.ts (the loader imports @/ aliases, which
// plain `node --test` cannot resolve).

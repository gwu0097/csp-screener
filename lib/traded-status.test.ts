import { test } from "node:test";
import assert from "node:assert/strict";
import { describeTradedLegs, resolveTradedStatus, tradedKey, type TradedPositionRow } from "./traded-status.ts";

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
const none = new Map<string, string>();

test("a short put whose campaign is this print is synced", () => {
  const r = resolveTradedStatus([ev], [put({ campaign_earnings_date: "2026-11-04" })], none, "2026-11-04");
  const s = r.get(tradedKey("COHR", "2026-11-04"));
  assert.equal(s?.status, "synced");
  assert.deepEqual(s, {
    status: "synced",
    legs: [
      { broker: "robinhood", strike: 150, contracts: 2, openedDate: "2026-11-04", isOpen: true, pastExpiry: false, capital: 30000, openContracts: 2 },
    ],
    openCapital: 30000,
    openContracts: 2,
    staleOpenLegs: 0,
  });
});

test("a campaign keyed on a different print does not count, even if its window spans this one", () => {
  // NOW-style roll: opened after the 10-28 print, expiring past a later date.
  const r = resolveTradedStatus(
    [{ symbol: "NOW", earningsDate: "2026-11-04" }],
    [put({ symbol: "NOW", opened_date: "2026-10-30", expiry: "2026-11-06", campaign_earnings_date: "2026-10-28" })],
    none, "2026-11-04");
  assert.equal(r.get("NOW|2026-11-04")?.status, "none");
});

test("a roll opened after the print still counts when its campaign is this print", () => {
  const r = resolveTradedStatus(
    [{ symbol: "NOW", earningsDate: "2026-10-28" }],
    [put({ symbol: "NOW", opened_date: "2026-10-30", expiry: "2026-11-06", campaign_earnings_date: "2026-10-28" })],
    none, "2026-11-04");
  assert.equal(r.get("NOW|2026-10-28")?.status, "synced");
});

test("no campaign yet: falls back to the hold window spanning the print", () => {
  const spans = resolveTradedStatus([ev], [put({ opened_date: "2026-11-03", expiry: "2026-11-06" })], none, "2026-11-04");
  assert.equal(spans.get("COHR|2026-11-04")?.status, "synced");
  const expiredBefore = resolveTradedStatus([ev], [put({ opened_date: "2026-10-28", expiry: "2026-10-30" })], none, "2026-11-04");
  assert.equal(expiredBefore.get("COHR|2026-11-04")?.status, "none");
  const openedAfter = resolveTradedStatus([ev], [put({ opened_date: "2026-11-05", expiry: "2026-11-13" })], none, "2026-11-04");
  assert.equal(openedAfter.get("COHR|2026-11-04")?.status, "none");
});

test("stock legs, covered calls and long options never count", () => {
  const r = resolveTradedStatus(
    [ev],
    [
      put({ position_type: "stock_long", strike: "0.00" }),
      put({ option_type: "call", broker: "covered_calls" }),
      put({ direction: "long" }),
    ],
    none, "2026-11-04");
  assert.equal(r.get("COHR|2026-11-04")?.status, "none");
});

test("symbol match is case-insensitive and exact (no prefix matches)", () => {
  const r = resolveTradedStatus(
    [{ symbol: "cohr", earningsDate: "2026-11-04" }],
    [put({ symbol: "COHRX" }), put({ symbol: "cohr", strike: 140 })],
    none, "2026-11-04");
  const s = r.get("COHR|2026-11-04");
  assert.equal(s?.status === "synced" && s.legs.length, 1);
});

test("manual mark shows when nothing synced; synced wins once the fill lands", () => {
  const marks = new Map([["COHR|2026-11-04", "2026-11-04T20:00:00Z"]]);
  assert.deepEqual(resolveTradedStatus([ev], [], marks, "2026-11-04").get("COHR|2026-11-04"), {
    status: "manual",
    markedAt: "2026-11-04T20:00:00Z",
  });
  assert.equal(resolveTradedStatus([ev], [put({})], marks, "2026-11-04").get("COHR|2026-11-04")?.status, "synced");
});

test("a manual mark on another print of the same ticker doesn't leak", () => {
  const marks = new Map([["COHR|2026-08-12", "2026-08-12T20:00:00Z"]]);
  assert.equal(resolveTradedStatus([ev], [], marks, "2026-11-04").get("COHR|2026-11-04")?.status, "none");
});

test("describeTradedLegs: one line per leg, missing strike shows a dash", () => {
  assert.equal(
    describeTradedLegs([
      { broker: "robinhood", strike: 150, contracts: 2, openedDate: "2026-11-04", isOpen: true, pastExpiry: false, capital: 30000, openContracts: 2 },
      { broker: "schwab2", strike: 287.5, contracts: null, openedDate: "2026-11-03", isOpen: false, pastExpiry: false, capital: null, openContracts: 0 },
      { broker: null, strike: null, contracts: 1, openedDate: "2026-11-03", isOpen: true, pastExpiry: false, capital: null, openContracts: null },
      { broker: "robinhood", strike: 121, contracts: 3, openedDate: "2026-10-28", isOpen: false, pastExpiry: true, capital: null, openContracts: 0 },
    ]),
    "Robinhood 2× $150 · opened 2026-11-04\nSchwab 2 $287.50 · opened 2026-11-03 · closed\nBroker 1× — · opened 2026-11-03\nRobinhood 3× $121 · opened 2026-10-28 · past expiry, still marked open",
  );
});

test("capital: open legs only, partial closes reduce it, closed legs add none", () => {
  const r = resolveTradedStatus(
    [ev],
    [
      put({ strike: "150.00", total_contracts: 3, open_contracts: 1 }),
      put({ strike: "140", broker: "schwab", open_contracts: 2 }),
      put({ strike: "155", status: "closed", open_contracts: 0 }),
    ],
    none, "2026-11-04");
  const s = r.get("COHR|2026-11-04");
  assert.equal(s?.status, "synced");
  if (s?.status !== "synced") return;
  assert.equal(s.openCapital, 15000 + 28000);
  assert.equal(s.openContracts, 3);
  assert.equal(s.legs.length, 3);
});

test("capital is unknown (null), never 0, when an open leg's fills are missing", () => {
  const s = resolveTradedStatus([ev], [put({ open_contracts: null }), put({ strike: 140 })], none, "2026-11-04").get("COHR|2026-11-04");
  assert.equal(s?.status === "synced" && s.openCapital, null);
});

test("all legs closed: still traded, zero open capital", () => {
  const s = resolveTradedStatus([ev], [put({ status: "closed", open_contracts: 0 })], none, "2026-11-04").get("COHR|2026-11-04");
  assert.deepEqual(s?.status === "synced" && [s.openCapital, s.openContracts], [0, 0]);
});

test("a leg still marked open past its expiry is counted as stale, not as open capital", () => {
  const s = resolveTradedStatus(
    [ev],
    [put({ expiry: "2026-11-04", opened_date: "2026-11-02", open_contracts: 3 }), put({})],
    none,
    "2026-11-05",
  ).get("COHR|2026-11-04");
  if (s?.status !== "synced") return assert.fail("expected synced");
  assert.equal(s.openCapital, 30000);
  assert.equal(s.openContracts, 2);
  assert.equal(s.staleOpenLegs, 1);
  // Expiry day itself is still open.
  const same = resolveTradedStatus([ev], [put({ expiry: "2026-11-05" })], none, "2026-11-05").get("COHR|2026-11-04");
  assert.equal(same?.status === "synced" && same.staleOpenLegs, 0);
});

test("request parsing: impossible dates rejected, trailing comma tolerated, duplicates collapsed", async () => {
  const { isIsoDate, parseTradedEvents } = await import("./traded-status.ts");
  assert.equal(isIsoDate("2026-11-04"), true);
  assert.equal(isIsoDate("2026-13-45"), false);
  assert.equal(isIsoDate("2026-02-30"), false);
  assert.equal(parseTradedEvents("COHR:2026-13-45"), null);
  assert.deepEqual(parseTradedEvents("cohr:2026-11-04,,COHR:2026-11-04,"), [{ symbol: "COHR", earningsDate: "2026-11-04" }]);
  assert.equal(parseTradedEvents("CO HR:2026-11-04"), null);
  assert.deepEqual(parseTradedEvents(null), []);
});

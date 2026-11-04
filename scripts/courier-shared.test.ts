import { test } from "node:test";
import assert from "node:assert/strict";
import { authExpiry, extractFirstJsonValue, ordinal, truncateWithNote } from "./courier-shared.ts";

test("extracts the first JSON value even when Claude wraps it in prose or fences", () => {
  const body = '{"count":1,"rows":[["ARM","2026-11-04","pm",true]]}';
  assert.equal(extractFirstJsonValue("Here you go:\n```json\n" + body + "\n```"), body);
  assert.equal(extractFirstJsonValue('[{"a":"}"}] trailing'), '[{"a":"}"}]');
  assert.throws(() => extractFirstJsonValue("no json here"), /No JSON value/);
  assert.throws(() => extractFirstJsonValue('{"count":695,"rows":[["ARM"'), /Unbalanced/);
});

test("login-expiry detection names the fix in the alert", () => {
  assert.equal(authExpiry("Failed to authenticate: OAuth session expired").expired, true);
  assert.match(authExpiry("HTTP 401").line, /LOGIN EXPIRED/);
  assert.deepEqual(authExpiry("ETIMEDOUT"), { expired: false, line: "" });
});

test("ordinal and truncation helpers", () => {
  assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 22, 23].map(ordinal), ["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "23rd"]);
  assert.equal(truncateWithNote("abcdef", 3), "abc... [truncated, 6 chars total]");
  assert.equal(truncateWithNote("abc", 3), "abc");
});

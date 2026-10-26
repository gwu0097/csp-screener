import { test } from "node:test";
import assert from "node:assert/strict";
import { isCrushCaptureFailure, t1DayFailedCount } from "./crush-capture-outcomes.ts";

test("too_early_capture is a retry, not a failure", () => {
  assert.equal(isCrushCaptureFailure("too_early_capture"), false);
});

test("benign skips and schwab_disconnected are not counted as errored", () => {
  assert.equal(isCrushCaptureFailure("already_captured"), false);
  assert.equal(isCrushCaptureFailure("premature_capture_session"), false);
  assert.equal(isCrushCaptureFailure("schwab_disconnected"), false);
});

test("real failures and unknown reasons count (fail closed)", () => {
  assert.equal(isCrushCaptureFailure("corrupted_t0_baseline"), true);
  assert.equal(isCrushCaptureFailure("chain_fetch_failed"), true);
  assert.equal(isCrushCaptureFailure("invalid_volatility_quote"), true);
  assert.equal(isCrushCaptureFailure("something_new"), true);
  assert.equal(isCrushCaptureFailure(null), true);
  assert.equal(isCrushCaptureFailure(undefined), true);
});

// Mirrors the stored 2026-10-22 T1 rollup: 8 outstanding, of which only
// the four corrupted baselines were real failures.
test("re-judges an old rollup: retries that later captured drop out", () => {
  const outstanding = ["BKR", "CCI", "HBAN", "TFX", "ALLE", "GD", "TSCO", "OMC"].map((symbol) => ({
    symbol,
    earnings_date: "2026-10-22",
  }));
  const attempts = [
    ...["BKR", "CCI", "HBAN", "GD"].flatMap((symbol) => [
      { symbol, earnings_date: "2026-10-22", outcome: "too_early_capture" },
      { symbol, earnings_date: "2026-10-22", outcome: "corrupted_t0_baseline" },
    ]),
    { symbol: "TFX", earnings_date: "2026-10-22", outcome: "too_early_capture" },
    { symbol: "ALLE", earnings_date: "2026-10-22", outcome: "too_early_capture" },
    { symbol: "ALLE", earnings_date: "2026-10-22", outcome: "captured" },
    { symbol: "TSCO", earnings_date: "2026-10-22", outcome: "too_early_capture" },
    { symbol: "TSCO", earnings_date: "2026-10-22", outcome: "captured" },
    { symbol: "OMC", earnings_date: "2026-10-22", outcome: "too_early_capture" },
    { symbol: "OMC", earnings_date: "2026-10-22", outcome: "captured" },
  ];
  assert.equal(t1DayFailedCount(outstanding, attempts), 4);
});

test("an outstanding event with no recorded attempts stays failed", () => {
  assert.equal(t1DayFailedCount([{ symbol: "X", earnings_date: "2026-10-22" }], []), 1);
  assert.equal(t1DayFailedCount([{ symbol: "X", earnings_date: null }], []), 1);
});

test("matching is case-insensitive on symbol and keyed by earnings date", () => {
  const attempts = [
    { symbol: "PM", earnings_date: "2026-10-20", outcome: "too_early_capture" },
    { symbol: "PM", earnings_date: "2026-07-21", outcome: "chain_fetch_failed" },
  ];
  assert.equal(t1DayFailedCount([{ symbol: "pm", earnings_date: "2026-10-20" }], attempts), 0);
});

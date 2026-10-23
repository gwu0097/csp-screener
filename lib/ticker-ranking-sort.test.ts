import { test } from "node:test";
import assert from "node:assert/strict";
import {
  defaultSortDir,
  gradeRank,
  recAccuracy,
  sortTickerRankings,
  type SortableTickerRanking,
} from "./ticker-ranking-sort.ts";

function row(p: Partial<SortableTickerRanking> & { symbol: string }): SortableTickerRanking {
  return {
    trades: 1,
    win_rate: 1,
    avg_roc: null,
    best_roc: null,
    top_grade: null,
    rec_aligned: null,
    rec_total: null,
    ...p,
  };
}

const syms = (rows: SortableTickerRanking[]) => rows.map((r) => r.symbol);

test("numeric columns sort both ways", () => {
  const rows = [row({ symbol: "A", trades: 2 }), row({ symbol: "B", trades: 13 }), row({ symbol: "C", trades: 1 })];
  assert.deepEqual(syms(sortTickerRankings(rows, "trades", "desc")), ["B", "A", "C"]);
  assert.deepEqual(syms(sortTickerRankings(rows, "trades", "asc")), ["C", "A", "B"]);
});

test("missing values sort last in either direction", () => {
  const rows = [
    row({ symbol: "NONE", avg_roc: null }),
    row({ symbol: "LOW", avg_roc: 0.001 }),
    row({ symbol: "HIGH", avg_roc: 0.05 }),
  ];
  assert.deepEqual(syms(sortTickerRankings(rows, "avg_roc", "desc")), ["HIGH", "LOW", "NONE"]);
  assert.deepEqual(syms(sortTickerRankings(rows, "avg_roc", "asc")), ["LOW", "HIGH", "NONE"]);
});

test("symbol sorts alphabetically", () => {
  const rows = [row({ symbol: "ZS" }), row({ symbol: "GWRE" }), row({ symbol: "RKT" })];
  assert.deepEqual(syms(sortTickerRankings(rows, "symbol", "asc")), ["GWRE", "RKT", "ZS"]);
  assert.deepEqual(syms(sortTickerRankings(rows, "symbol", "desc")), ["ZS", "RKT", "GWRE"]);
});

test("grade sorts best-first on desc, ungraded last", () => {
  const rows = [
    row({ symbol: "F1", top_grade: "F" }),
    row({ symbol: "NA", top_grade: null }),
    row({ symbol: "A1", top_grade: "A" }),
    row({ symbol: "B1", top_grade: "B" }),
  ];
  assert.deepEqual(syms(sortTickerRankings(rows, "grade", "desc")), ["A1", "B1", "F1", "NA"]);
  assert.deepEqual(syms(sortTickerRankings(rows, "grade", "asc")), ["F1", "B1", "A1", "NA"]);
});

test("gradeRank orders modifiers and rejects unknown strings", () => {
  assert.ok(gradeRank("A+")! > gradeRank("A")!);
  assert.ok(gradeRank("A-")! > gradeRank("B+")!);
  assert.ok(gradeRank("D")! > gradeRank("F")!);
  assert.equal(gradeRank("?"), null);
  assert.equal(gradeRank(null), null);
});

test("rec accuracy: unscored recs are unknown, not 0%", () => {
  assert.equal(recAccuracy(row({ symbol: "X", rec_aligned: 0, rec_total: 0 })), null);
  assert.equal(recAccuracy(row({ symbol: "X", rec_aligned: 2, rec_total: 2 })), 1);
  const rows = [
    row({ symbol: "UNSCORED", rec_aligned: null, rec_total: null }),
    row({ symbol: "HALF", rec_aligned: 1, rec_total: 2 }),
    row({ symbol: "ALL", rec_aligned: 2, rec_total: 2 }),
  ];
  assert.deepEqual(syms(sortTickerRankings(rows, "rec_accuracy", "desc")), ["ALL", "HALF", "UNSCORED"]);
});

test("ties break by symbol so order is stable", () => {
  const rows = [row({ symbol: "NKE", trades: 2 }), row({ symbol: "GWRE", trades: 2 })];
  assert.deepEqual(syms(sortTickerRankings(rows, "trades", "desc")), ["GWRE", "NKE"]);
});

test("first click direction: text A→Z, numbers best-first", () => {
  assert.equal(defaultSortDir("symbol"), "asc");
  assert.equal(defaultSortDir("avg_roc"), "desc");
  assert.equal(defaultSortDir("grade"), "desc");
});

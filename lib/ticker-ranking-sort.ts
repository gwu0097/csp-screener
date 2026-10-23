// Column sorting for the Capital Efficiency by Ticker table
// (components/intelligence-shared.tsx). Pure — no I/O — so the ordering
// rules are unit-testable (lib/ticker-ranking-sort.test.ts).
//
// Missing values (no ROC, no grade, no scored recs) are unknown, not 0:
// they always sort to the bottom, in either direction, so flipping the
// sort never floods the top of the table with dashes.

export type TickerRankingSortKey =
  | "symbol"
  | "trades"
  | "win_rate"
  | "avg_roc"
  | "best_roc"
  | "grade"
  | "rec_accuracy";

export type SortDir = "asc" | "desc";

export type SortableTickerRanking = {
  symbol: string;
  trades: number;
  win_rate: number;
  avg_roc: number | null;
  best_roc: number | null;
  top_grade: string | null;
  rec_aligned: number | null;
  rec_total: number | null;
};

// First click on a column: text columns start A→Z, everything else
// starts best-first (highest number, best grade).
export function defaultSortDir(key: TickerRankingSortKey): SortDir {
  return key === "symbol" ? "asc" : "desc";
}

// Grade as a number where higher is better: A+ > A > A- > B+ … > F.
// Unrecognised strings are unknown (null).
export function gradeRank(grade: string | null): number | null {
  if (!grade) return null;
  const m = /^([A-DF])([+-]?)$/.exec(grade.trim().toUpperCase());
  if (!m) return null;
  const letter = "FDCBA".indexOf(m[1]);
  const mod = m[2] === "+" ? 1 : m[2] === "-" ? -1 : 0;
  return letter * 3 + mod;
}

// Share of scored recommendations that were correct. Unscored or
// absent recs are unknown (null), not 0% accurate.
export function recAccuracy(row: SortableTickerRanking): number | null {
  if (row.rec_total === null || row.rec_total <= 0 || row.rec_aligned === null) return null;
  return row.rec_aligned / row.rec_total;
}

function sortValue(row: SortableTickerRanking, key: TickerRankingSortKey): number | string | null {
  switch (key) {
    case "symbol":
      return row.symbol;
    case "trades":
      return row.trades;
    case "win_rate":
      return row.win_rate;
    case "avg_roc":
      return row.avg_roc;
    case "best_roc":
      return row.best_roc;
    case "grade":
      return gradeRank(row.top_grade);
    case "rec_accuracy":
      return recAccuracy(row);
  }
}

// Returns a new array; ties fall back to symbol A→Z so the order is
// stable across re-renders.
export function sortTickerRankings<T extends SortableTickerRanking>(
  rows: readonly T[],
  key: TickerRankingSortKey,
  dir: SortDir,
): T[] {
  const sign = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = sortValue(a, key);
    const bv = sortValue(b, key);
    if (av === null && bv !== null) return 1;
    if (bv === null && av !== null) return -1;
    if (av !== null && bv !== null && av !== bv) {
      const cmp = typeof av === "string" ? av.localeCompare(bv as string) : av - (bv as number);
      return sign * cmp;
    }
    return a.symbol.localeCompare(b.symbol);
  });
}

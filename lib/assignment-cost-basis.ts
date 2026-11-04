// Per-share cost basis for a stock lot created by a put assignment.
// Pure — tested in lib/assignment-cost-basis.test.ts.
//
// createStockFromAssignment zeroes the parent put's realized P&L and
// folds it into the stock's cost basis, so the stock round-trip carries
// the whole economic result. What gets folded must be exactly what's
// being zeroed: the put's realized P&L, which recordAssignment has just
// computed over every fill (premium on assigned contracts plus the
// net on any contracts opened and closed earlier on the same row).
//
// The old rule, strike − avg_premium_sold, credited the average premium
// of EVERY contract ever opened to the assigned shares. NOW $122P
// 2026-10-30 (Robinhood): 3 sold at $0.33, 6 more sold at $17.90 and
// bought back at $17.82 the same minute. The average, $12.04, was
// credited to all 300 assigned shares ($3,613) though the put had only
// earned $147 — overstating the cycle by $3,466.
export function assignmentCostBasis(input: {
  strike: number;
  shares: number;
  // Parent put's realized P&L right before it's zeroed; null = unknown.
  parentRealizedPnl: number | null;
  avgPremiumSold: number | null;
}): number {
  const { strike, shares, parentRealizedPnl, avgPremiumSold } = input;
  const perShareCredit =
    parentRealizedPnl !== null && Number.isFinite(parentRealizedPnl) && shares > 0
      ? parentRealizedPnl / shares
      : (avgPremiumSold ?? 0);
  return Math.round((strike - perShareCredit) * 10000) / 10000;
}

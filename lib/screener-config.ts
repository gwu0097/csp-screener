// SCREENER_CONFIG — single source of truth for the active screener's
// criteria. Surface in the UI so users can see exactly what's being
// filtered, and as the foundation for future named screeners (e.g.
// "Swing Earnings", "Long-Term Quality") that share this shape.
//
// When a threshold here changes, update the live filter in
// app/api/screener/screen/route.ts + lib/screener.ts and re-run
// Test/probe-screen-today.ts to confirm the new candidate count.

export type ScreenerFilterValue = number | string | boolean;

export type ScreenerConfig = {
  id: string;
  name: string;
  description: string;
  filters: Record<string, { value: ScreenerFilterValue; label: string }>;
  notes: string;
};

// Hard floors used by both the screener route and the UI display.
// Exported as named constants so other modules can import them
// directly (e.g. screen/route.ts uses MIN_MARKET_CAP_BILLIONS for the
// per-row filter).
export const MIN_MARKET_CAP_BILLIONS = 5;

export const CSP_EARNINGS_SCREENER: ScreenerConfig = {
  id: "csp-earnings",
  name: "CSP Earnings",
  description:
    "Cash-secured puts on earnings stocks reporting today (AMC) or " +
    "tomorrow (BMO). Filters for liquid large-cap names with weekly " +
    "options chains where IV crush is the edge.",
  filters: {
    priceFloor: {
      value: 70,
      label: "Stock price ≥ $70",
    },
    minMarketCap: {
      value: MIN_MARKET_CAP_BILLIONS * 1_000_000_000,
      label: `Market cap ≥ $${MIN_MARKET_CAP_BILLIONS}B (hard floor)`,
    },
    minMarketCapTier: {
      value: 1,
      label: "Market cap tier ≥ 1 ($10B+)",
    },
    requireWeeklyChain: {
      value: true,
      label: "Has a weekly options expiry the Friday on/after earnings",
    },
    analystDispersion: {
      value: "not used",
      label: "Analyst dispersion: not gated",
    },
  },
  notes:
    "Analyst dispersion was removed from the gate after a CLI " +
    "simulation showed it was knocking out legitimate $20-30B mid-cap " +
    "CSP names on false-negative analyst data (Finnhub free tier " +
    "returns empty for many large stocks). Market cap tier is the " +
    "proxy for options-chain liquidity. Whitelisted symbols bypass " +
    "every filter except blacklist + ETF detection.",
};

// Default screener for the current single-screener world. When more
// screeners ship, this becomes the active selection from a registry.
export const ACTIVE_SCREENER = CSP_EARNINGS_SCREENER;

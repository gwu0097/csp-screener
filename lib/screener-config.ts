// SCREENER_CONFIG — the shape and system presets for named screeners.
// Configs are persisted in the screener_configs table (see
// lib/screener-configs-db.ts); the presets here are seeded on first
// read and act as the in-memory fallback when the DB is unreachable.
//
// The live screen route resolves the selected config through
// resolveScreenerFilters() and applies those values directly — there
// are no duplicate hardcoded thresholds to drift from this file.

export type ScreenerFilterValue = number | string | boolean;

export type ScreenerConfig = {
  id: string;
  name: string;
  description: string;
  filters: Record<string, { value: ScreenerFilterValue; label: string }>;
  notes: string;
};

// Config + DB metadata. System presets are seeded, non-editable and
// non-deletable; users clone them into custom rows.
export type ScreenerConfigRow = ScreenerConfig & { isSystem: boolean };

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

export const SWING_EARNINGS_SCREENER: ScreenerConfig = {
  id: "swing-earnings",
  name: "Swing Earnings",
  description:
    "Earnings momentum plays — wider universe, lower capital requirements",
  filters: {
    priceFloor: {
      value: 50,
      label: "Stock price ≥ $50",
    },
    minMarketCap: {
      value: 2_000_000_000,
      label: "Market cap ≥ $2B (hard floor)",
    },
    minMarketCapTier: {
      value: 0,
      label: "Market cap tier: not gated",
    },
    requireWeeklyChain: {
      value: false,
      label: "Weekly options chain: not required",
    },
  },
  notes:
    "Starting-point preset — clone and customize. Smaller caps pass; " +
    "rows without a weekly chain are kept (monthly expiries are fine " +
    "for swing entries).",
};

export const LARGE_CAP_ONLY_SCREENER: ScreenerConfig = {
  id: "large-cap-only",
  name: "Large Cap Only",
  description:
    "Blue chip earnings only — highest quality, most liquid chains",
  filters: {
    priceFloor: {
      value: 100,
      label: "Stock price ≥ $100",
    },
    minMarketCap: {
      value: 20_000_000_000,
      label: "Market cap ≥ $20B (hard floor)",
    },
    minMarketCapTier: {
      value: 2,
      label: "Market cap tier ≥ 2",
    },
    requireWeeklyChain: {
      value: true,
      label: "Has a weekly options expiry the Friday on/after earnings",
    },
  },
  notes:
    "Starting-point preset — clone and customize. Tightest gates of " +
    "the system presets; expect a short candidate list.",
};

// Seeded into screener_configs on first read; also the no-DB fallback.
export const SYSTEM_SCREENER_PRESETS: ScreenerConfig[] = [
  CSP_EARNINGS_SCREENER,
  SWING_EARNINGS_SCREENER,
  LARGE_CAP_ONLY_SCREENER,
];

export const DEFAULT_SCREENER_ID = CSP_EARNINGS_SCREENER.id;

// The concrete, typed values the screen pipeline runs on. Resolved
// from a config's filters map with the CSP Earnings values as
// fallbacks for missing/malformed entries, so a hand-edited DB row
// can never crash the screen.
export type ResolvedScreenerFilters = {
  priceFloor: number;
  minMarketCapBillions: number;
  // <= 0 disables the Stage 2 tier gate entirely.
  minMarketCapTier: number;
  requireWeeklyChain: boolean;
};

export function resolveScreenerFilters(
  cfg: ScreenerConfig,
): ResolvedScreenerFilters {
  const num = (key: string, fallback: number): number => {
    const v = cfg.filters[key]?.value;
    return typeof v === "number" && Number.isFinite(v) ? v : fallback;
  };
  const bool = (key: string, fallback: boolean): boolean => {
    const v = cfg.filters[key]?.value;
    return typeof v === "boolean" ? v : fallback;
  };
  // minMarketCap is stored in dollars (5_000_000_000) but small values
  // are tolerated as billions so a hand-typed "5" still means $5B.
  const mcapRaw = num("minMarketCap", MIN_MARKET_CAP_BILLIONS * 1e9);
  return {
    priceFloor: num("priceFloor", 70),
    minMarketCapBillions: mcapRaw >= 100_000 ? mcapRaw / 1e9 : mcapRaw,
    minMarketCapTier: num("minMarketCapTier", 1),
    requireWeeklyChain: bool("requireWeeklyChain", true),
  };
}

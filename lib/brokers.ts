// Canonical list of "account" buckets across the app — the real brokers
// (schwab, schwab2, robinhood) plus the covered_calls pseudo-account
// (added in 3674eee). Any UI that filters, groups, or rolls up positions
// by account should import from here instead of hardcoding its own list —
// a hardcoded copy silently misses new accounts (the Performance page's
// broker filter did exactly this until it was fixed to use this module).
export const BROKER_ORDER = ["schwab", "schwab2", "robinhood", "covered_calls"] as const;
export type BrokerKey = (typeof BROKER_ORDER)[number];

export const BROKER_LABEL: Record<string, string> = {
  schwab: "Schwab",
  schwab2: "Schwab 2",
  robinhood: "Robinhood",
  covered_calls: "Covered Calls",
  other: "Other",
};

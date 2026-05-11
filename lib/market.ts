import { getCurrentPrice, getQuoteWithExtended } from "./yahoo";

export type MarketRegime = "calm" | "elevated" | "panic";

export type MarketContext = {
  vix: number | null;
  spyPrice: number | null;
  regime: MarketRegime | null;
  warning: string | null;
  // Yahoo marketState string for SPY: 'PRE' / 'PREPRE' / 'REGULAR' /
  // 'POST' / 'POSTPOST' / 'CLOSED', or null when the quote failed.
  // Drives UI suppression of option-mark-derived fields (P&L, POP,
  // IV) outside regular session — option chains keep quoting stale
  // last-traded prices after the close and surfacing them as live
  // numbers misleads the user.
  marketState: string | null;
};

// Regime thresholds match the Positions page warnings:
// VIX > 35 → "panic" (avoid new CSPs)
// VIX > 25 → "elevated" (size down)
// otherwise → "calm"
export function classifyRegime(vix: number | null): MarketRegime | null {
  if (vix === null || !Number.isFinite(vix)) return null;
  if (vix > 35) return "panic";
  if (vix > 25) return "elevated";
  return "calm";
}

export function regimeWarning(regime: MarketRegime | null): string | null {
  if (regime === "panic") return "Market panic — avoid new CSP trades";
  if (regime === "elevated") return "Elevated market volatility — size down or skip new trades";
  return null;
}

export async function getMarketContext(): Promise<MarketContext> {
  const [vix, spyQuote] = await Promise.all([
    getCurrentPrice("^VIX"),
    getQuoteWithExtended("SPY"),
  ]);
  const regime = classifyRegime(vix);
  return {
    vix,
    spyPrice: spyQuote.price,
    regime,
    warning: regimeWarning(regime),
    marketState: spyQuote.marketState,
  };
}

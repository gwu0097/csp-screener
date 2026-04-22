import { getCurrentPrice } from "./yahoo";

export type MarketRegime = "calm" | "elevated" | "panic";

export type MarketContext = {
  vix: number | null;
  spyPrice: number | null;
  regime: MarketRegime | null;
  warning: string | null;
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
  const [vix, spyPrice] = await Promise.all([
    getCurrentPrice("^VIX"),
    getCurrentPrice("SPY"),
  ]);
  const regime = classifyRegime(vix);
  return { vix, spyPrice, regime, warning: regimeWarning(regime) };
}

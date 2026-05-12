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

// True when the ET wall clock is inside the 9:30–16:00 regular
// session on a Mon–Fri. Used as a ground-truth fallback when
// Yahoo's marketState lags — e.g. before market open the SPY quote
// reads "PRE" / "CLOSED", and on a slow Yahoo cache that state can
// persist past 9:30 ET. The clock-based answer takes precedence
// because options chains gate on real session boundaries.
//
// Doesn't account for NYSE holidays — those would falsely report
// REGULAR. Option marks on a holiday will be stale anyway and the
// "Market closed" badge is informational, not blocking; the user
// will notice marks at last-close prices and click away.
export function isMarketHoursET(now: Date = new Date()): boolean {
  // Day of week + hh:mm in America/New_York. en-GB locale gives
  // 24-hour HH:mm in the time part for easy parsing.
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const weekday = parts.find((p) => p.type === "weekday")?.value ?? "";
  const hourStr = parts.find((p) => p.type === "hour")?.value ?? "0";
  const minStr = parts.find((p) => p.type === "minute")?.value ?? "0";
  let hour = Number(hourStr);
  if (hour === 24) hour = 0; // some locales render midnight as 24
  const minute = Number(minStr);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return false;
  if (weekday === "Sat" || weekday === "Sun") return false;
  const minutesSinceMidnight = hour * 60 + minute;
  // 9:30 = 570, 16:00 = 960
  return minutesSinceMidnight >= 570 && minutesSinceMidnight < 960;
}

export async function getMarketContext(): Promise<MarketContext> {
  const [vix, spyQuote] = await Promise.all([
    getCurrentPrice("^VIX"),
    getQuoteWithExtended("SPY"),
  ]);
  const regime = classifyRegime(vix);

  // Yahoo's marketState frequently lags the actual session boundary
  // (especially pre-open, where SPY can read "PRE" or "CLOSED" for
  // several minutes after 9:30 ET). Treat the ET wall clock as
  // authoritative: when the clock says we're in regular hours,
  // force marketState=REGULAR regardless of Yahoo. We only override
  // the "force open" direction; if Yahoo says REGULAR after hours
  // (which it doesn't tend to do), leave it alone.
  let marketState = spyQuote.marketState;
  if (isMarketHoursET() && marketState !== "REGULAR") {
    console.log(
      `[market] marketState override: yahoo=${marketState ?? "null"} → REGULAR (ET clock inside 9:30–16:00 Mon–Fri)`,
    );
    marketState = "REGULAR";
  }

  return {
    vix,
    spyPrice: spyQuote.price,
    regime,
    warning: regimeWarning(regime),
    marketState,
  };
}

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
// session on a Mon–Fri. Uses Intl.DateTimeFormat with an explicit
// America/New_York timeZone so the answer is the same on any
// server runtime (Vercel UTC, local PT, container HK, etc.) — the
// underlying Date is the same instant, only the display changes.
//
// Doesn't account for NYSE holidays — those would falsely report
// REGULAR. Option marks on a holiday will be stale anyway and the
// "Market closed" badge is informational, not blocking; the user
// will notice marks at last-close prices and click away.
export function isMarketHoursET(now: Date = new Date()): boolean {
  const etParts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
    weekday: "short",
  }).formatToParts(now);

  const hour = parseInt(
    etParts.find((p) => p.type === "hour")?.value ?? "0",
    10,
  );
  const minute = parseInt(
    etParts.find((p) => p.type === "minute")?.value ?? "0",
    10,
  );
  const weekday = etParts.find((p) => p.type === "weekday")?.value ?? "";

  // Some Node/ICU builds render midnight as "24" with hour12:false.
  const normalizedHour = hour === 24 ? 0 : hour;

  // Mon–Fri only.
  if (weekday === "Sat" || weekday === "Sun") return false;
  if (!Number.isFinite(normalizedHour) || !Number.isFinite(minute)) return false;

  // 9:30 AM ET (570 min) to 4:00 PM ET (960 min), half-open interval.
  const timeInMinutes = normalizedHour * 60 + minute;
  return timeInMinutes >= 570 && timeInMinutes < 960;
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
  // Log the raw ET clock + Yahoo reply on every fetch so the next
  // misbehavior is visible in server logs without an ad-hoc deploy.
  const etDebug = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "numeric",
    weekday: "short",
    hour12: false,
  }).format(new Date());
  const inHours = isMarketHoursET();
  console.log(
    `[market] yahoo.marketState=${spyQuote.marketState ?? "null"}  ET=${etDebug}  isMarketHoursET=${inHours}`,
  );

  let marketState = spyQuote.marketState;
  if (inHours && marketState !== "REGULAR") {
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

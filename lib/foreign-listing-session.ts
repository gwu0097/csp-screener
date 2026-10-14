// Finnhub files some ADRs' earnings under the company's home listing
// (TSM -> 2330.TW). For an Asia-Pacific listing its "amc" on date D means
// after the home market's close, which is overnight in New York: the
// numbers land before the US open of D+1. For a US trader that is a BMO
// on D+1 (Earnings Whispers lists TSMC the same way), so the row is
// relabelled. A BMO stays as Finnhub says, and so does every other
// market: Europe's after-close is during the US session, not overnight.
// Pure: no I/O.

const ASIA_PACIFIC_SUFFIXES = [".TW", ".TWO", ".T", ".HK", ".KS", ".KQ", ".SS", ".SZ", ".SI", ".AX", ".NZ", ".BO", ".NS", ".JK", ".BK", ".KL"];

export function isAsiaPacificListing(symbol: string): boolean {
  const s = symbol.toUpperCase();
  return ASIA_PACIFIC_SUFFIXES.some((suffix) => s.endsWith(suffix));
}

function nextDayIso(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + 1));
  return dt.toISOString().slice(0, 10);
}

/** The US session of a calendar row: an Asia-Pacific listing's AMC on D
 * becomes BMO on D+1; anything else is returned unchanged. */
export function usSessionFor<T extends string>(
  listingSymbol: string,
  date: string,
  timing: T,
): { date: string; timing: T | "BMO" } {
  if (timing === "AMC" && isAsiaPacificListing(listingSymbol)) {
    return { date: nextDayIso(date), timing: "BMO" };
  }
  return { date, timing };
}

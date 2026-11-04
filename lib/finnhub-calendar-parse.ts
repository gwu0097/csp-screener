// Parsing + dedupe of raw Finnhub /calendar/earnings rows. Pure (no
// imports) so node --test can exercise it; lib/earnings.ts re-exports
// the types.

export type EarningsCalendarItem = {
  symbol: string;
  date: string;
  // DMH (during market hours) is excluded upstream. "unknown" = Finnhub
  // gave no hour; kept (not dropped) so Screen Today can show it and
  // compare it with Robinhood (lib/earnings-source-merge.ts).
  timing: "BMO" | "AMC" | "DMH" | "unknown";
  estimatedEPS: number | null;
  actualEPS: number | null;
};

export type FinnhubCalendarEntry = {
  symbol: string;
  date: string;
  hour?: string; // "bmo" | "amc" | "dmh"
  epsEstimate?: number | null;
  epsActual?: number | null;
  revenueEstimate?: number | null;
  quarter?: number;
  year?: number;
};

// Collapses raw Finnhub calendar rows that share the same
// symbol+date+timing key. Confirmed via a live query (2026-08-18) that
// Finnhub can return the same real-world earnings event twice under
// different fiscal quarter/year labels — TGT's 2026-08-19 BMO print
// appeared as both fiscal "2026 Q2" (epsEstimate/revenueEstimate both
// null) and fiscal "2027 Q2" (live consensus data), almost certainly a
// fiscal-year-offset artifact for a retailer whose fiscal year doesn't
// match the calendar year. Nothing downstream ever deduped on symbol —
// not getTodayEarnings' date/timing filter, not the screener's
// candidate pipeline — so both rows survived all the way to the
// rendered table as two identical-looking TGT rows.
//
// When two rows collapse, keep the more complete one — count of
// non-null epsEstimate/revenueEstimate — rather than picking by array
// position: Finnhub does not guarantee the live-data row comes first
// (TGT's case had it second), so first-wins would silently discard
// whichever row happened to carry the real estimates. A genuine tie
// (equal completeness) keeps whichever was seen first — a stable,
// harmless tiebreak, since the asymmetric null-vs-live case is the one
// that actually matters and that's never decided by position.
//
// Logged at info level (symbol, date, timing, and what differed
// between the two rows) so it's visible in Vercel function logs how
// often this happens and whether it clusters on off-calendar fiscal
// years, without needing a dedicated table for something expected to
// be rare.
export function parseAndDedupeCalendarRows(rows: FinnhubCalendarEntry[]): EarningsCalendarItem[] {
  type Candidate = {
    symbol: string;
    date: string;
    timing: EarningsCalendarItem["timing"];
    estimatedEPS: number | null;
    actualEPS: number | null;
    revenueEstimate: number | null;
    quarter: number | null;
    year: number | null;
  };

  const completeness = (c: Candidate): number =>
    (c.estimatedEPS !== null ? 1 : 0) + (c.revenueEstimate !== null ? 1 : 0);

  const byKey = new Map<string, Candidate>();
  for (const r of rows) {
    const hour = (r.hour ?? "").toLowerCase();
    // A blank/unrecognised hour is "unknown", not a reason to drop the
    // row — ARM 2026-11-04 vanished from the screen that way.
    const timing: EarningsCalendarItem["timing"] =
      hour === "bmo" ? "BMO" : hour === "amc" ? "AMC" : hour === "dmh" ? "DMH" : "unknown";

    const candidate: Candidate = {
      symbol: r.symbol,
      date: r.date,
      timing,
      estimatedEPS: r.epsEstimate ?? null,
      actualEPS: r.epsActual ?? null,
      revenueEstimate: r.revenueEstimate ?? null,
      quarter: r.quarter ?? null,
      year: r.year ?? null,
    };
    const key = `${candidate.symbol}|${candidate.date}|${candidate.timing}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, candidate);
      continue;
    }

    const kept = completeness(candidate) > completeness(existing) ? candidate : existing;
    const dropped = kept === candidate ? existing : candidate;
    console.info(
      `[earnings] duplicate calendar row collapsed: ${kept.symbol} ${kept.date} ${kept.timing} — ` +
        `kept fiscal Q${kept.quarter ?? "?"}/${kept.year ?? "?"} ` +
        `(epsEstimate=${kept.estimatedEPS ?? "null"}, revenueEstimate=${kept.revenueEstimate ?? "null"}), ` +
        `dropped fiscal Q${dropped.quarter ?? "?"}/${dropped.year ?? "?"} ` +
        `(epsEstimate=${dropped.estimatedEPS ?? "null"}, revenueEstimate=${dropped.revenueEstimate ?? "null"})`,
    );
    byKey.set(key, kept);
  }

  // An unknown-timing row is redundant next to a timed row for the same
  // symbol+date (the key includes timing, so both would survive).
  const timed = new Set(
    Array.from(byKey.values())
      .filter((c) => c.timing !== "unknown")
      .map((c) => `${c.symbol}|${c.date}`),
  );
  return Array.from(byKey.values())
    .filter((c) => c.timing !== "unknown" || !timed.has(`${c.symbol}|${c.date}`))
    .map((c) => ({
    symbol: c.symbol,
    date: c.date,
    timing: c.timing,
    estimatedEPS: c.estimatedEPS,
    actualEPS: c.actualEPS,
  }));
}

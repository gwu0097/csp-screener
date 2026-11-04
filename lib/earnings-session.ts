// Short earnings-timing label shown next to the symbol on the screener
// (replaces the Earnings column). Pure — tested in
// lib/earnings-session.test.ts.
//
// A daily screen mixes "today AMC" and "tomorrow BMO" rows, which react
// in the SAME session, so a bare "AMC"/"BMO" is unambiguous for them.
// Only a row whose reaction session differs from the screen's most
// common one gets a weekday prefix ("Thu AMC").

export type Timing = "BMO" | "AMC";

function dayNumber(iso: string): number {
  return Math.round(Date.parse(iso.slice(0, 10) + "T00:00:00Z") / 86400000);
}

// 1970-01-01 (day 0) was a Thursday: weekday index 0=Sun..6=Sat.
function weekday(day: number): number {
  return (((day + 4) % 7) + 7) % 7;
}

// The trading session the market first reacts in: the print day for
// BMO, the next weekday for AMC (Friday AMC → Monday). Holidays are not
// modelled; a holiday only shifts the label, never the data.
export function reactionSession(earningsDate: string, timing: Timing): number {
  let d = dayNumber(earningsDate);
  if (timing === "AMC") {
    d += 1;
    while (weekday(d) === 0 || weekday(d) === 6) d += 1;
  }
  return d;
}

// Most common reaction session across the screen; ties go to the
// earliest (the nearer event is the one being traded first).
export function dominantSession(rows: ReadonlyArray<{ earningsDate: string; earningsTiming: Timing }>): number | null {
  const counts = new Map<number, number>();
  for (const r of rows) {
    const s = reactionSession(r.earningsDate, r.earningsTiming);
    counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  let best: { s: number; n: number } | null = null;
  for (const [s, n] of Array.from(counts.entries())) {
    if (!best || n > best.n || (n === best.n && s < best.s)) best = { s, n };
  }
  return best ? best.s : null;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function timingLabel(earningsDate: string, timing: Timing, dominant: number | null): string {
  if (dominant === null || reactionSession(earningsDate, timing) === dominant) return timing;
  return `${WEEKDAYS[weekday(dayNumber(earningsDate))]} ${timing}`;
}

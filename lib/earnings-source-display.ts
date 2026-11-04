// Display rules for Screen Today's calendar-source check: the status
// line above the table and the "which source is right?" sheet's
// buttons. Pure (type-only imports) so it is unit-tested.
import type { CalTiming, EarningsSourceCheck, ScreenTiming } from "./earnings-source-merge.ts";

export type StatusLine = { tone: "ok" | "amber"; text: string };

/** One line for the whole screen, derived from the rows' checks so a
 * reloaded saved run shows the same line. Null for runs saved before the
 * merge existed (no checks at all). */
export function calendarStatusLine(
  checks: Array<EarningsSourceCheck | undefined>,
  fmtTime: (iso: string) => string,
  finnhubError?: string | null,
): StatusLine | null {
  if (finnhubError) return { tone: "amber", text: "Finnhub calendar failed — results are Robinhood-only" };
  const present = checks.filter((c): c is EarningsSourceCheck => !!c);
  if (present.length === 0) return null;
  const fetchedAt = present.map((c) => c.rhFetchedAt).find((t): t is string => !!t) ?? null;
  if (present.some((c) => c.kind === "robinhood_unavailable")) {
    return {
      tone: "amber",
      text: fetchedAt
        ? `Robinhood calendar unavailable since ${fmtTime(fetchedAt)} — results are Finnhub-only`
        : "Robinhood calendar unavailable — results are Finnhub-only",
    };
  }
  return fetchedAt ? { tone: "ok", text: `Robinhood calendar from ${fmtTime(fetchedAt)}` } : null;
}

export function timingWords(t: CalTiming): string {
  return t === "BMO" ? "before open" : t === "AMC" ? "after close" : t === "DMH" ? "during market hours" : "time not given";
}

export type ChoiceOption = {
  label: string;
  chosenSource: "finnhub" | "robinhood";
  chosenDate: string;
  chosenTiming: ScreenTiming;
};

/** Buttons for the sheet. A side with a known BMO/AMC gets one "Use X"
 * button; a side with no time gets one per timing (the user supplies
 * it); a DMH side gets none (it can't be traded as an overnight print). */
export function choiceOptions(check: EarningsSourceCheck): ChoiceOption[] {
  const out: ChoiceOption[] = [];
  const add = (source: "finnhub" | "robinhood", name: string, side: { date: string; timing: CalTiming } | null) => {
    if (!side) return;
    if (side.timing === "BMO" || side.timing === "AMC") {
      out.push({ label: `Use ${name}`, chosenSource: source, chosenDate: side.date, chosenTiming: side.timing });
    } else if (side.timing === "unknown") {
      for (const t of ["AMC", "BMO"] as const) {
        out.push({ label: `${name} date, ${t}`, chosenSource: source, chosenDate: side.date, chosenTiming: t });
      }
    }
  };
  add("robinhood", "Robinhood", check.robinhood);
  add("finnhub", "Finnhub", check.finnhub);
  // Both sides showing the same date with no time would offer the same
  // two buttons twice — keep the first of each date+timing.
  const seen = new Set<string>();
  return out.filter((o) => {
    const k = `${o.chosenDate}|${o.chosenTiming}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

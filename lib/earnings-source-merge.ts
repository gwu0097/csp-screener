// Screen Today's two-calendar merge: Finnhub's earnings calendar ∪ the
// latest Robinhood batch (scripts/robinhood-earnings-courier.ts). Pure —
// no I/O, so every rule below is unit-tested (earnings-source-merge.test.ts).
//
// Why two sources: on 2026-11-04 Finnhub listed ARM on 11-05 with a
// blank hour while Robinhood had 11-04 "pm", verified — Finnhub alone
// dropped ARM twice over (wrong day, and blank-hour rows were filtered
// out silently). Either source can now put a symbol into the window;
// every candidate still goes through the screen's normal filters, and
// each carries a `check` saying how the sources compare so the user
// can see and resolve disagreements.
//
// Window: today AMC or tomorrow BMO (US Eastern). A row with unknown
// timing dated today or tomorrow is INCLUDED and flagged, never
// guessed out: the only reading under which it is actionable is
// today→AMC / tomorrow→BMO, so that is its provisional timing
// (`timingProvisional: true`). Expiry selection depends on the date
// only (lib/screener.ts buildCandidateFromEarnings), so the provisional
// timing never changes which contract is screened.

export type CalTiming = "BMO" | "AMC" | "DMH" | "unknown";
export type ScreenTiming = "BMO" | "AMC";

export type FinnhubCalRow = { symbol: string; date: string; timing: CalTiming };
export type RhRowInput = { symbol: string; reportDate: string; timing: "am" | "pm" | null; verified: boolean };
export type RhBatchInput = { fetchedAt: string; windowStart: string; windowEnd: string; rows: RhRowInput[] };
export type SourceChoice = {
  symbol: string;
  conflictKey: string;
  chosenSource: "finnhub" | "robinhood" | "user";
  chosenDate: string;
  chosenTiming: ScreenTiming;
};

export type SourceCheckKind =
  | "agree"
  | "dates_disagree"
  | "robinhood_only"
  | "timing_from_robinhood"
  | "timing_unknown"
  // Finnhub lists it, a fresh Robinhood batch doesn't. Normal for small
  // caps (Robinhood's high_market_cap filter is mcap > $1B), so it is
  // not flagged — but it is not "agree" either: nothing confirmed it.
  | "finnhub_only"
  // Batch missing, stale (> RH_STALE_HOURS) or not covering tomorrow.
  // Never reported as "agree".
  | "robinhood_unavailable";

export type SourceSide = { date: string; timing: CalTiming };
export type EarningsSourceCheck = {
  kind: SourceCheckKind;
  finnhub: SourceSide | null;
  robinhood: (SourceSide & { verified: boolean }) | null;
  /** Stable key for this exact disagreement; a saved choice applies only while it matches. */
  conflictKey: string;
  /** Which source the screened date/timing came from. */
  resolvedSource: "finnhub" | "robinhood" | "user";
  /** Timing was unknown and is assumed from the window (today→AMC, tomorrow→BMO). */
  timingProvisional: boolean;
  rhFetchedAt: string | null;
};

export type MergedCandidate = { symbol: string; date: string; timing: ScreenTiming; check: EarningsSourceCheck };

export const RH_STALE_HOURS = 30;

export function rhTimingToCal(t: "am" | "pm" | null): CalTiming {
  return t === "am" ? "BMO" : t === "pm" ? "AMC" : "unknown";
}

export function conflictKey(f: SourceSide | null, r: SourceSide | null): string {
  const side = (s: SourceSide | null) => (s ? `${s.date}:${s.timing}` : "-");
  return `F=${side(f)}|R=${side(r)}`;
}

export type RhAvailability = { available: true } | { available: false; reason: string };

export function rhBatchAvailability(
  batch: RhBatchInput | null,
  now: Date,
  today: string,
  tomorrow: string,
): RhAvailability {
  if (!batch) return { available: false, reason: "no Robinhood calendar stored yet" };
  const ageH = (now.getTime() - new Date(batch.fetchedAt).getTime()) / 3_600_000;
  if (!Number.isFinite(ageH) || ageH > RH_STALE_HOURS) {
    return { available: false, reason: `latest Robinhood calendar is ${Math.round(ageH)}h old` };
  }
  if (batch.windowStart > today || batch.windowEnd < tomorrow) {
    return { available: false, reason: `latest Robinhood calendar covers ${batch.windowStart}..${batch.windowEnd}, not ${today}..${tomorrow}` };
  }
  return { available: true };
}

type Window = { today: string; tomorrow: string };

function isDefinite(s: SourceSide, w: Window): boolean {
  return (s.date === w.today && s.timing === "AMC") || (s.date === w.tomorrow && s.timing === "BMO");
}
function isPossible(s: SourceSide, w: Window): boolean {
  return s.timing === "unknown" && (s.date === w.today || s.date === w.tomorrow);
}
function rank(s: SourceSide | null, w: Window): number {
  if (!s) return 0;
  return isDefinite(s, w) ? 2 : isPossible(s, w) ? 1 : 0;
}
function screenTiming(s: SourceSide, w: Window): { timing: ScreenTiming; provisional: boolean } | null {
  if (isDefinite(s, w)) return { timing: s.timing as ScreenTiming, provisional: false };
  if (isPossible(s, w)) return { timing: s.date === w.today ? "AMC" : "BMO", provisional: true };
  return null;
}
/** One row per symbol and source: the most actionable, then the earliest. */
function pickBest<T extends SourceSide>(rows: T[], w: Window): T | null {
  let best: T | null = null;
  for (const r of rows) {
    if (!best || rank(r, w) > rank(best, w) || (rank(r, w) === rank(best, w) && r.date < best.date)) best = r;
  }
  return best;
}

export function mergeEarningsSources(input: {
  finnhub: FinnhubCalRow[];
  robinhood: RhBatchInput | null;
  choices: SourceChoice[];
  today: string;
  tomorrow: string;
  now: Date;
}): MergedCandidate[] {
  const w: Window = { today: input.today, tomorrow: input.tomorrow };
  const rhOk = rhBatchAvailability(input.robinhood, input.now, w.today, w.tomorrow).available;
  const batch = rhOk ? input.robinhood : null;
  const rhFetchedAt = input.robinhood?.fetchedAt ?? null;

  const fBy = new Map<string, SourceSide[]>();
  for (const r of input.finnhub) {
    const sym = r.symbol.toUpperCase();
    fBy.set(sym, [...(fBy.get(sym) ?? []), { date: r.date, timing: r.timing }]);
  }
  const rBy = new Map<string, Array<SourceSide & { verified: boolean }>>();
  for (const r of batch?.rows ?? []) {
    const sym = r.symbol.toUpperCase();
    rBy.set(sym, [...(rBy.get(sym) ?? []), { date: r.reportDate, timing: rhTimingToCal(r.timing), verified: r.verified }]);
  }
  const choiceBy = new Map(input.choices.map((c) => [`${c.symbol.toUpperCase()}|${c.conflictKey}`, c]));

  const out: MergedCandidate[] = [];
  for (const symbol of Array.from(new Set(Array.from(fBy.keys()).concat(Array.from(rBy.keys()))))) {
    const f = pickBest(fBy.get(symbol) ?? [], w);
    const r = pickBest(rBy.get(symbol) ?? [], w);
    // Neither source can put it in the window → not a candidate.
    if (rank(f, w) === 0 && rank(r, w) === 0) continue;

    let kind: SourceCheckKind;
    if (!batch) kind = "robinhood_unavailable";
    else if (f && r) {
      if (f.date !== r.date) kind = "dates_disagree";
      else if (f.timing === "unknown" && r.timing === "unknown") kind = "timing_unknown";
      else if (f.timing === "unknown") kind = "timing_from_robinhood";
      else if (r.timing === "unknown" || r.timing === f.timing) kind = "agree";
      else kind = "dates_disagree"; // same day, BMO vs AMC
    } else if (r) kind = "robinhood_only";
    else {
      // f only. A Finnhub date outside the batch's window isn't evidence
      // Robinhood lacks it, but rank>0 means today/tomorrow, which a
      // usable batch always covers.
      kind = f!.timing === "unknown" ? "timing_unknown" : "finnhub_only";
    }

    const key = conflictKey(f, r);
    const choice = choiceBy.get(`${symbol}|${key}`);

    let side: SourceSide | null;
    let resolvedSource: EarningsSourceCheck["resolvedSource"];
    if (choice) {
      side = { date: choice.chosenDate, timing: choice.chosenTiming };
      resolvedSource = "user";
    } else if (kind === "timing_from_robinhood") {
      side = r;
      resolvedSource = "robinhood";
    } else if (f && r && kind === "dates_disagree") {
      // The more actionable side wins; a tie goes to Robinhood when it
      // marks the date verified by the company, else to Finnhub (the
      // screen's long-standing source).
      const rf = rank(f, w);
      const rr = rank(r, w);
      const useRh = rr > rf || (rr === rf && r.verified);
      side = useRh ? r : f;
      resolvedSource = useRh ? "robinhood" : "finnhub";
    } else if (f) {
      side = f;
      resolvedSource = "finnhub";
    } else {
      side = r;
      resolvedSource = "robinhood";
    }

    const st = side ? screenTiming(side, w) : null;
    if (!side || !st) continue; // the chosen/resolved reading is outside the window (e.g. DMH)
    out.push({
      symbol,
      date: side.date,
      timing: st.timing,
      check: {
        kind,
        finnhub: f,
        robinhood: r,
        conflictKey: key,
        resolvedSource,
        timingProvisional: st.provisional,
        rhFetchedAt,
      },
    });
  }
  return out.sort((a, b) => a.symbol.localeCompare(b.symbol));
}

/** The chip shown next to the AMC/BMO label, or null for none. */
export function sourceCheckChip(check: EarningsSourceCheck | undefined | null): { label: string; tone: "amber" | "muted" } | null {
  if (!check) return null;
  if (check.resolvedSource === "user") return { label: "Your pick", tone: "muted" };
  if (check.kind === "dates_disagree") {
    const sameDay = check.finnhub && check.robinhood && check.finnhub.date === check.robinhood.date;
    return { label: sameDay ? "Timing differs" : "Dates differ", tone: "amber" };
  }
  if (check.kind === "robinhood_only") return { label: "RH only", tone: "amber" };
  if (check.timingProvisional) return { label: "Timing?", tone: "amber" };
  if (check.kind === "timing_from_robinhood") return { label: "RH timing", tone: "muted" };
  return null;
}

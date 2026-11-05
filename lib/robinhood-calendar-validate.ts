// Validation for the Robinhood earnings-calendar batch the local
// courier (scripts/robinhood-earnings-courier.ts) POSTs to
// app/api/robinhood-calendar/ingest. Pure: no I/O, so the courier's
// --dry-run and the server route run the exact same checks.
//
// The payload is an LLM's transcription of the MCP tool result, so the
// whole batch is rejected on ANY defect rather than keeping the good
// rows: a partly garbled transcription can't be told apart from a
// partly truncated one, and a silently short calendar would make
// Screen Today report "Robinhood doesn't list X" when it does.
//
// Expected shape (the courier's prompt asks for exactly this):
//   {"count": <data.results.length>, "rows": [["ARM","2026-11-04","pm",true], ...]}
//
// Self-contained on purpose: `node --test` needs a ".ts" extension on a
// value import and tsc (no allowImportingTsExtensions) rejects one, so
// a pure tested module can't value-import a sibling. These two mirror
// SYMBOL_RE / isIsoDate in lib/traded-status.ts — keep them identical.
export const SYMBOL_RE = /^[A-Z][A-Z0-9.-]{0,9}$/;
export function isIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = Date.parse(s + "T00:00:00Z");
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s;
}

export type RhTiming = "am" | "pm" | null;
export type RhCalendarRow = { symbol: string; reportDate: string; timing: RhTiming; verified: boolean };

export function addDaysIso(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Days after today the window reaches: today AMC / tomorrow BMO, plus a
 * spare day for a run straddling midnight ET. */
export const RH_WINDOW_AHEAD_DAYS = 2;

/**
 * The courier's window for an ET date: from the previous weekday through
 * today+2. The look-back is what lets the screen see that a company
 * already reported: on 2026-11-05 Finnhub still listed ARM for 11-05
 * (blank hour) a day after it reported on 11-04 pm, and a window
 * starting today had no Robinhood row to contradict it. Monday looks
 * back to Friday. `days` is the tool's inclusive length from `start`
 * (verified 2026-11-04: start 11-04, days=3 → rows dated 11-04..11-06).
 */
export function courierWindow(today: string): { start: string; end: string; days: number } {
  const dow = new Date(today + "T12:00:00Z").getUTCDay(); // 0 Sun … 6 Sat
  const back = dow === 1 ? 3 : dow === 0 ? 2 : 1;
  const start = addDaysIso(today, -back);
  const end = addDaysIso(today, RH_WINDOW_AHEAD_DAYS);
  return { start, end, days: back + RH_WINDOW_AHEAD_DAYS + 1 };
}

// Sanity floor. Real data rules out a fixed minimum: the in-season
// window 2026-11-04 +3d returned 695 rows (320/323/52 per day), but the
// holiday window 2026-12-28 +3d returned 1 and 2025-12-29 +3d returned
// 0, and the tool's own guide says an empty result is "not an error".
// Any fixed floor above 0 would reject a real quiet week. What a
// truncated or lazy transcription looks like instead is a sharp DROP
// against the previous batch for the same report dates — companies
// don't un-schedule en masse overnight. So the floor is half of what
// the previous batch (if any) listed for the dates both windows cover.
// count != rows.length is the other truncation detector.
export const FLOOR_RATIO_OF_PREVIOUS = 0.5;
// Below this many previous rows the ratio means nothing: one company
// rescheduling out of a 1-row holiday window is a 100% "drop". In-season
// overlaps run in the hundreds, so truncation is still caught there.
export const FLOOR_MIN_PREVIOUS_OVERLAP = 20;

export function minRowsFloor(previousOverlapCount: number | null): number {
  if (previousOverlapCount === null || previousOverlapCount < FLOOR_MIN_PREVIOUS_OVERLAP) return 0;
  return Math.ceil(previousOverlapCount * FLOOR_RATIO_OF_PREVIOUS);
}

export type ValidateResult =
  | { ok: true; rows: RhCalendarRow[]; reportedCount: number; duplicatesCollapsed: number }
  | { ok: false; error: string };

/** Minimum rows required on report dates [start, end] — the dates the
 * previous batch also covered. See minRowsFloor. */
export type RowsFloor = { start: string; end: string; min: number };

/**
 * Validates the compact payload. `floor` comes from the previous batch
 * (the route computes it); omit it to skip the floor (dry run, or no
 * previous batch).
 */
export function validateRobinhoodCalendarPayload(
  raw: unknown,
  window: { start: string; end: string },
  floor: RowsFloor | null = null,
): ValidateResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "payload is not a JSON object" };
  }
  const obj = raw as Record<string, unknown>;
  const keys = Object.keys(obj).sort().join(",");
  if (keys !== "count,rows") return { ok: false, error: `unexpected keys: ${keys || "(none)"}` };
  const { count, rows } = obj;
  if (typeof count !== "number" || !Number.isInteger(count) || count < 0) {
    return { ok: false, error: "count is not a non-negative integer" };
  }
  if (!Array.isArray(rows)) return { ok: false, error: "rows is not an array" };
  if (count !== rows.length) {
    return { ok: false, error: `count ${count} != rows.length ${rows.length} — transcription incomplete` };
  }

  const out = new Map<string, RhCalendarRow>();
  let duplicates = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!Array.isArray(r) || r.length !== 4) return { ok: false, error: `row ${i}: expected [symbol, date, timing, verified]` };
    const [symbol, date, timing, verified] = r as unknown[];
    if (typeof symbol !== "string" || !SYMBOL_RE.test(symbol)) return { ok: false, error: `row ${i}: bad symbol ${JSON.stringify(symbol)}` };
    if (typeof date !== "string" || !isIsoDate(date)) return { ok: false, error: `row ${i} (${symbol}): bad date ${JSON.stringify(date)}` };
    if (date < window.start || date > window.end) {
      return { ok: false, error: `row ${i} (${symbol}): date ${date} outside window ${window.start}..${window.end}` };
    }
    if (timing !== "am" && timing !== "pm" && timing !== null) {
      return { ok: false, error: `row ${i} (${symbol}): bad timing ${JSON.stringify(timing)}` };
    }
    if (typeof verified !== "boolean") return { ok: false, error: `row ${i} (${symbol}): verified is not a boolean` };

    // Robinhood repeats some events verbatim (AMCR, NHP, TGLS… twice in
    // the 2026-11-04 sample). One row per symbol+date; on a conflicting
    // repeat keep the verified, then the timed, one. Two equally-ranked
    // rows that disagree on am/pm are Robinhood contradicting itself:
    // store timing null so Screen Today flags it, never pick by position.
    const key = `${symbol}|${date}`;
    const row: RhCalendarRow = { symbol, reportDate: date, timing, verified };
    const prev = out.get(key);
    if (prev) {
      duplicates++;
      const score = (x: RhCalendarRow) => (x.verified ? 2 : 0) + (x.timing ? 1 : 0);
      if (score(row) > score(prev)) out.set(key, row);
      else if (score(row) === score(prev) && row.timing !== prev.timing) out.set(key, { ...prev, timing: null });
      continue;
    }
    out.set(key, row);
  }

  const deduped = Array.from(out.values());
  if (floor && floor.min > 0) {
    const n = deduped.filter((r) => r.reportDate >= floor.start && r.reportDate <= floor.end).length;
    if (n < floor.min) {
      return {
        ok: false,
        error: `only ${n} rows for ${floor.start}..${floor.end}, below the sanity floor of ${floor.min} (half the previous batch for those dates)`,
      };
    }
  }
  return { ok: true, rows: deduped, reportedCount: count, duplicatesCollapsed: duplicates };
}

// ---- Source-choice request body (app/api/screener/earnings-source) ----
// The user's answer to a flagged row. Validated against the conflict
// key it answers (lib/earnings-source-merge.ts conflictKey format
// "F=<date>:<timing>|R=<date>:<timing>", "-" for a missing side) so a
// "Use Robinhood" can only pick the date Robinhood actually showed.

export type ParsedSourceChoice = {
  symbol: string;
  conflictKey: string;
  chosenSource: "finnhub" | "robinhood" | "user";
  chosenDate: string;
  chosenTiming: "BMO" | "AMC";
};

const SIDE_RE = /^(-|(\d{4}-\d{2}-\d{2}):(BMO|AMC|DMH|unknown))$/;

function parseSide(s: string): { date: string; timing: string } | null | undefined {
  const m = SIDE_RE.exec(s);
  if (!m) return undefined; // malformed
  if (m[1] === "-") return null; // side absent
  return isIsoDate(m[2]) ? { date: m[2], timing: m[3] } : undefined;
}

export function parseSourceChoice(body: unknown): ParsedSourceChoice | { error: string } {
  if (!body || typeof body !== "object") return { error: "body must be an object" };
  const b = body as Record<string, unknown>;
  const symbol = typeof b.symbol === "string" ? b.symbol.trim().toUpperCase() : "";
  if (!SYMBOL_RE.test(symbol)) return { error: "bad symbol" };
  const conflictKey = typeof b.conflictKey === "string" ? b.conflictKey : "";
  const parts = /^F=([^|]+)\|R=([^|]+)$/.exec(conflictKey);
  const f = parts ? parseSide(parts[1]) : undefined;
  const r = parts ? parseSide(parts[2]) : undefined;
  if (f === undefined || r === undefined) return { error: "bad conflictKey" };
  const chosenSource = b.chosenSource;
  if (chosenSource !== "finnhub" && chosenSource !== "robinhood" && chosenSource !== "user") return { error: "bad chosenSource" };
  const chosenDate = typeof b.chosenDate === "string" ? b.chosenDate : "";
  if (!isIsoDate(chosenDate)) return { error: "bad chosenDate" };
  const chosenTiming = b.chosenTiming;
  if (chosenTiming !== "BMO" && chosenTiming !== "AMC") return { error: "chosenTiming must be BMO or AMC" };

  // A named source must match what that source showed; its timing may
  // only be filled in by the user when the source had none.
  if (chosenSource !== "user") {
    const side = chosenSource === "finnhub" ? f : r;
    if (!side) return { error: `${chosenSource} has no date for this conflict` };
    if (side.date !== chosenDate) return { error: `${chosenSource} showed ${side.date}, not ${chosenDate}` };
    if (side.timing !== "unknown" && side.timing !== chosenTiming) {
      return { error: `${chosenSource} showed ${side.timing}, not ${chosenTiming}` };
    }
  } else {
    // "user" = only the timing was unknown; the date must be one a source showed.
    const dates = [f?.date, r?.date].filter(Boolean);
    if (!dates.includes(chosenDate)) return { error: "chosenDate must be a date one of the sources showed" };
  }
  return { symbol, conflictKey, chosenSource, chosenDate, chosenTiming };
}

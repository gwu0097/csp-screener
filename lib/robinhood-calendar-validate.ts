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

export const RH_WINDOW_DAYS = 3;

export function addDaysIso(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Last date covered by the tool's window: days=3 from D covers D, D+1, D+2
 * (verified 2026-11-04: rows dated 11-04, 11-05, 11-06 only). */
export function windowEndFor(windowStart: string, days = RH_WINDOW_DAYS): string {
  return addDaysIso(windowStart, days - 1);
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

export function minRowsFloor(previousOverlapCount: number | null): number {
  if (previousOverlapCount === null || previousOverlapCount <= 0) return 0;
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
    // repeat keep the verified, then the timed, one.
    const key = `${symbol}|${date}`;
    const row: RhCalendarRow = { symbol, reportDate: date, timing, verified };
    const prev = out.get(key);
    if (prev) {
      duplicates++;
      const score = (x: RhCalendarRow) => (x.verified ? 2 : 0) + (x.timing ? 1 : 0);
      if (score(row) > score(prev)) out.set(key, row);
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

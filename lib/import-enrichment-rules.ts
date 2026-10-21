// Pure rules for deferred post-import enrichment (lib/import-enrichment.ts).
// No I/O — tested in lib/import-enrichment-rules.test.ts.

// How far back the deferred stamper looks for never-stamped positions.
// Bounds the sweep so it can't wander into history (older unstamped rows
// are pre-existing gaps, not unfinished import work).
export const STAMP_LOOKBACK_DAYS = 7;

// Stamps per enrich request. Each is a VIX/earnings context (shared) plus
// one quote snapshot and one options chain fetch.
export const STAMPS_PER_REQUEST = 3;

export function stampCandidateCutoff(todayIso: string, lookbackDays = STAMP_LOOKBACK_DAYS): string {
  const ms = new Date(`${todayIso}T00:00:00Z`).getTime() - lookbackDays * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

export type StampCandidate = { id: string; symbol: string; expiry: string; opened_date: string };

// A position with expiry before its open date never gets entry_dte
// written (stampEntryContext skips a negative DTE), so it would look
// unstamped forever — excluded, or every run would re-fetch its chain.
export function pickStampBatch<T extends StampCandidate>(
  candidates: T[],
  limit: number,
): { batch: T[]; remaining: number } {
  const eligible = candidates.filter((c) => c.expiry >= c.opened_date);
  const batch = eligible.slice(0, Math.max(0, limit));
  return { batch, remaining: eligible.length - batch.length };
}

// Max enrich calls per symbol / for the leftover sweep in one trigger
// run. Bounds the loop if `remaining` never drains (a stamp that keeps
// failing to write entry_dte); leftovers wait for the next run.
export const MAX_ENRICH_CALLS_PER_TARGET = 5;

// Symbols named by the poll reports, deduped, in first-seen order.
export function symbolsToEnrich(reports: Array<{ enrichSymbols?: string[] }>): string[] {
  const out: string[] = [];
  for (const r of reports) for (const s of r.enrichSymbols ?? []) if (!out.includes(s)) out.push(s);
  return out;
}

// Close snapshots per enrich request — each is one options-chain fetch
// (~2-5s). A close-only day can have 20+ closes (2026-08-07: 21), which
// unbounded would put the enrich request itself over 60s.
export const CLOSE_SNAPSHOTS_PER_REQUEST = 4;

// Closed positions still missing today's close snapshot, capped.
export function pickCloseBatch(
  closedIds: string[],
  haveSnapshot: ReadonlySet<string>,
  limit: number,
): { batch: string[]; remaining: number } {
  const missing = closedIds.filter((id) => !haveSnapshot.has(id));
  const batch = missing.slice(0, Math.max(0, limit));
  return { batch, remaining: missing.length - batch.length };
}

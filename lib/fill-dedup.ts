// Cross-batch duplicate check for one incoming option fill against the
// fills already stored on its matched position. Pure — no I/O — so the
// rule is unit-testable (lib/fill-dedup.test.ts).
import type { Fill } from "./positions.ts";

export type FillDedupInput = {
  action: "open" | "close";
  contracts: number;
  premium: number;
  externalId?: string;
};

// "duplicate_by_id": the broker's own id for this execution is already
//   stored — the same fill delivered again (e.g. a poll that timed out
//   after inserting but before marking its rows processed, then re-ran).
//   It is already counted in the position, so the caller must skip it
//   entirely: running it through the over-close guard would count the
//   close twice and report a false overage (ISRG $365P, 2026-10-21).
// "duplicate_fuzzy": no broker id, but an identical fill (action,
//   contracts, premium, date) exists — a warning the user may confirm
//   past, since a screenshot re-import can be deliberate. Still
//   validated normally.
// "new": proven separate (id differs) or no economic match.
export type FillDedupVerdict = "duplicate_by_id" | "duplicate_fuzzy" | "new";

export function classifyIncomingFill(
  input: FillDedupInput,
  fillDate: string,
  existing: Fill[],
): FillDedupVerdict {
  // A broker-supplied id is the only signal trusted when present: an
  // exact match is a real duplicate, no match is a separate execution
  // regardless of matching terms.
  if (input.externalId) {
    return existing.some((f) => f.external_id === input.externalId) ? "duplicate_by_id" : "new";
  }
  const fuzzy = existing.some(
    (f) =>
      f.fill_type === input.action &&
      Number(f.contracts) === Number(input.contracts) &&
      Math.abs(Number(f.premium) - Number(input.premium)) < 0.005 &&
      f.fill_date === fillDate,
  );
  return fuzzy ? "duplicate_fuzzy" : "new";
}

// Splits auto-import submissions into those whose broker id is already
// stored on a fill (skip — finished work from an earlier run) and the
// rest. Lets the importer drop re-delivered rows before bulk-create, so
// one leftover from a timed-out run can't fail the whole batch and
// force the slow one-by-one retry for every other row.
export function partitionByRecordedExternalId<T extends { input: { externalId?: string } }>(
  items: T[],
  recordedIds: ReadonlySet<string>,
): { recorded: T[]; fresh: T[] } {
  const recorded: T[] = [];
  const fresh: T[] = [];
  for (const item of items) {
    const id = item.input.externalId;
    (id && recordedIds.has(id) ? recorded : fresh).push(item);
  }
  return { recorded, fresh };
}

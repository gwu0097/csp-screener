// Shared types + pure classification logic for the observation dictionary
// (research analysis template v4's CANDIDATE_OBSERVATIONS block). Used by
// both the paste-back client (live preview, before save) and the
// research-analysis POST route (authoritative validation, on save) so the
// two never drift — the server re-runs this against its own dictionary
// read rather than trusting the client's classification.

export type ObservationKind = "setup_observation" | "app_defect";

export type ObservationDictionaryEntry = {
  term: string;
  definition: string;
  kind: ObservationKind;
  use_count: number;
  first_used_at: string | null;
  last_used_at: string | null;
  aliases: string[];
  created_at: string;
  updated_at: string;
};

export type ObservationUsage = {
  term: string;
  symbol: string;
  earnings_date: string;
  created_at: string;
};

// A single CANDIDATE_OBSERVATIONS entry as lifted off the page by the
// parser: `definition` is null for a bare reference to an already-known
// term (no re-definition on the line), non-null for a first-use or a
// redefinition.
export type ParsedCandidateObservation = {
  term: string;
  definition: string | null;
};

export type ObservationClassification =
  | { status: "new_with_definition"; term: string; definition: string }
  | { status: "new_missing_definition"; term: string }
  | { status: "existing_reused"; term: string; definition: string }
  | { status: "existing_redefined"; term: string; priorDefinition: string; newDefinition: string };

// User's (or, server-side, the caller's) choices for the ambiguous cases
// classification alone can't resolve: a brand-new term needs a kind
// (setup_observation vs app_defect) since the response format has no
// field for it, and a redefined term needs the user to pick which
// definition wins.
export type ObservationResolutions = {
  newTermKinds: Record<string, ObservationKind>;
  useNewDefinitionFor: string[];
};

function normalizeDefinition(def: string): string {
  return def.trim().replace(/\s+/g, " ");
}

export function buildDictionaryMap(
  entries: ObservationDictionaryEntry[],
): Map<string, ObservationDictionaryEntry> {
  return new Map(entries.map((e) => [e.term, e]));
}

// Pure — no I/O. Classifies each parsed observation against the current
// dictionary state passed in by the caller.
export function classifyObservations(
  observations: ParsedCandidateObservation[],
  dictionary: Map<string, ObservationDictionaryEntry>,
): ObservationClassification[] {
  return observations.map((obs) => {
    const existing = dictionary.get(obs.term);
    if (!existing) {
      if (obs.definition === null) {
        return { status: "new_missing_definition", term: obs.term };
      }
      return { status: "new_with_definition", term: obs.term, definition: obs.definition };
    }
    if (obs.definition === null) {
      return { status: "existing_reused", term: obs.term, definition: existing.definition };
    }
    if (normalizeDefinition(obs.definition) === normalizeDefinition(existing.definition)) {
      return { status: "existing_reused", term: obs.term, definition: existing.definition };
    }
    return {
      status: "existing_redefined",
      term: obs.term,
      priorDefinition: existing.definition,
      newDefinition: obs.definition,
    };
  });
}

// Authoritative gate: can this set of classifications be saved given the
// resolutions supplied? Both the client (to decide whether Save is
// enabled) and the server (to decide whether to accept the POST) call
// this against the same inputs.
export function validateObservationResolutions(
  classifications: ObservationClassification[],
  resolutions: ObservationResolutions,
): { ok: true } | { ok: false; error: string } {
  const missingDefinition = classifications.filter((c) => c.status === "new_missing_definition");
  if (missingDefinition.length > 0) {
    return {
      ok: false,
      error: `New term(s) used without a definition: ${missingDefinition
        .map((c) => c.term)
        .join(", ")}. Definitions are required on first use.`,
    };
  }
  const missingKind = classifications.filter(
    (c) => c.status === "new_with_definition" && !resolutions.newTermKinds[c.term],
  );
  if (missingKind.length > 0) {
    return {
      ok: false,
      error: `New term(s) need a kind (setup observation or app defect) before saving: ${missingKind
        .map((c) => c.term)
        .join(", ")}.`,
    };
  }
  return { ok: true };
}

// Phase B — dictionary injected into the dump so an analyst reuses terms
// instead of re-coining synonyms. At ~240 analyses/year the table grows
// past what's useful to inject every time, so a term only makes the cut
// if it's either well-established (use_count) or recent (last_used_at) —
// one-off terms stay in the dictionary for browsing/search but drop out
// of the prompt. Both thresholds are named constants, not inlined, since
// the injection call site (components/screener-view.tsx) may want to
// override them (see the VALIDATION checklist's threshold test).
export const DICTIONARY_INJECTION_MIN_USE_COUNT = 2;
export const DICTIONARY_INJECTION_RECENCY_DAYS = 90;

const KIND_LABELS: Record<ObservationKind, string> = {
  setup_observation: "Setup Observations",
  app_defect: "App Defects",
};

// Pure — no I/O, no Date.now() side effects unless `now` is omitted.
// Filters entries by the use_count/recency threshold, groups by kind
// (matching the Dictionary tab's two labeled sections), sorts each group
// by use_count descending then term alphabetically, and renders
// `term: definition` lines plus a header reporting how many terms made
// the cut. Returned as an array of dump lines (not a joined string) so
// the caller can push them through the same line-array builder every
// other dump section uses.
export function buildDictionaryInjectionSection(
  entries: ObservationDictionaryEntry[],
  opts?: { minUseCount?: number; recencyDays?: number; now?: number },
): { lines: string[]; includedCount: number; totalCount: number } {
  const minUseCount = opts?.minUseCount ?? DICTIONARY_INJECTION_MIN_USE_COUNT;
  const recencyDays = opts?.recencyDays ?? DICTIONARY_INJECTION_RECENCY_DAYS;
  const nowMs = opts?.now ?? Date.now();
  const recencyThresholdMs = nowMs - recencyDays * 24 * 60 * 60 * 1000;

  const included = entries.filter((e) => {
    if (e.use_count >= minUseCount) return true;
    if (e.last_used_at === null) return false;
    const t = new Date(e.last_used_at).getTime();
    return !Number.isNaN(t) && t >= recencyThresholdMs;
  });

  const sortGroup = (list: ObservationDictionaryEntry[]) =>
    list.slice().sort((a, b) => b.use_count - a.use_count || a.term.localeCompare(b.term));

  const lines: string[] = [];
  lines.push(
    `showing ${included.length} of ${entries.length} terms (use_count >= ${minUseCount} or used in last ${recencyDays} days)`,
  );
  for (const kind of ["setup_observation", "app_defect"] as const) {
    const group = sortGroup(included.filter((e) => e.kind === kind));
    lines.push("");
    lines.push(`${KIND_LABELS[kind]}:`);
    if (group.length === 0) {
      lines.push("  none");
    } else {
      for (const e of group) lines.push(`  ${e.term}: ${e.definition}`);
    }
  }

  return { lines, includedCount: included.length, totalCount: entries.length };
}

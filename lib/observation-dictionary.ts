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

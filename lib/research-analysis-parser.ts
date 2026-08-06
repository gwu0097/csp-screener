import type { ParsedCandidateObservation } from "@/lib/observation-dictionary";

// Parses a pasted external-LLM response against
// lib/analysis-dump-template.ts's ANALYSIS_TEMPLATE response format:
//
//   === ANALYSIS METADATA ===
//   TICKER: <symbol>
//   EARNINGS_DATE: <YYYY-MM-DD>
//   FLAGS_FIRED: <comma-separated, or `none`>
//   FLAGS_NA: <comma-separated, or `none`>   (v3+ only, see below)
//   FLAGS_UNKNOWN: <comma-separated, or `none`>
//   CANDIDATE_FLAGS: <comma-separated, or `none`>   (v1-v3 only, see below)
//   CHECKLIST_VERSION: <value>
//   === END METADATA ===
//   CANDIDATE_OBSERVATIONS:                          (v4+ only, see below)
//     <term>: <definition, first use only>
//     <term>                                          (bare = reuse)
//   <prose>
//
// Must fail loudly, never guess: a missing/malformed metadata block
// saves as prose-only (flags null) rather than being dropped; a field
// within a found block that fails to parse leaves that field null and
// downgrades the whole result to "partial" rather than silently
// treating it as absent. raw_paste is always the untouched input,
// regardless of parse outcome, so a bad parse can be re-parsed later
// without redoing the analysis.
//
// FLAGS_NA is the one exception to "missing = note pushed": it didn't
// exist before v3, so a v1/v2 paste's absent FLAGS_NA line is expected,
// not degraded input — treated as an empty list silently, no note, so
// old-template pastes still parse at zero warnings.
//
// v4 replaced the single-line CANDIDATE_FLAGS metadata field with a
// multi-line CANDIDATE_OBSERVATIONS block that sits in the prose region
// (after === END METADATA ===), since each entry can carry a wrapped
// definition. A v1-v3 paste has no such block — candidateObservations
// comes back empty and CANDIDATE_FLAGS is still read from the metadata
// block, exactly as before. A v4 paste has no CANDIDATE_FLAGS line —
// that's expected too, not a defect, mirroring the FLAGS_NA treatment.
// Whichever field the paste actually uses, the other comes back as an
// empty array; callers should not treat "empty" as "this paste is
// broken" for either one in isolation.

// Current checklist vocabulary (lib/analysis-dump-template.ts's Part
// 1, v3). Used only to flag unrecognized names in the UI preview —
// never to filter or drop them. The vocabulary is expected to grow;
// an entry here going stale just means the "unrecognized" flag looks
// wrong until this list is updated to match a new template version.
// guidance_streak_extrapolated (the v1/v2 name, renamed to
// guidance_beat_streak in v3) is intentionally NOT kept here — stored
// v1/v2 records render it fine regardless (crush-history-table.tsx
// displays whatever's in flags_fired/flags_unknown verbatim, it never
// checks this list), and a NEW paste using the retired v1/v2 name
// should show as unrecognized, since v3's checklist no longer asks for
// it under that name.

export const KNOWN_FLAG_VOCABULARY = [
  "consensus_above_guide",
  "consecutive_deceleration",
  "guidance_beat_streak",
  "peer_dropped_on_inline",
  "live_narrative_risk",
  "runup_into_print",
  "downside_fat_tail",
] as const;

export function isKnownFlag(name: string): boolean {
  return (KNOWN_FLAG_VOCABULARY as readonly string[]).includes(name);
}

export type ParseStatus = "parsed" | "prose_only" | "partial";

export type ParsedResearchAnalysis = {
  status: ParseStatus;
  ticker: string | null;
  earningsDate: string | null;
  flagsFired: string[];
  flagsNa: string[];
  flagsUnknown: string[];
  candidateFlags: string[];
  candidateObservations: ParsedCandidateObservation[];
  // Whether a CANDIDATE_OBSERVATIONS: header was found at all — distinct
  // from candidateObservations.length === 0 (a v4 paste can legitimately
  // list zero observations). Callers use this, not the list length, to
  // decide whether a save is v4-shaped (run the observation dictionary
  // pipeline, sync usages down to zero if now empty) or a legacy v1-v3
  // paste (skip the pipeline entirely, leave candidate_flags/usages as
  // whatever they already were).
  observationsBlockFound: boolean;
  checklistVersion: string | null;
  prose: string;
  proseCharCount: number;
  rawPaste: string;
  // Human-readable account of what happened during parsing — shown
  // verbatim in the paste-back preview so a bad parse is diagnosable,
  // not just silently wrong.
  notes: string[];
};

const METADATA_START = /^===\s*ANALYSIS METADATA\s*===\s*$/m;
const METADATA_END = /^===\s*END METADATA\s*===\s*$/m;
const OBSERVATIONS_HEADER = /^[ \t]*CANDIDATE_OBSERVATIONS:[ \t]*$/;
const OBSERVATION_TERM_LINE = /^([a-z][a-z0-9_]*):\s*(.*)$/;
const OBSERVATION_BARE_TERM_LINE = /^([a-z][a-z0-9_]*)$/;

function parseFlagList(raw: string): string[] {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.toLowerCase() === "none") return [];
  return trimmed
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function extractField(block: string, label: string): string | null {
  const re = new RegExp(`^${label}:\\s*(.*)$`, "m");
  const match = block.match(re);
  if (!match) return null;
  const value = match[1].trim();
  return value.length > 0 ? value : null;
}

// Extracts the CANDIDATE_OBSERVATIONS block from the region after ===
// END METADATA ===, and returns the rest of that region — with the
// block itself removed — as the free-form prose. Without stripping it,
// the block would render duplicated at the top of every prose display
// (Analysis Dump tab, the AI-badge modal, the History tab).
//
// The block is delimited structurally, not by a closing marker: every
// blank or indented line right after the CANDIDATE_OBSERVATIONS: header
// belongs to it; the first non-blank, unindented line ends it. A term
// line is `term_name: definition text` (first use) or a bare
// `term_name` (reuse of an already-known term, no colon). An indented
// line under a just-defined term is a continuation of that definition.
function extractCandidateObservationsBlock(proseRaw: string): {
  found: boolean;
  observations: ParsedCandidateObservation[];
  remainder: string;
  notes: string[];
} {
  const lines = proseRaw.split("\n");
  const headerIdx = lines.findIndex((l) => OBSERVATIONS_HEADER.test(l));
  if (headerIdx === -1) {
    return { found: false, observations: [], remainder: proseRaw.trim(), notes: [] };
  }

  let i = headerIdx + 1;
  const blockLines: string[] = [];
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    const isIndented = /^[ \t]/.test(line) && trimmed.length > 0;
    const isBlank = trimmed.length === 0;
    if (!isIndented && !isBlank) break;
    blockLines.push(line);
    i += 1;
  }

  const remainder = [...lines.slice(0, headerIdx), ...lines.slice(i)].join("\n").trim();

  const observations: ParsedCandidateObservation[] = [];
  const seen = new Map<string, string | null>();
  const notes: string[] = [];
  let openTerm: string | null = null;

  for (const rawLine of blockLines) {
    const trimmed = rawLine.trim();
    if (trimmed.length === 0 || trimmed.toLowerCase() === "none") {
      openTerm = null;
      continue;
    }
    const termMatch = OBSERVATION_TERM_LINE.exec(trimmed);
    if (termMatch) {
      const term = termMatch[1];
      const defText = termMatch[2].trim();
      const definition = defText.length > 0 ? defText : null;
      if (seen.has(term)) {
        if (seen.get(term) !== definition) {
          notes.push(
            `CANDIDATE_OBSERVATIONS lists "${term}" more than once with different text — using the first occurrence.`,
          );
        }
        openTerm = null;
        continue;
      }
      seen.set(term, definition);
      observations.push({ term, definition });
      openTerm = definition !== null ? term : null;
      continue;
    }
    const bareMatch = OBSERVATION_BARE_TERM_LINE.exec(trimmed);
    if (bareMatch) {
      const term = bareMatch[1];
      if (seen.has(term)) {
        openTerm = null;
        continue;
      }
      seen.set(term, null);
      observations.push({ term, definition: null });
      openTerm = null;
      continue;
    }
    if (openTerm) {
      const idx = observations.findIndex((o) => o.term === openTerm);
      if (idx !== -1 && observations[idx].definition !== null) {
        const merged = `${observations[idx].definition} ${trimmed}`;
        observations[idx] = { ...observations[idx], definition: merged };
        seen.set(openTerm, merged);
      }
    } else {
      notes.push(`Unrecognized line in CANDIDATE_OBSERVATIONS, ignored: "${trimmed}"`);
    }
  }

  return { found: true, observations, remainder, notes };
}

export function parseResearchAnalysisPaste(raw: string): ParsedResearchAnalysis {
  const rawPaste = raw;
  const notes: string[] = [];

  const startMatch = METADATA_START.exec(raw);
  const endMatch = METADATA_END.exec(raw);

  if (!startMatch || !endMatch || endMatch.index <= startMatch.index) {
    return {
      status: "prose_only",
      ticker: null,
      earningsDate: null,
      flagsFired: [],
      flagsNa: [],
      flagsUnknown: [],
      candidateFlags: [],
      candidateObservations: [],
      observationsBlockFound: false,
      checklistVersion: null,
      prose: raw.trim(),
      proseCharCount: raw.trim().length,
      rawPaste,
      notes: ["No ANALYSIS METADATA block found (expected \"=== ANALYSIS METADATA ===\" ... \"=== END METADATA ===\") — saved as prose-only, flags left null."],
    };
  }

  const block = raw.slice(startMatch.index + startMatch[0].length, endMatch.index);
  const proseRaw = raw.slice(endMatch.index + endMatch[0].length);
  const obsResult = extractCandidateObservationsBlock(proseRaw);
  const prose = obsResult.remainder;
  notes.push(...obsResult.notes);

  const ticker = extractField(block, "TICKER");
  if (ticker === null) notes.push("TICKER line missing or empty within the metadata block.");
  const earningsDate = extractField(block, "EARNINGS_DATE");
  if (earningsDate === null) notes.push("EARNINGS_DATE line missing or empty within the metadata block.");
  else if (!/^\d{4}-\d{2}-\d{2}$/.test(earningsDate)) {
    notes.push(`EARNINGS_DATE "${earningsDate}" is not YYYY-MM-DD — kept as-is, will not match on save.`);
  }

  const flagsFiredRaw = extractField(block, "FLAGS_FIRED");
  if (flagsFiredRaw === null) notes.push("FLAGS_FIRED line missing within the metadata block — treated as empty.");
  // FLAGS_NA has no v1/v2 equivalent — a missing line is expected for
  // those templates, not a defect, so no note is pushed (see file-top
  // comment). It's treated identically to a present-but-empty list.
  const flagsNaRaw = extractField(block, "FLAGS_NA");
  const flagsUnknownRaw = extractField(block, "FLAGS_UNKNOWN");
  if (flagsUnknownRaw === null) notes.push("FLAGS_UNKNOWN line missing within the metadata block — treated as empty.");
  // A v4 paste has no CANDIDATE_FLAGS line at all (see file-top
  // comment) — only push the note when no CANDIDATE_OBSERVATIONS block
  // was found either, i.e. this really does look like an older paste
  // missing its field, not a v4 paste using the new format correctly.
  const candidateFlagsRaw = extractField(block, "CANDIDATE_FLAGS");
  if (candidateFlagsRaw === null && !obsResult.found) {
    notes.push("CANDIDATE_FLAGS line missing within the metadata block — treated as empty.");
  }
  const checklistVersion = extractField(block, "CHECKLIST_VERSION");
  if (checklistVersion === null) notes.push("CHECKLIST_VERSION line missing or empty within the metadata block.");

  const flagsFired = parseFlagList(flagsFiredRaw ?? "");
  const flagsNa = parseFlagList(flagsNaRaw ?? "");
  const flagsUnknown = parseFlagList(flagsUnknownRaw ?? "");
  const candidateFlags = parseFlagList(candidateFlagsRaw ?? "");

  // "parsed" requires the two fields the caller actually relies on
  // (ticker/date, for the mismatch guard) plus checklist_version, to
  // be present and well-formed. Missing flag lines don't downgrade the
  // status on their own — an LLM correctly writing "none" is
  // indistinguishable from a missing line at this point, and both are
  // legitimately empty arrays, not errors.
  const dateWellFormed = earningsDate !== null && /^\d{4}-\d{2}-\d{2}$/.test(earningsDate);
  const status: ParseStatus = ticker !== null && dateWellFormed && checklistVersion !== null ? "parsed" : "partial";

  return {
    status,
    ticker,
    earningsDate,
    flagsFired,
    flagsNa,
    flagsUnknown,
    candidateFlags,
    candidateObservations: obsResult.observations,
    observationsBlockFound: obsResult.found,
    checklistVersion,
    prose,
    proseCharCount: prose.length,
    rawPaste,
    notes,
  };
}

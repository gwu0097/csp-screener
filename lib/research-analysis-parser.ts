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

export type Recommendation = "take" | "take_smaller" | "pass";
export type DownCatalystPlausibility = "low" | "moderate" | "high" | "n/a";

export type ParsedResearchAnalysis = {
  status: ParseStatus;
  ticker: string | null;
  earningsDate: string | null;
  flagsFired: string[];
  flagsNa: string[];
  flagsUnknown: string[];
  candidateFlags: string[];
  candidateObservations: ParsedCandidateObservation[];
  // Added 2026-08-11 (audit: prose-only recommendation/catalyst couldn't
  // be scored). Absent on any paste written before that date's template
  // change — treated as expected absence, same as FLAGS_NA on v1/v2,
  // never a parse error on their own.
  recommendation: Recommendation | null;
  recommendedStrike: number | null;
  downCatalyst: string | null;
  downCatalystPlausibility: DownCatalystPlausibility | null;
  // Added 2026-08-11 (v6): the one field the prediction log actually
  // scores — Part 2's yes/no verdict. Same absence treatment as the
  // fields above; absent on any v5-or-earlier paste, never an error.
  leftTailRisk: boolean | null;
  // Whether a CANDIDATE_OBSERVATIONS: header was found at all — distinct
  // from candidateObservations.length === 0 (a v4 paste can legitimately
  // list zero observations). Callers use this, not the list length, to
  // decide whether a save is v4-shaped (run the observation dictionary
  // pipeline, sync usages down to zero if now empty) or a legacy v1-v3
  // paste (skip the pipeline entirely, leave candidate_flags/usages as
  // whatever they already were).
  observationsBlockFound: boolean;
  // True only when the block was found, has real (non-blank, non-"none")
  // content, and NONE of it matched a term pattern — distinct from a
  // legitimately empty block (found + literal "none" + zero
  // observations). Callers must not read candidateObservations.length
  // === 0 as "nothing to do" without also checking this; a paste that
  // hits this is broken and needs a human look, not a silent empty save.
  observationsParseFailed: boolean;
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
// Terminates the CANDIDATE_OBSERVATIONS span. Matches the response's own
// section headers (`PART 1 — CHECKLIST`, in whatever wording that quarter's
// template used — checked against every real paste on file: the em-dash
// title varies, "PART <n>" never does) plus another `===...===` marker as
// a defensive fallback. The leading `(#{1,6}\s*)?(\*\*)?` tolerates the
// analyst rendering headers as markdown (`## PART 1 — CHECKLIST`, real
// pastes through 2026-08-10) vs plain text (`PART 1 — CHECKLIST`, every
// paste from 2026-08-11 on) — checked against both styles on file;
// missing this cost one real paste (ASTS) its entire prose, swallowed
// into the span because "## PART 1" didn't match a plain "PART 1" regex
// and the span ran to end-of-input instead. Deliberately NOT a blank
// line — see the comment on extractCandidateObservationsBlock below.
const SECTION_MARKER_LINE = /^(#{1,6}\s*)?(\*\*)?(===.*===|PART\s+\d+\b.*)$/;

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
// History: the original version required every block line to be
// indented to stay "inside" the block — broke silently once real pastes
// went flush-left starting 2026-08-11 (see git blame). The next version
// terminated on the first blank line instead — an improvement, but still
// positional: a stray blank line mid-block, or a reordered response,
// would truncate or miss the block the same way. This version doesn't
// rely on position at all: it finds the header, then the span extends to
// the next recognized section marker (SECTION_MARKER_LINE — a `PART <n>`
// heading or another `===...===` line) or to the end of the input if
// none follows. Blank lines inside that span are just gaps, not
// terminators. Within the span, a term line is `term_name: definition
// text` (first use) or a bare `term_name` (reuse), matched on the
// trimmed line wherever it falls — indentation and surrounding blank
// lines never affect whether a line matches.
//
// A found-but-empty block is legitimate (the analyst wrote literal
// `none`) and must be distinguishable from a found block that has real
// content but where nothing matched a term pattern — the latter is a
// parse failure, not a paste with zero observations, and silently
// returning `[]` for both is exactly the failure mode that let 8 real
// analyses lose their observations without any signal (2026-08-13
// backfill). `parseFailed` below carries that distinction; the caller
// pushes a note when it's true so it's visible in the preview, not just
// inferred from an empty list.
function extractCandidateObservationsBlock(proseRaw: string): {
  found: boolean;
  observations: ParsedCandidateObservation[];
  remainder: string;
  notes: string[];
  parseFailed: boolean;
} {
  const lines = proseRaw.split("\n");
  const headerIdx = lines.findIndex((l) => OBSERVATIONS_HEADER.test(l));
  if (headerIdx === -1) {
    return { found: false, observations: [], remainder: proseRaw.trim(), notes: [], parseFailed: false };
  }

  let endIdx = lines.length;
  let markerFound = false;
  for (let i = headerIdx + 1; i < lines.length; i += 1) {
    if (SECTION_MARKER_LINE.test(lines[i].trim())) {
      endIdx = i;
      markerFound = true;
      break;
    }
  }
  const blockLines = lines.slice(headerIdx + 1, endIdx);
  const remainder = [...lines.slice(0, headerIdx), ...lines.slice(endIdx)].join("\n").trim();

  const observations: ParsedCandidateObservation[] = [];
  const seen = new Map<string, string | null>();
  const notes: string[] = [];
  let openTerm: string | null = null;
  let sawContent = false;

  // No recognized section marker anywhere after the header means the
  // span ran to the end of the input — either this really is the last
  // thing in the paste, or the response uses a heading style
  // SECTION_MARKER_LINE doesn't recognize yet, in which case everything
  // after CANDIDATE_OBSERVATIONS just got swallowed into this block
  // (exactly what happened to ASTS's paste before this regex learned
  // markdown `##` headers). Surfaced as a note rather than failing
  // silently a second time.
  if (!markerFound && endIdx - (headerIdx + 1) > 3) {
    notes.push(
      "CANDIDATE_OBSERVATIONS block ran to the end of the input with no PART-heading marker found after it — if the response has more sections below this, they were not detected and got swallowed into this block. Check for an unrecognized heading style.",
    );
  }

  for (const rawLine of blockLines) {
    const trimmed = rawLine.trim();
    if (trimmed.length === 0) {
      openTerm = null;
      continue;
    }
    if (trimmed.toLowerCase() === "none") {
      openTerm = null;
      continue;
    }
    sawContent = true;
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

  const parseFailed = sawContent && observations.length === 0;
  if (parseFailed) {
    notes.push(
      "CANDIDATE_OBSERVATIONS block has content but no line matched a term pattern — this is a parse failure, not an empty list. Check the raw paste against the expected format.",
    );
  }

  return { found: true, observations, remainder, notes, parseFailed };
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
      observationsParseFailed: false,
      checklistVersion: null,
      recommendation: null,
      recommendedStrike: null,
      downCatalyst: null,
      downCatalystPlausibility: null,
      leftTailRisk: null,
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

  // Added 2026-08-11 — absent on any pre-existing paste, same treatment
  // as FLAGS_NA: no note on absence. A PRESENT-but-malformed value does
  // get a note and is dropped to null, same as EARNINGS_DATE's format
  // check above — never guess a value from a shape that doesn't match.
  const recommendationRaw = extractField(block, "RECOMMENDATION");
  let recommendation: Recommendation | null = null;
  if (recommendationRaw !== null) {
    const normalized = recommendationRaw.trim().toLowerCase();
    if (normalized === "take" || normalized === "take_smaller" || normalized === "pass") {
      recommendation = normalized;
    } else {
      notes.push(
        `RECOMMENDATION "${recommendationRaw}" is not one of take/take_smaller/pass — left null.`,
      );
    }
  }

  const recommendedStrikeRaw = extractField(block, "RECOMMENDED_STRIKE");
  let recommendedStrike: number | null = null;
  if (recommendedStrikeRaw !== null) {
    const parsedNum = Number(recommendedStrikeRaw.replace(/[$,]/g, ""));
    if (Number.isFinite(parsedNum)) {
      recommendedStrike = parsedNum;
    } else {
      notes.push(`RECOMMENDED_STRIKE "${recommendedStrikeRaw}" is not a number — left null.`);
    }
  }

  const downCatalyst = extractField(block, "DOWN_CATALYST");

  const downCatalystPlausibilityRaw = extractField(block, "DOWN_CATALYST_PLAUSIBILITY");
  let downCatalystPlausibility: DownCatalystPlausibility | null = null;
  if (downCatalystPlausibilityRaw !== null) {
    const normalized = downCatalystPlausibilityRaw.trim().toLowerCase();
    if (normalized === "low" || normalized === "moderate" || normalized === "high" || normalized === "n/a") {
      downCatalystPlausibility = normalized;
    } else {
      notes.push(
        `DOWN_CATALYST_PLAUSIBILITY "${downCatalystPlausibilityRaw}" is not one of low/moderate/high/n/a — left null.`,
      );
    }
  }

  // Added 2026-08-11 (v6) — the field the prediction log scores. Same
  // absent-vs-malformed treatment as RECOMMENDATION above.
  const leftTailRiskRaw = extractField(block, "LEFT_TAIL_RISK");
  let leftTailRisk: boolean | null = null;
  if (leftTailRiskRaw !== null) {
    const normalized = leftTailRiskRaw.trim().toLowerCase();
    if (normalized === "yes") {
      leftTailRisk = true;
    } else if (normalized === "no") {
      leftTailRisk = false;
    } else {
      notes.push(`LEFT_TAIL_RISK "${leftTailRiskRaw}" is not yes/no — left null.`);
    }
  }

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
  const status: ParseStatus =
    ticker !== null && dateWellFormed && checklistVersion !== null && !obsResult.parseFailed
      ? "parsed"
      : "partial";

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
    observationsParseFailed: obsResult.parseFailed,
    checklistVersion,
    recommendation,
    recommendedStrike,
    downCatalyst,
    downCatalystPlausibility,
    leftTailRisk,
    prose,
    proseCharCount: prose.length,
    rawPaste,
    notes,
  };
}

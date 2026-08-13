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
// FLAGS_NA, RECOMMENDATION, RECOMMENDED_STRIKE, DOWN_CATALYST,
// DOWN_CATALYST_PLAUSIBILITY, and LEFT_TAIL_RISK are each required only
// from the template version that introduced them onward (v3 for
// FLAGS_NA; v6 for the other five — NOT v5, despite four of them being
// added while the template was still v5; see the RECOMMENDATION block
// below for why) — checklistVersionNumber() plus each field's own check
// below decides whether THIS paste's declared version makes the field
// required, so a missing line is either silently expected (older
// version, field didn't exist yet) or a noted parse failure that
// downgrades status to "partial" (this version requires it). A present
// value that doesn't match its expected shape (RECOMMENDATION: maybe)
// downgrades status the same way — worse than absence, since the
// analyst answered the field wrong rather than not answering it at all.
// Before 2026-08-13 none of this existed: every field used a single
// fixed "always optional, malformed never downgrades status" rule,
// which meant a v6 paste silently missing DOWN_CATALYST, or answering
// RECOMMENDATION with garbage, looked identical to a correctly-parsed
// paste.
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

// Extracts the numeric part of a declared CHECKLIST_VERSION ("v6" -> 6),
// or null if unparseable/absent — in which case a caller can't tell
// whether a field is required, so it should skip the check rather than
// guess. Drives every "is this field's absence expected on THIS paste's
// declared version, or a parse failure" decision below, replacing the
// old fixed "some fields are always optional" treatment: a field's
// required-from version is a fact about the template, not about the
// field being inherently optional forever.
function checklistVersionNumber(version: string | null): number | null {
  if (version === null) return null;
  const match = /^v(\d+)$/.exec(version.trim());
  return match ? Number(match[1]) : null;
}

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

  const checklistVersion = extractField(block, "CHECKLIST_VERSION");
  if (checklistVersion === null) notes.push("CHECKLIST_VERSION line missing or empty within the metadata block.");
  const versionNum = checklistVersionNumber(checklistVersion);
  // True whenever a field either (a) is required by this paste's OWN
  // declared version and missing, or (b) is present but doesn't match
  // its expected shape (RECOMMENDATION not one of take/take_smaller/
  // pass, etc). Distinct from a field that's simply optional at this
  // version and absent — that's expected, no note, doesn't set this.
  // (a) is the failure mode downCatalyst had — required on v6, capable
  // of returning null with no signal at all (2026-08-13 audit). (b) is
  // set alongside it, not separately, because a malformed value is a
  // worse failure than an absent one: an analyst who writes
  // `RECOMMENDATION: maybe` looked at the field and answered it wrong,
  // which says less about whether the rest of the paste is trustworthy
  // than a value that's simply missing — treating it as milder than a
  // missing-required field had it backwards (2026-08-13 audit).
  let fieldParseFailure = false;

  const flagsFiredRaw = extractField(block, "FLAGS_FIRED");
  if (flagsFiredRaw === null) notes.push("FLAGS_FIRED line missing within the metadata block — treated as empty.");
  // FLAGS_NA was introduced in v3 (lib/analysis-dump-template.ts commit
  // 43aab3af). Absence on a v1/v2 paste is the template's own shape,
  // not a defect; absence on v3+ means the analyst dropped a line the
  // current template requires, which was previously indistinguishable
  // from the v1/v2 case — both silently produced an empty list.
  const flagsNaRaw = extractField(block, "FLAGS_NA");
  if (flagsNaRaw === null && versionNum !== null && versionNum >= 3) {
    notes.push(`FLAGS_NA line missing — required from v3 onward, this paste declares ${checklistVersion}.`);
    fieldParseFailure = true;
  }
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

  // RECOMMENDATION / RECOMMENDED_STRIKE / DOWN_CATALYST /
  // DOWN_CATALYST_PLAUSIBILITY were added 2026-08-11 (commit f82d1c4)
  // WITHOUT a version bump — that commit's own message states Part 1's
  // vocabulary was unchanged, so it deliberately kept CHECKLIST_VERSION
  // at v5. That means a bare "v5" can't distinguish a pre-2026-08-11
  // paste (fields didn't exist yet, absence expected) from a paste
  // written in the ~1-hour window between that commit and the v6 bump
  // (237e5c2) where they'd already be required — checklistVersion
  // genuinely cannot resolve that narrow band. Gating the requirement
  // at v6 instead of v5 accepts that theoretical gap (no stored v5 row
  // falls in that window — confirmed 2026-08-13) rather than risk
  // false-flagging real, correctly-parsed pre-2026-08-11 v5 pastes
  // (ASTS, AKAM, RKLB) as broken.
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
      fieldParseFailure = true;
    }
  } else if (versionNum !== null && versionNum >= 6) {
    notes.push(`RECOMMENDATION line missing — required from v6 onward, this paste declares ${checklistVersion}.`);
    fieldParseFailure = true;
  }

  const recommendedStrikeRaw = extractField(block, "RECOMMENDED_STRIKE");
  let recommendedStrike: number | null = null;
  if (recommendedStrikeRaw !== null) {
    const parsedNum = Number(recommendedStrikeRaw.replace(/[$,]/g, ""));
    if (Number.isFinite(parsedNum)) {
      recommendedStrike = parsedNum;
    } else {
      notes.push(`RECOMMENDED_STRIKE "${recommendedStrikeRaw}" is not a number — left null.`);
      fieldParseFailure = true;
    }
  } else if (versionNum !== null && versionNum >= 6) {
    notes.push(`RECOMMENDED_STRIKE line missing — required from v6 onward, this paste declares ${checklistVersion}.`);
    fieldParseFailure = true;
  }

  const downCatalyst = extractField(block, "DOWN_CATALYST");
  if (downCatalyst === null && versionNum !== null && versionNum >= 6) {
    notes.push(
      `DOWN_CATALYST line missing — required from v6 onward, this paste declares ${checklistVersion}. (Write "none" when LEFT_TAIL_RISK is no — a missing line is not the same as an intentional "none".)`,
    );
    fieldParseFailure = true;
  }

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
      fieldParseFailure = true;
    }
  } else if (versionNum !== null && versionNum >= 6) {
    notes.push(
      `DOWN_CATALYST_PLAUSIBILITY line missing — required from v6 onward, this paste declares ${checklistVersion}.`,
    );
    fieldParseFailure = true;
  }

  // Added 2026-08-11 (v6, commit 237e5c2) — this one's threshold is a
  // real version bump, no ambiguity like the four fields above.
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
      fieldParseFailure = true;
    }
  } else if (versionNum !== null && versionNum >= 6) {
    notes.push(`LEFT_TAIL_RISK line missing — required from v6 onward, this paste declares ${checklistVersion}.`);
    fieldParseFailure = true;
  }

  const flagsFired = parseFlagList(flagsFiredRaw ?? "");
  const flagsNa = parseFlagList(flagsNaRaw ?? "");
  const flagsUnknown = parseFlagList(flagsUnknownRaw ?? "");
  const candidateFlags = parseFlagList(candidateFlagsRaw ?? "");

  // "parsed" requires the two fields the caller actually relies on
  // (ticker/date, for the mismatch guard) plus checklist_version, to
  // be present and well-formed, the observations block (if any) to have
  // actually parsed, and every field this paste's OWN declared version
  // requires to be present and well-formed (fieldParseFailure covers
  // both). A field that's optional at this version and simply absent
  // does NOT downgrade status — an LLM correctly writing "none" is
  // indistinguishable from a missing line at that point, and both are
  // legitimately empty, not errors. A malformed value (RECOMMENDATION:
  // maybe) DOES downgrade status, same as a missing-required one — it's
  // the worse failure of the two, since the analyst looked at the field
  // and answered it wrong rather than simply not writing it.
  const dateWellFormed = earningsDate !== null && /^\d{4}-\d{2}-\d{2}$/.test(earningsDate);
  const status: ParseStatus =
    ticker !== null &&
    dateWellFormed &&
    checklistVersion !== null &&
    !obsResult.parseFailed &&
    !fieldParseFailure
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

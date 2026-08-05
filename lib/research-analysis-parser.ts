// Parses a pasted external-LLM response against
// lib/analysis-dump-template.ts's ANALYSIS_TEMPLATE response format:
//
//   === ANALYSIS METADATA ===
//   TICKER: <symbol>
//   EARNINGS_DATE: <YYYY-MM-DD>
//   FLAGS_FIRED: <comma-separated, or `none`>
//   FLAGS_UNKNOWN: <comma-separated, or `none`>
//   CANDIDATE_FLAGS: <comma-separated, or `none`>
//   CHECKLIST_VERSION: <value>
//   === END METADATA ===
//   <prose>
//
// Must fail loudly, never guess: a missing/malformed metadata block
// saves as prose-only (flags null) rather than being dropped; a field
// within a found block that fails to parse leaves that field null and
// downgrades the whole result to "partial" rather than silently
// treating it as absent. raw_paste is always the untouched input,
// regardless of parse outcome, so a bad parse can be re-parsed later
// without redoing the analysis.

// v1 checklist vocabulary (lib/analysis-dump-template.ts's Part 1).
// Used only to flag unrecognized names in the UI preview — never to
// filter or drop them. The vocabulary is expected to grow; an entry
// here going stale just means the "unrecognized" flag looks wrong
// until this list is updated to match a new template version.
export const KNOWN_FLAG_VOCABULARY = [
  "consensus_above_guide",
  "consecutive_deceleration",
  "guidance_streak_extrapolated",
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
  flagsUnknown: string[];
  candidateFlags: string[];
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
      flagsUnknown: [],
      candidateFlags: [],
      checklistVersion: null,
      prose: raw.trim(),
      proseCharCount: raw.trim().length,
      rawPaste,
      notes: ["No ANALYSIS METADATA block found (expected \"=== ANALYSIS METADATA ===\" ... \"=== END METADATA ===\") — saved as prose-only, flags left null."],
    };
  }

  const block = raw.slice(startMatch.index + startMatch[0].length, endMatch.index);
  const prose = raw.slice(endMatch.index + endMatch[0].length).trim();

  const ticker = extractField(block, "TICKER");
  if (ticker === null) notes.push("TICKER line missing or empty within the metadata block.");
  const earningsDate = extractField(block, "EARNINGS_DATE");
  if (earningsDate === null) notes.push("EARNINGS_DATE line missing or empty within the metadata block.");
  else if (!/^\d{4}-\d{2}-\d{2}$/.test(earningsDate)) {
    notes.push(`EARNINGS_DATE "${earningsDate}" is not YYYY-MM-DD — kept as-is, will not match on save.`);
  }

  const flagsFiredRaw = extractField(block, "FLAGS_FIRED");
  if (flagsFiredRaw === null) notes.push("FLAGS_FIRED line missing within the metadata block — treated as empty.");
  const flagsUnknownRaw = extractField(block, "FLAGS_UNKNOWN");
  if (flagsUnknownRaw === null) notes.push("FLAGS_UNKNOWN line missing within the metadata block — treated as empty.");
  const candidateFlagsRaw = extractField(block, "CANDIDATE_FLAGS");
  if (candidateFlagsRaw === null) notes.push("CANDIDATE_FLAGS line missing within the metadata block — treated as empty.");
  const checklistVersion = extractField(block, "CHECKLIST_VERSION");
  if (checklistVersion === null) notes.push("CHECKLIST_VERSION line missing or empty within the metadata block.");

  const flagsFired = parseFlagList(flagsFiredRaw ?? "");
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
    flagsUnknown,
    candidateFlags,
    checklistVersion,
    prose,
    proseCharCount: prose.length,
    rawPaste,
    notes,
  };
}

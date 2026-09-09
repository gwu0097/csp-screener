// Structured signal-card generation for the Earnings Reports analysis
// (Stage A: sourced from the 8-K exhibit only). Qualtrim-style cards —
// argue and label, not extract and report. See the 2026-09-10 design
// review for the full rationale; this file is the implementation of
// that proposal.
import { extractJsonObject } from "./earnings-release-capture";

export type CardSignal = "bullish" | "bearish" | "neutral";
export type CardBasis = "stated" | "inferred";
export type CardSeverity = "high" | "medium" | "low";

export type Card = {
  signal: CardSignal;
  title: string;
  argument: string;
  metric_evidence: string[];
  basis: CardBasis;
  severity?: CardSeverity; // red_flags cards only
};

// A red_flags-only stub for a claim that genuinely needs the 10-Q to
// substantiate — appended by CODE (buildPendingLegalStub below), never
// requested of or emitted by the model. See the design review: relying
// on the model to remember this every run is weaker than the code
// guaranteeing it.
export type PendingStub = {
  status: "pending_10q";
  title: string;
  note: string;
};

export type SectionKey = "ai_generated_insights" | "what_changed_this_quarter" | "red_flags" | "strengths";

export type CardsPayload = {
  version: "v1";
  generated_at: string;
  stage: "A";
  pending_stage_b: string[];
  sections: {
    ai_generated_insights: Card[];
    what_changed_this_quarter: Card[];
    red_flags: Array<Card | PendingStub>;
    strengths: Card[];
  };
};

export function isPendingStub(c: Card | PendingStub): c is PendingStub {
  return (c as PendingStub).status === "pending_10q";
}

export function buildPendingLegalStub(): PendingStub {
  return {
    status: "pending_10q",
    title: "Legal & Regulatory Overhang",
    note: "Not assessable from the 8-K alone; pending 10-Q.",
  };
}

export function buildCardsPrompt(symbol: string, quarter: string, pressText: string): string {
  return `You are producing structured signal cards for a post-mortem "Earnings Reports" entry for a long-term stock holder — NOT a pre-trade research pitch. This is ${symbol} ${quarter}, sourced from the 8-K earnings-release exhibit below.

Output ONLY a single JSON object, no prose, no markdown fences, matching this exact shape:

{
  "sections": {
    "ai_generated_insights": [ <card>, ... ],
    "what_changed_this_quarter": [ <card>, ... ],
    "red_flags": [ <card>, ... ],
    "strengths": [ <card>, ... ]
  }
}

Every card:
{
  "signal": "bullish" | "bearish" | "neutral",
  "title": "2-5 word named thesis — 'Ad-Tier Monetization Acceleration', not 'Advertising'",
  "argument": "2-3 sentences. State the causal MECHANISM — why this figure implies what you're claiming, not just that it moved. Confident voice, not hedged.",
  "metric_evidence": ["specific figure or quote, one per array entry"],
  "basis": "stated" | "inferred"
}

Red_flags cards additionally require "severity": "high" | "medium" | "low" — no numeric score, nothing in a single filing supports that granularity.

basis: "stated" = management said it directly, or it's a reported figure in this document. "inferred" = your own read connecting facts the filing doesn't explicitly connect (a re-rating call, a competitive read, a forward implication). Both wanted. Never blur the two — pick the honest one, don't default to "stated" because it sounds more confident. A "stated" card's metric_evidence must be figures that actually appear in the text below — this gets checked mechanically.

METRIC EVIDENCE IS MANDATORY. A thesis with no specific figure behind it does not get a card. If you don't have a number, you don't have a card, no exceptions.

SECTION RULES:

ai_generated_insights — 2-4 cards, the core theses about where this business is headed. Mixed bullish/bearish is expected and good. This is the story, not a metric-by-metric recap; every other section's cards should read as evidence FOR something, these are the conclusions.

what_changed_this_quarter — built ONLY from explicit sequential (quarter-over-quarter) figures this release itself states. Most releases show a Q/Q column alongside Y/Y in their summary table — use that. Do not derive a QoQ read from two YoY figures; if the release states no sequential comparison, leave this section empty rather than manufacture one.

red_flags — real risks only, do not manufacture one to fill the section; an empty array is a valid, honest answer for a clean quarter. Do NOT write anything about litigation, legal proceedings, or subsequent events — that material requires the 10-Q, which you don't have; leave those out entirely rather than guess.

strengths — durable, structural positives: what's working because of how the business is built, not a one-quarter tailwind. Still needs its own metric evidence per card, same as every other section.

Press release text (SEC EDGAR, live-fetched, HTML-stripped):

${pressText}`;
}

// --- Verification: does a "stated" card's evidence actually appear in
// the source? Numeric/substring, not exact-string match — filers and
// models reformat the same figure ("$96.2 billion" vs "96,221" vs
// "96.2B"). Only checks numeric tokens with 3+ digits or a decimal
// point; bare 1-2 digit integers ("35", "12") are too common to be a
// meaningful signal either way and would just produce noise.
//
// Parses to NUMERIC VALUES, not raw strings — caught live 2026-09-10
// (SNOW): a card citing "$20.7 million" for a loss was correct (source
// table: "$(20,725)" thousand) but got dropped by a pure substring
// check, since "20.7" never appears as a literal substring of "20725".
// Financial writing routinely rounds a table's exact thousands-value to
// one decimal in millions when quoted in prose — a real instance of
// "figures get reformatted," not a fabrication. See
// numbersApproximatelyMatch below for how this is reconciled.
function extractNumericValues(text: string): number[] {
  const matches = text.match(/\(?-?\$?\d[\d,]*\.?\d*\)?/g) ?? [];
  const out: number[] = [];
  for (const m of matches) {
    const negative = m.startsWith("(") && m.endsWith(")");
    const clean = m.replace(/[(),$]/g, "");
    if (clean.replace(".", "").replace("-", "").length < 3 && !clean.includes(".")) continue;
    const n = Number(clean);
    if (!Number.isFinite(n)) continue;
    out.push(negative ? -n : n);
  }
  return out;
}

// True if two numbers plausibly refer to the same underlying figure —
// either directly close, or one is the other scaled by 1000 (a
// thousands-table value vs. a millions-rounded prose mention) within a
// tolerance wide enough to absorb 1-decimal-place rounding (up to 0.05
// million = 50 on the thousands side) plus a little slack for looser
// rounding. Sign-agnostic — caught live 2026-09-10 (SNOW): a real loss
// shown in a table as "$(20,725)" (accounting-convention negative) was
// correctly described in prose as "a loss of $20.7 million" (positive
// magnitude, the loss framing already carries the sign). Comparing
// signed values would treat that as a mismatch; the sign itself isn't
// the fact being checked here, the magnitude is.
function numbersApproximatelyMatch(a: number, b: number): boolean {
  const [x, y] = [Math.abs(a), Math.abs(b)];
  const closeEnough = (p: number, q: number, tolerance: number) => Math.abs(p - q) <= tolerance;
  if (closeEnough(x, y, Math.max(0.5, x * 0.005))) return true;
  if (closeEnough(x * 1000, y, 75) || closeEnough(y * 1000, x, 75)) return true;
  return false;
}

export type EvidenceVerification = {
  checkedValues: number[];
  matchedValues: number[];
  // true when every checked value matched, OR there was nothing
  // numeric to check at all (a quote-only evidence entry) — the
  // mechanical check can't penalize what it can't check.
  verified: boolean;
  hadNumericContent: boolean;
};

export function verifyMetricEvidence(evidenceItems: string[], sourceText: string): EvidenceVerification {
  const sourceValues = extractNumericValues(sourceText);
  const evidenceValues = Array.from(new Set(evidenceItems.flatMap(extractNumericValues)));
  if (evidenceValues.length === 0) {
    return { checkedValues: [], matchedValues: [], verified: true, hadNumericContent: false };
  }
  const matched = evidenceValues.filter((v) => sourceValues.some((s) => numbersApproximatelyMatch(v, s)));
  return { checkedValues: evidenceValues, matchedValues: matched, verified: matched.length > 0, hadNumericContent: true };
}

export type DroppedCard = { section: SectionKey; title: string; reason: string };
export type VerificationLogEntry = { section: SectionKey; title: string } & EvidenceVerification;
// A card whose basis field was missing/malformed — a schema-completeness
// miss, not a bad claim. Defaulted to "inferred" (the conservative
// choice: it asserts nothing about what the filing said, so a wrong
// default under-claims rather than over-claims) and kept rather than
// dropped. Logged separately so its frequency can be tracked across a
// run — see the 2026-09-10 SNOW Q4 2026 review, where dropping cost 3
// of 4 red_flags over one omitted field.
export type BasisDefaultedCard = { section: SectionKey; title: string; rawBasis: string };

export type ParseResult =
  | {
      ok: true;
      payload: CardsPayload;
      dropped: DroppedCard[];
      verificationLog: VerificationLogEntry[];
      basisDefaulted: BasisDefaultedCard[];
    }
  | { ok: false; reason: string };

const SECTION_KEYS: SectionKey[] = ["ai_generated_insights", "what_changed_this_quarter", "red_flags", "strengths"];

// Parses the model's JSON, validates each card, and DROPS invalid ones
// individually (logged, not a whole-run rejection — one bad card out
// of ten shouldn't discard nine good ones, per the 2026-09-10 review).
// The run only fails outright if ai_generated_insights ends up empty
// after dropping — that section is the actual deliverable; every other
// section may legitimately be empty (a clean quarter has no red flags,
// a release with no Q/Q table has nothing for what_changed).
//
// enforceStatedVerification: when true, a "stated" card whose evidence
// doesn't verify against pressText is dropped like any other invalid
// card. When false, verification still runs and is logged (for the
// false-positive-rate calibration this was built to support) but never
// drops a card on its own.
export function parseAndValidateCards(
  raw: string,
  pressText: string,
  opts: { enforceStatedVerification: boolean },
): ParseResult {
  const parsed = extractJsonObject(raw) as { sections?: Record<string, unknown> } | null;
  if (!parsed || typeof parsed !== "object") return { ok: false, reason: "no JSON object found in claude -p output" };
  const rawSections = parsed.sections;
  if (!rawSections || typeof rawSections !== "object") return { ok: false, reason: "missing top-level sections object" };

  const dropped: DroppedCard[] = [];
  const verificationLog: VerificationLogEntry[] = [];
  const basisDefaulted: BasisDefaultedCard[] = [];

  function validateOne(section: SectionKey, raw: unknown, requireSeverity: boolean): Card | null {
    if (!raw || typeof raw !== "object") {
      dropped.push({ section, title: "(unknown)", reason: "card is not an object" });
      return null;
    }
    const c = raw as Record<string, unknown>;
    const title = typeof c.title === "string" ? c.title.trim() : "";
    if (!title) {
      dropped.push({ section, title: "(untitled)", reason: "missing title" });
      return null;
    }
    const signal = c.signal;
    if (signal !== "bullish" && signal !== "bearish" && signal !== "neutral") {
      dropped.push({ section, title, reason: `invalid signal: ${JSON.stringify(signal)}` });
      return null;
    }
    const argument = typeof c.argument === "string" ? c.argument.trim() : "";
    if (!argument) {
      dropped.push({ section, title, reason: "missing argument" });
      return null;
    }
    const rawBasis = c.basis;
    let basis: CardBasis;
    if (rawBasis === "stated" || rawBasis === "inferred") {
      basis = rawBasis;
    } else {
      basisDefaulted.push({ section, title, rawBasis: JSON.stringify(rawBasis) });
      basis = "inferred";
    }
    const rawEvidence = c.metric_evidence;
    const metricEvidence = Array.isArray(rawEvidence)
      ? rawEvidence.filter((x): x is string => typeof x === "string" && x.trim().length > 0)
      : typeof rawEvidence === "string" && rawEvidence.trim()
        ? [rawEvidence.trim()]
        : [];
    if (metricEvidence.length === 0) {
      dropped.push({ section, title, reason: "missing metric_evidence" });
      return null;
    }
    let severity: CardSeverity | undefined;
    if (requireSeverity) {
      if (c.severity !== "high" && c.severity !== "medium" && c.severity !== "low") {
        dropped.push({ section, title, reason: `red_flags card missing/invalid severity: ${JSON.stringify(c.severity)}` });
        return null;
      }
      severity = c.severity;
    }
    if (basis === "stated") {
      const v = verifyMetricEvidence(metricEvidence, pressText);
      verificationLog.push({ section, title, ...v });
      if (opts.enforceStatedVerification && !v.verified) {
        dropped.push({
          section,
          title,
          reason: `basis="stated" but no metric_evidence figure found in source (checked: [${v.checkedValues.join(", ")}])`,
        });
        return null;
      }
    }
    return { signal, title, argument, metric_evidence: metricEvidence, basis, ...(severity ? { severity } : {}) };
  }

  const sections: CardsPayload["sections"] = {
    ai_generated_insights: [],
    what_changed_this_quarter: [],
    red_flags: [],
    strengths: [],
  };

  for (const key of SECTION_KEYS) {
    const arr = rawSections[key];
    if (!Array.isArray(arr)) continue;
    for (const item of arr) {
      const card = validateOne(key, item, key === "red_flags");
      if (card) (sections[key] as Card[]).push(card);
    }
  }

  // The one code-guaranteed card — never requested of the model.
  sections.red_flags.push(buildPendingLegalStub());

  if (sections.ai_generated_insights.length === 0) {
    return { ok: false, reason: "ai_generated_insights is empty after validation — no usable core theses" };
  }

  const payload: CardsPayload = {
    version: "v1",
    generated_at: new Date().toISOString(),
    stage: "A",
    pending_stage_b: [
      "red_flags: litigation/subsequent events",
      "what_changed_this_quarter: full comparison against last quarter's saved analysis",
    ],
    sections,
  };

  return { ok: true, payload, dropped, verificationLog, basisDefaulted };
}

// Flattened plain-text rendering of a cards payload, generated in code
// (no extra claude -p call) — populates filing_analyses.analysis_text
// (NOT NULL) so the existing AnalysisViewPanel/AiSummaryBadge UI keeps
// showing something readable until it renders cards natively.
export function renderCardsAsText(payload: CardsPayload): string {
  const lines: string[] = [];
  const sectionTitles: Record<SectionKey, string> = {
    ai_generated_insights: "AI GENERATED INSIGHTS",
    what_changed_this_quarter: "WHAT CHANGED THIS QUARTER",
    red_flags: "RED FLAGS",
    strengths: "STRENGTHS",
  };
  for (const key of SECTION_KEYS) {
    const cards = payload.sections[key];
    lines.push(`=== ${sectionTitles[key]} ===`);
    if (cards.length === 0) {
      lines.push("(none)");
    }
    for (const c of cards) {
      if (isPendingStub(c)) {
        lines.push(`- [PENDING 10-Q] ${c.title} — ${c.note}`);
        continue;
      }
      const sevTag = c.severity ? ` [${c.severity.toUpperCase()}]` : "";
      lines.push(`- (${c.signal}${sevTag}, ${c.basis}) ${c.title}`);
      lines.push(`  ${c.argument}`);
      lines.push(`  Evidence: ${c.metric_evidence.join("; ")}`);
    }
    lines.push("");
  }
  return lines.join("\n").trim();
}

// Static prompt template appended to the Analysis Dump's Copy Dump
// output (components/screener-view.tsx's AnalysisDumpTab), pasted into
// an external LLM conversation alongside the preceding data sections
// (HEADER, SELECTED STRIKE, EARNINGS HISTORY, etc. — "the ticker above"
// and "the earnings history above" below refer to those sections at
// paste time, not to anything this app resolves itself).
//
// Hardcoded exported constant, not a DB-backed config: this text will
// change as the flag vocabulary grows, and git history is the desired
// audit trail for that — not a runtime-editable value. Bump
// ANALYSIS_TEMPLATE_VERSION whenever ANALYSIS_TEMPLATE's checklist
// vocabulary changes; it's printed in the dump's HEADER and stored on
// every saved research_analyses row so a past analysis can always be
// traced to the exact vocabulary it was written against.
//
// This template produces advisory-only output: it never feeds the
// numeric grade, never vetoes a trade, and the two are never merged or
// averaged. See lib/research-analysis-parser.ts for how a pasted
// response gets parsed back into structured fields.
//
// 2026-08-11: added RECOMMENDATION / RECOMMENDED_STRIKE / DOWN_CATALYST /
// DOWN_CATALYST_PLAUSIBILITY to the metadata block (audit found PART 2's
// and PART 6's answers were prose-only and couldn't be scored — see
// research_analyses migration 2026-08-11-add-research-analyses-scoring-
// fields.sql).
//
// 2026-08-11 (v6): restructured around one binary question instead of an
// open-ended catch-all. Five names analyzed the same day all got a
// cautious v5 verdict ("take smaller" or "pass") and all would have
// paid — the analysis was re-deriving what the chain already prices
// (cushion, POP, IV) and then hedging on that basis, which isn't a real
// signal at the deltas this strategy trades. v6's Part 2 asks a single
// yes/no question — is there a specific, nameable, non-price reason
// this event's left tail is fatter than the chain implies — and
// LEFT_TAIL_RISK stores the answer (research_analyses migration
// 2026-08-11-add-research-analyses-left-tail-risk.sql) so it can be
// checked against outcomes later. Part 1's checklist items and
// definitions are unchanged, only reframed as evidence-gathering, not
// verdict; Parts 3-6 are shortened on the same theory — a clean setup
// should read short, and length in Part 3's cushion arithmetic instead
// of Part 2's actual risk case was the v5 failure mode.
export const ANALYSIS_TEMPLATE_VERSION = "v6";

// Fixed, not recomputed — the PEER CONTEXT section (AnalysisDumpTab)
// prints this line every time it renders, regardless of what the
// section's own peer list shows that day. It is the result of a
// 2026-09-02 audit: joined earnings_history to itself via theme_members,
// naive method (today's theme membership applied across all stored
// earnings events — see that audit for the bias-corrected cut too,
// n=6/14, too small to report as a rate). n=379 total across both
// groups (peer-crash n=246, no-peer-crash n=133). The point of printing
// this unconditionally is to keep the section's peer list read as
// context a human/LLM reader can weigh, not as an implied signal —
// there is no measured basis for treating a peer's earnings reaction as
// predictive of the subject's own. Do not delete this line to make the
// section read more conclusively; that is exactly the misreading it
// exists to prevent. Update only if a new audit supersedes it, and
// change the wording to match, not just the numbers.
export const PEER_CONTEXT_BASE_RATE_LINE =
  "Base rate: no measured relationship between peer earnings reactions and subject reaction (n=379, median +0.75% vs -0.20%).";

export const ANALYSIS_TEMPLATE = `=== RESEARCH ANALYSIS REQUEST ===

You are reviewing a cash-secured put setup on the ticker above. At the
deltas this strategy trades, the chain already prices a high base-rate win
(call it ~95%). Your job is NOT to re-derive what the chain already knows.
Your job is to find whether there is a specific, nameable reason this
event's left tail is fatter than the chain implies — for a reason that is
NOT in the chain.

The reference strike for this analysis is 2x EM below spot, regardless of
what strike I may actually trade.

ALREADY PRICED — reference in a clause, never re-derive: cushion multiples,
% below spot, x EM, POP, delta, EV, historical move ratios, max downside
ratio, IV level, term structure, IV vs realized, liquidity, spreads, OI.

NOT IN THE CHAIN — this is the entire value of the analysis: consensus vs
management's own guide, growth deceleration across quarters, guidance
beat/miss record, a peer already punished this cycle, event sequencing
(another company reporting inside the hold window), a named short thesis on
a specific disclosure, audit/filing/restatement events landing with the
report, a pre-announcement that moved information into guidance, macro
landing the same session, capital raise risk tied to the print, position
history on this exact ticker at this event.

LENGTH — no target length. A clean setup should produce a short analysis. A
dangerous setup earns more space in Part 2 and nowhere else. If this
analysis is long because Part 3 ran to five paragraphs of cushion
arithmetic, that is the failure mode this version exists to fix.

PART 1 — CHECKLIST (v6)
This is evidence gathering, not the verdict. A fired flag is a prompt to
look for a real risk, not a risk by itself. Report FIRED, CLEAR, N/A, or
UNKNOWN with one line of evidence each, one or two sentences. N/A means the
item does not apply to this company or setup. UNKNOWN means it applies but
could not be determined. Both are valid and useful answers — do not guess.
No editorializing inside the checklist — interpretation belongs in Part 2.

  consensus_above_guide
    Compare analyst consensus to management's OWN guided range, on
    whichever metric the company actually guides (EPS, revenue, bookings,
    origination volume, etc.) — do not assume quarterly EPS. If consensus
    sits at or above the top of that range, the company must beat its own
    high end merely to meet expectations. If the company does not issue
    comparable guidance for this period, answer N/A.

  consecutive_deceleration
    Has revenue or EPS growth decelerated for two or more consecutive
    quarters, including the guided quarter? Report the actual sequence.

  guidance_beat_streak
    Has management beaten the high end of its own guidance, or consensus,
    in each of the recent quarters? Report the actual record (e.g. "beat
    3 of last 4, average surprise +8%"). A long streak is fragile — a
    broken streak reprices hard. Report the record only; do not speculate
    about whether estimates were built on it.

  peer_dropped_on_inline
    Has a sector peer already reported this cycle and been punished for an
    in-line or modestly-beating print? Name the peer and the reaction.

  live_narrative_risk
    Is there an active moat, regulatory, competitive, or accounting question
    that could be confirmed or aggravated by a single answer on the call?

  runup_into_print
    How has the stock moved into this print, over both ~20 trading days and
    from recent lows/highs? A large run-up creates a give-back reservoir
    that stacks on top of any fundamental repricing.

  downside_fat_tail
    In the earnings history above, are the blow-throughs (ratio > 1.0)
    upside or downside? Upside blow-throughs are harmless to a put seller;
    downside ones are the whole risk. Report the max DOWNSIDE ratio
    specifically, not the mean.

PART 2 — THE VERDICT (most important section)
One question: is there a specific, nameable, non-price reason this event's
left tail is fatter than the chain implies?

If NO: say so in two or three sentences, name what could have made it
dangerous and did not, state the strongest counterargument, stop. A short
Part 2 is expected. Do not manufacture concern to fill space. Set
LEFT_TAIL_RISK: no below, and DOWN_CATALYST: none,
DOWN_CATALYST_PLAUSIBILITY: n/a.

If YES, for each risk (rarely more than one): name it in one sentence
specific enough to be wrong; explain why the chain does not price it (if
the answer is "it does, in the IV," it is not a Part 2 risk); state what
would confirm or refute it; give plausibility low / moderate / high with
reasoning. Set LEFT_TAIL_RISK: yes below, and put the single most dangerous
risk in DOWN_CATALYST with its DOWN_CATALYST_PLAUSIBILITY.

The bar for YES is high. Do not list risks true of every earnings event —
"guidance could disappoint" is not a risk, it is the definition of an
earnings event.

If you propose a risk that isn't in the checklist, name it explicitly as a
candidate observation — give it a short snake_case term and put it in
CANDIDATE_OBSERVATIONS below with a one-line definition. If a term you've
used before in a prior analysis applies again, reuse the exact same term
name (no definition needed on reuse — see the response format). Do not coin
an observation for a condition that is already priced in the chain — a term
describing a cushion multiple or IV level is a restatement, not an
observation.

PART 3 — CUSHION
One or two sentences: the strike, its distance in x EM, and the multiple of
this ticker's worst historical down move required to breach it. Note if the
reference strike is untradeable and name one that is. No comparisons to
prior tickers, no multiple framings of the same number unless they
materially disagree.

PART 4 — HONEST UNCERTAINTY
Only what would change the verdict.

PART 5 — DATA GAPS
Only gaps affecting this analysis. Known structural defects mentioned once,
not re-explained every time.

PART 6 — RECOMMENDATION
Three or four sentences: the verdict, the strike it applies to, the single
reason, and what would change the answer. Do not restate Parts 1-5. This is
advisory. It does not override the numeric grade and it does not veto
anything.

Your recommendation must reduce to exactly one take / take_smaller / pass
call and exactly one strike it's about — even if your prose above is
conditional ("take at $X, pass at the reference strike"). Put that single
resolved answer in RECOMMENDATION and RECOMMENDED_STRIKE below.
RECOMMENDED_STRIKE is whichever strike your final call is actually about; it
is often NOT the reference strike above.

=== RESPONSE FORMAT ===
Begin your response with exactly this block, then prose:

=== ANALYSIS METADATA ===
TICKER: <symbol>
EARNINGS_DATE: <YYYY-MM-DD>
FLAGS_FIRED: <comma-separated from the vocabulary above, or \`none\`>
FLAGS_NA: <comma-separated, or \`none\`>
FLAGS_UNKNOWN: <comma-separated, or \`none\`>
CHECKLIST_VERSION: v6
LEFT_TAIL_RISK: <yes | no — Part 2's verdict>
DOWN_CATALYST: <one line — the risk from Part 2, or \`none\` if
  LEFT_TAIL_RISK is no>
DOWN_CATALYST_PLAUSIBILITY: <low | moderate | high, or \`n/a\` if
  LEFT_TAIL_RISK is no>
RECOMMENDATION: <take | take_smaller | pass — your PART 6 answer, resolved
  to exactly one value>
RECOMMENDED_STRIKE: <the strike that recommendation is actually about —
  may differ from the reference strike>
=== END METADATA ===

DICTIONARY USE
The observation dictionary above lists terms used in prior analyses, with
definitions and use counts.

Reuse an existing term ONLY if it means the same thing. If the mechanism you
are describing differs from the definition in any material way, coin a NEW
term with its own definition — do not stretch an existing term to fit.

A term is close but not the same when it describes a similar-looking
condition arising from a different cause, or the same cause producing a
different consequence. Those are different observations and should be
different terms.

Worked example from this dataset: \`em_compressed_vs_history\` describes an
implied move that is low relative to the ticker's own history AND looks like
mispricing. On a ticker pinned to a pending acquisition, the implied move is
also low relative to history — but correctly so, because the price is
anchored to a deal rather than to earnings. Same observable condition,
opposite meaning. That warranted \`pending_acquisition\`, not a reuse.

Do not coin an observation for a condition already priced in the chain — see
NOT IN THE CHAIN above. A term describing a cushion multiple or IV level is
a restatement of what the chain already prices, not an observation.

When you coin a new term, state explicitly what distinguishes it from the
nearest existing term.

CANDIDATE_OBSERVATIONS:
  <one entry per line, snake_case term name, or \`none\`>
  <term_name>: <definition text — REQUIRED the first time you use this
    term. A definition may wrap onto further indented lines like this.>
  <term_you_have_used_before>

Give a definition only the first time a term is used. If you're reusing a
term from an earlier analysis, list the bare term name with no colon and
no definition — a definition on a term that already has one will be read
as a proposed redefinition, not a restatement.

Do not output a letter grade.`;

// The 7 checklist items (Part 1) with their template definitions,
// parsed out of ANALYSIS_TEMPLATE itself rather than duplicated by
// hand — one source of truth, so a future template edit can't silently
// drift the dictionary page's "Checklist Items" section out of sync
// with what the template actually asks for. Parses everything between
// "PART 1 — CHECKLIST" and "PART 2 —": each 2-space-indented bare term
// line starts an item, the following 4-space-indented lines (until the
// next term or the section boundary) are its definition, joined and
// whitespace-collapsed to one line for display.
export type ChecklistItemDefinition = { term: string; definition: string };

function parseChecklistItemDefinitions(template: string): ChecklistItemDefinition[] {
  const start = template.indexOf("PART 1 — CHECKLIST");
  const end = template.indexOf("PART 2 —");
  if (start === -1 || end === -1 || end <= start) return [];
  const section = template.slice(start, end);
  const items: ChecklistItemDefinition[] = [];
  const lines = section.split("\n");
  let current: { term: string; lines: string[] } | null = null;
  const termLineRe = /^  ([a-z][a-z0-9_]*)$/;
  const defLineRe = /^    (.*)$/;
  for (const line of lines) {
    const termMatch = line.match(termLineRe);
    if (termMatch) {
      if (current) items.push({ term: current.term, definition: current.lines.join(" ").replace(/\s+/g, " ").trim() });
      current = { term: termMatch[1], lines: [] };
      continue;
    }
    if (current) {
      const defMatch = line.match(defLineRe);
      if (defMatch) {
        current.lines.push(defMatch[1]);
      } else if (line.trim() === "" && current.lines.length > 0) {
        // Blank line ends the current item's definition (next line is
        // either another term or prose outside the indented block).
        items.push({ term: current.term, definition: current.lines.join(" ").replace(/\s+/g, " ").trim() });
        current = null;
      }
    }
  }
  if (current) items.push({ term: current.term, definition: current.lines.join(" ").replace(/\s+/g, " ").trim() });
  return items;
}

export const CHECKLIST_ITEM_DEFINITIONS: ChecklistItemDefinition[] = parseChecklistItemDefinitions(ANALYSIS_TEMPLATE);

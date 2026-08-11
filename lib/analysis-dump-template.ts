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
// fields.sql). Not a version bump: Part 1's checklist vocabulary is
// unchanged, and these fields follow the same optional-field precedent
// as FLAGS_NA/CANDIDATE_OBSERVATIONS — a pre-2026-08-11 paste simply
// won't have them, which the parser treats as expected absence, not a
// defect.
export const ANALYSIS_TEMPLATE_VERSION = "v5";

export const ANALYSIS_TEMPLATE = `=== RESEARCH ANALYSIS REQUEST ===

You are reviewing a cash-secured put setup on the ticker above. The numeric
grade in this dump is data-derived, and that data is largely already priced
into EM and IV. Your job is NOT to re-derive it. Your job is to find the
setup risks that make the LEFT TAIL fatter than the implied distribution
suggests — the things that would cause the market's own pricing to be wrong.

The reference strike for this analysis is 2x EM below spot, regardless of
what strike I may actually trade.

PART 1 — CHECKLIST (v5)
Check each item. Report FIRED, CLEAR, N/A, or UNKNOWN with one line of
evidence. N/A means the item does not apply to this company or setup.
UNKNOWN means it applies but could not be determined. Both are valid and
useful answers — do not guess.

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

PART 2 — CATCH-ALL (most important section)
The checklist captures what we already learned. This section is where the
next lesson comes from. Answer freely:

  - What is genuinely dangerous about THIS setup that the checklist does not
    ask about?
  - What single event or disclosure on this call would cause the largest
    down move, and how plausible is it? State the catalyst in one line and
    rate its plausibility low / moderate / high — both go in the metadata
    block below (DOWN_CATALYST, DOWN_CATALYST_PLAUSIBILITY) so this answer
    can be checked against what actually happens.
  - What would have to be true for the reference strike to be breached, and
    is there a credible path to it?
  - What is the market apparently NOT worried about that it should be?

If you propose a risk that isn't in the checklist, name it explicitly as a
candidate observation — give it a short snake_case term and put it in
CANDIDATE_OBSERVATIONS below with a one-line definition. If a term you've
used before in a prior analysis applies again, reuse the exact same term
name (no definition needed on reuse — see the response format).

PART 3 — CUSHION MATH
State plainly: what multiple of this ticker's worst historical DOWN move is
required to breach the reference strike? Show the arithmetic.

PART 4 — HONEST UNCERTAINTY
What could you not determine? What are you least confident about? Where
might you be wrong?

PART 5 — DATA GAPS TO FIX
List specifically what would need to be backfilled or corrected in the app
for this analysis to be better next quarter. Be concrete: which quarters,
which fields, which source. If the data is complete, say so.

PART 6 — RECOMMENDATION
Given everything above, state plainly:
  - Would you take this trade at the reference strike? Take / take smaller /
    pass — and why, in one or two sentences.
  - If the reference strike is wrong, name the strike that would work and
    what it costs in premium.
  - What single thing would change your answer?
This is advisory. It does not override the numeric grade and it does not
veto anything.

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
CHECKLIST_VERSION: v5
RECOMMENDATION: <take | take_smaller | pass — your PART 6 answer, resolved
  to exactly one value>
RECOMMENDED_STRIKE: <the strike that recommendation is actually about —
  may differ from the reference strike>
DOWN_CATALYST: <one line — the single disclosure from PART 2 that would
  cause the largest down move>
DOWN_CATALYST_PLAUSIBILITY: <low | moderate | high>
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

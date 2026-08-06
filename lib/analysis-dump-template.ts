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
export const ANALYSIS_TEMPLATE_VERSION = "v2";

export const ANALYSIS_TEMPLATE = `=== RESEARCH ANALYSIS REQUEST ===

You are reviewing a cash-secured put setup on the ticker above. The numeric
grade in this dump is data-derived, and that data is largely already priced
into EM and IV. Your job is NOT to re-derive it. Your job is to find the
setup risks that make the LEFT TAIL fatter than the implied distribution
suggests — the things that would cause the market's own pricing to be wrong.

The reference strike for this analysis is 2x EM below spot, regardless of
what strike I may actually trade.

PART 1 — CHECKLIST (v2)
Check each item. Report FIRED, CLEAR, or UNKNOWN with one line of evidence.
"UNKNOWN" is a valid and useful answer — do not guess.

  consensus_above_guide
    Does analyst consensus sit at or above the top of management's own
    guidance range? If so, the company must beat its own high end merely to
    meet expectations.

  consecutive_deceleration
    Has revenue or EPS growth decelerated for two or more consecutive
    quarters, including the guided quarter? Report the actual sequence.

  guidance_streak_extrapolated
    Has management beaten the high end of its own guidance repeatedly, and
    has the Street extrapolated that streak into current estimates? A broken
    streak reprices hard.

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
    down move, and how plausible is it?
  - What would have to be true for the reference strike to be breached, and
    is there a credible path to it?
  - What is the market apparently NOT worried about that it should be?

If you propose a risk that isn't in the checklist, name it explicitly as a
candidate new flag.

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

=== RESPONSE FORMAT ===
Begin your response with exactly this block, then prose:

=== ANALYSIS METADATA ===
TICKER: <symbol>
EARNINGS_DATE: <YYYY-MM-DD>
FLAGS_FIRED: <comma-separated from the vocabulary above, or \`none\`>
FLAGS_UNKNOWN: <comma-separated, or \`none\`>
CANDIDATE_FLAGS: <new risks you'd propose adding to the checklist, or \`none\`>
CHECKLIST_VERSION: v2
=== END METADATA ===

Do not output a letter grade.`;

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseResearchAnalysisPaste } from "./research-analysis-parser.ts";

const METADATA = `=== ANALYSIS METADATA ===
TICKER: COF
EARNINGS_DATE: 2026-10-20
FLAGS_FIRED: live_narrative_risk
FLAGS_NA: none
FLAGS_UNKNOWN: none
CHECKLIST_VERSION: v6
LEFT_TAIL_RISK: no
DOWN_CATALYST: none
DOWN_CATALYST_PLAUSIBILITY: n/a
RECOMMENDATION: take
RECOMMENDED_STRIKE: 185.00
=== END METADATA ===

PART 1 — CHECKLIST
consensus_above_guide — N/A.

PART 6 — RECOMMENDATION
Take at $185.
`;

test("a Sources: list after a trailing CANDIDATE_OBSERVATIONS 'none' ends the block, not a parse failure", () => {
  const r = parseResearchAnalysisPaste(
    `${METADATA}\nCANDIDATE_OBSERVATIONS:\nnone\n\nSources:\n\nHudson Labs — COF Q3 2026 preview\nCNBC — COF drops 6% on rate-cap call\n`,
  );
  assert.deepEqual(r.candidateObservations, []);
  assert.ok(!r.notes.some((n) => /parse failure|Unrecognized line/.test(n)), r.notes.join("\n"));
  assert.match(r.prose, /Hudson Labs/);
});

test("terms before a markdown **Sources:** heading are still parsed", () => {
  const r = parseResearchAnalysisPaste(
    `${METADATA}\nCANDIDATE_OBSERVATIONS:\nguidance_reaction_precedent\nnew_term: A definition.\n\n**Sources:**\n- [x](https://example.com)\n`,
  );
  assert.deepEqual(
    r.candidateObservations.map((o) => o.term),
    ["guidance_reaction_precedent", "new_term"],
  );
});

test("a real unrecognized line inside the block still reports a parse failure", () => {
  const r = parseResearchAnalysisPaste(`${METADATA}\nCANDIDATE_OBSERVATIONS:\n- Not A Term Line\n`);
  assert.ok(r.notes.some((n) => /parse failure/.test(n)));
});

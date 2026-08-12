-- v6 template restructuring (lib/analysis-dump-template.ts): replaces
-- v5's open-ended catch-all with one binary question -- is there a
-- specific, nameable, non-price reason this event's left tail is
-- fatter than the chain implies. This is the field the prediction log
-- actually scores; everything else in Part 2 (down_catalyst,
-- down_catalyst_plausibility) is detail hanging off this answer.
--
-- Native boolean, not text+check like recommendation/
-- down_catalyst_plausibility: a boolean column's type already
-- constrains it to true/false/null, so a CHECK constraint restating
-- that would be dead weight, not defense.
--
-- Nullable, no default: every existing row (v5 and earlier) has no
-- opinion on this question and must keep loading/rendering unchanged.
alter table research_analyses
  add column if not exists left_tail_risk boolean;

-- v6's Part 2 sets DOWN_CATALYST_PLAUSIBILITY to 'n/a' when
-- LEFT_TAIL_RISK is 'no' (there's no catalyst to rate). The existing
-- check (2026-08-11-add-research-analyses-scoring-fields.sql) only
-- allowed low/moderate/high -- widen it rather than drop it, so a
-- genuinely malformed value still gets rejected.
alter table research_analyses
  drop constraint if exists research_analyses_down_catalyst_plausibility_check;

alter table research_analyses
  add constraint research_analyses_down_catalyst_plausibility_check
  check (down_catalyst_plausibility is null or down_catalyst_plausibility in ('low', 'moderate', 'high', 'n/a'));

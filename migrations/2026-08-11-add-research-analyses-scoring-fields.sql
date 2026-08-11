-- Four fields the analysis prose already produces in prose form but that
-- can't be scored without a structured column (audit: 2026-08-11).
--
-- recommendation: the take/pass/take-smaller call. Prose does not reduce
-- to one value reliably — two existing analyses (ABNB, TXRH) say take at
-- one strike and pass at another. This column is the LLM's own
-- structured answer, not a derivation from prose.
--
-- recommended_strike: the strike the recommendation is actually about,
-- which may differ from reference_strike (2x EM below spot, fixed by
-- the template regardless of what strike the analysis actually
-- recommends). Both are kept — recommended_strike is not a replacement
-- for reference_strike, it's what the recommendation is scored against.
--
-- down_catalyst / down_catalyst_plausibility: PART 2 of the template
-- already asks "What single event or disclosure on this call would
-- cause the largest down move, and how plausible is it?" — prose only,
-- ungraded. down_catalyst_plausibility is the calibration test: CRWV
-- and SMCI's analyses (2026-08-11) both named catalysts rated
-- moderate-to-high; neither fired and both stocks rose double digits.
-- Whether these ratings are calibrated is only testable once the rating
-- itself is stored alongside the outcome.
--
-- All four nullable, no default — every existing row has none of them
-- and must keep loading/rendering exactly as before. None of
-- flags_fired/flags_na/flags_unknown or any other existing column is
-- touched.
alter table research_analyses
  add column if not exists recommendation text,
  add column if not exists recommended_strike numeric,
  add column if not exists down_catalyst text,
  add column if not exists down_catalyst_plausibility text;

alter table research_analyses
  add constraint research_analyses_recommendation_check
  check (recommendation is null or recommendation in ('take', 'take_smaller', 'pass'));

alter table research_analyses
  add constraint research_analyses_down_catalyst_plausibility_check
  check (down_catalyst_plausibility is null or down_catalyst_plausibility in ('low', 'moderate', 'high'));

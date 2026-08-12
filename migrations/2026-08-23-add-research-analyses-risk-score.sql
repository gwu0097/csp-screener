-- Risk Score storage (Tradable Grade + Risk Score restructure). Frozen
-- at the same moment and via the same first-write-wins mechanism as
-- every other *_at_analysis snapshot column (see freezeField in
-- app/api/screener/research-analysis/route.ts) — "a 40 in September and
-- a 40 in December are not comparable unless the weights are frozen
-- with the row." risk_contributions carries each item's own n/effect/
-- confidence/points as computed at save time (lib/risk-score.ts), so a
-- later change to the frozen config constants never silently changes
-- what an already-saved row reads as.
alter table research_analyses
  add column if not exists risk_score_at_analysis integer,
  add column if not exists risk_contributions_at_analysis jsonb,
  add column if not exists risk_config_version_at_analysis text;

-- Links an analysis to the position it actually preceded. The audit
-- (2026-08-11) found the symbol+earnings_date join from research_analyses
-- to positions is ambiguous — CRWV had 5 candidate strikes opened near
-- one analysis, APP had 3 — so "which analysis preceded this trade"
-- doesn't resolve to one row without an explicit link.
--
-- Nullable by design: most analyses are passes with no position opened.
-- ON DELETE SET NULL rather than restrict/cascade — deleting the
-- position (e.g. a bad import cleanup) shouldn't take the analysis
-- down with it; the analysis is still a valid record of what was
-- reasoned through even if the trade record it pointed to is gone.
-- Same FK shape as positions.earnings_history_id (migrations/2026-07-06-
-- add-positions-earnings-history-id.sql), just the reverse direction.
alter table research_analyses
  add column if not exists position_id uuid
  references positions(id) on delete set null;

create index if not exists research_analyses_position_id_idx
  on research_analyses (position_id)
  where position_id is not null;

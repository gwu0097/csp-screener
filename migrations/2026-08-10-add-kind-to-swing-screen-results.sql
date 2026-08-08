-- swing_screen_results has always been truncate-and-insert (one row per
-- user, replaced on every save) for the four existing tabs. The new RS
-- Pullback tab needs its results appended instead — a name that's
-- leading-but-extended today and lands in the entry zone two weeks later
-- is the pullback actually forming, and that's only visible if past runs
-- aren't overwritten.
--
-- `kind` distinguishes the two write patterns in the same table rather
-- than adding a whole new table: existing rows (and all future writes
-- from the unchanged legacy save path) default to 'kind' = 'legacy' and
-- keep truncate+insert semantics exactly as before. New 'rs_pullback'
-- rows are insert-only, one per run, never deleted.
alter table swing_screen_results add column if not exists kind text not null default 'legacy';

create index if not exists idx_swing_screen_results_kind
  on swing_screen_results (user_id, kind, screened_at desc);

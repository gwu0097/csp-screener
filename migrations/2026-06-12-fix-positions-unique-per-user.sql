-- Multi-tenancy follow-up: positions_options_unique_idx was a unique
-- INDEX (not a table constraint, so the 2026-06-10 constraint sweep
-- missed it) on (symbol, strike, expiry, broker). Without user_id two
-- users couldn't hold the same contract. Rebuilt per-user.
DROP INDEX IF EXISTS positions_options_unique_idx;
CREATE UNIQUE INDEX positions_options_unique_idx
  ON public.positions USING btree (user_id, symbol, strike, expiry, broker)
  WHERE ((position_type IS NULL) OR (position_type = 'option'::text));

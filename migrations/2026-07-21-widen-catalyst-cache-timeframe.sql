-- Buy Zone's "upcoming catalyst" lookup reuses the existing
-- catalyst_cache table/TTL pattern (same table, same
-- askPerplexityRaw call, just a new bucket) instead of a parallel
-- cache. timeframe was VARCHAR(2) CHECK IN ('1d','1w','1m') — widen
-- to fit 'upcoming' and extend the CHECK. Additive only, no existing
-- rows touched.
ALTER TABLE catalyst_cache ALTER COLUMN timeframe TYPE VARCHAR(20);
ALTER TABLE catalyst_cache DROP CONSTRAINT IF EXISTS catalyst_cache_timeframe_check;
ALTER TABLE catalyst_cache
  ADD CONSTRAINT catalyst_cache_timeframe_check
  CHECK (timeframe IN ('1d', '1w', '1m', 'upcoming'));

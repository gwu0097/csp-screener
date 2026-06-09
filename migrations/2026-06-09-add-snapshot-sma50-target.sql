-- Extend the snapshot with the two fields swings/discover needs so it can
-- read from the cache instead of calling Yahoo directly: 50-day SMA (+ %)
-- and analyst mean target (+ upside %). Both come from the existing
-- getQuoteEnrichment payload — no new Yahoo calls. Nullable; existing
-- rows fill on their next 15-min refresh.
ALTER TABLE symbol_market_snapshot
  ADD COLUMN IF NOT EXISTS sma50 NUMERIC,
  ADD COLUMN IF NOT EXISTS vs_sma50_pct NUMERIC,
  ADD COLUMN IF NOT EXISTS analyst_target NUMERIC,
  ADD COLUMN IF NOT EXISTS upside_to_target NUMERIC;

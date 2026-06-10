-- Persist the 90-day daily OHLC series the snapshot refresh already
-- fetches for RSI/SMA20, so the Deep Research price chart can render
-- from the cache without a new Yahoo call. JSONB array of
-- { date, open, high, low, close }. Nullable; existing rows fill on
-- their next 15-min refresh.
ALTER TABLE symbol_market_snapshot
  ADD COLUMN IF NOT EXISTS historical_90d JSONB;

-- MACD (12/26/9), derived from the same closes90 series RSI already
-- uses — no new Yahoo calls. macd_history holds the last ~10 daily
-- {macd,signal,histogram} points (oldest first) so the Buy Zone
-- scorer can detect a recent cross / histogram trend without
-- re-fetching bars. Nullable; existing rows fill on their next
-- refresh.
ALTER TABLE symbol_market_snapshot
  ADD COLUMN IF NOT EXISTS macd_line NUMERIC,
  ADD COLUMN IF NOT EXISTS macd_signal NUMERIC,
  ADD COLUMN IF NOT EXISTS macd_histogram NUMERIC,
  ADD COLUMN IF NOT EXISTS macd_history JSONB;

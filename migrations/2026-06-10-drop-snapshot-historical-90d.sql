-- Revert 2026-06-10-add-snapshot-historical-90d: the Deep Research
-- chart moved to a TradingView embed (serves its own data), so the
-- persisted 90-day OHLC series is dead weight (~66 bars JSONB per
-- symbol) and nothing populates it anymore. Pure derived cache — safe
-- to drop.
ALTER TABLE symbol_market_snapshot
  DROP COLUMN IF EXISTS historical_90d;

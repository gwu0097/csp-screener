-- Central per-symbol market snapshot cache. Phase 1 foundation: one row
-- per symbol holding price / technicals / fundamentals / returns, written
-- by lib/market-snapshot.ts and read (eventually) by every feature
-- instead of hitting Yahoo directly. last_refreshed_at drives the TTL.
CREATE TABLE IF NOT EXISTS symbol_market_snapshot (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol VARCHAR(10) NOT NULL UNIQUE,

  -- Price
  price NUMERIC,
  change_pct NUMERIC,        -- today %
  change_amt NUMERIC,        -- today $

  -- 52W
  week52_high NUMERIC,
  week52_low NUMERIC,
  pct_from_52w_high NUMERIC,

  -- Moving averages
  sma200 NUMERIC,
  vs_sma200_pct NUMERIC,     -- % above/below
  sma20 NUMERIC,             -- for swing entry signals
  vs_sma20_pct NUMERIC,

  -- RSI (14-day)
  rsi14 NUMERIC,

  -- Fundamentals
  trailing_pe NUMERIC,
  forward_pe NUMERIC,
  peg_ratio NUMERIC,
  market_cap NUMERIC,

  -- Returns
  return_3m NUMERIC,         -- 3-month price return %
  return_1y NUMERIC,         -- 1-year return %
  return_3y NUMERIC,         -- 3-year return %
  vs_spy_3y NUMERIC,         -- vs SPY 3Y return

  -- 5-day price history for pullback detection
  -- [{date, close, change_pct}]
  price_history_5d JSONB,

  -- Metadata
  last_refreshed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  refresh_source VARCHAR(20) DEFAULT 'yahoo'
);

CREATE INDEX IF NOT EXISTS idx_symbol_snapshot_symbol
  ON symbol_market_snapshot (symbol);

CREATE INDEX IF NOT EXISTS idx_symbol_snapshot_refreshed
  ON symbol_market_snapshot (last_refreshed_at DESC);

-- 2026-08-03 — post-earnings drift study support.
-- Append-only per-symbol-event daily price path: raw Yahoo closes for
-- trading_day_offset -5..+20 relative to each earnings_history event.
-- trading_day_offset 0 = the first actual trading day on/after
-- earnings_date (NOT a BMO/AMC-aware "reaction day" — see
-- scripts/backfill-earnings-price-paths.ts header for why: the
-- existing earnings_history.timing column is null on ~97% of rows,
-- so baking a reaction-day assumption into the offset would silently
-- encode an unverifiable guess for almost the whole table. Consumers
-- that need the true reaction bar must re-derive BMO/AMC themselves).
--
-- close       = Yahoo's standard close (split-adjusted only, Yahoo's
--               own convention — NOT dividend-adjusted).
-- adj_close   = split AND dividend adjusted (Yahoo's adjClose).
-- Both stored raw; no returns/derived values are persisted here.
CREATE TABLE IF NOT EXISTS earnings_price_paths (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  earnings_history_id UUID REFERENCES earnings_history(id) ON DELETE CASCADE,
  symbol              TEXT NOT NULL,
  earnings_date       DATE NOT NULL,
  trading_day_offset  INTEGER NOT NULL CHECK (trading_day_offset BETWEEN -5 AND 20),
  trade_date          DATE NOT NULL,
  close               NUMERIC,
  adj_close           NUMERIC,
  volume              BIGINT,
  price_source        TEXT NOT NULL DEFAULT 'yahoo',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (symbol, earnings_date, trading_day_offset)
);

CREATE INDEX IF NOT EXISTS earnings_price_paths_symbol_date_idx
  ON earnings_price_paths (symbol, earnings_date);

CREATE INDEX IF NOT EXISTS earnings_price_paths_history_id_idx
  ON earnings_price_paths (earnings_history_id)
  WHERE earnings_history_id IS NOT NULL;

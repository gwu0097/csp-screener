-- 2026-06-02 — Perplexity catalyst analysis cache for the long-term
-- watchlist. Each row is keyed on (symbol, timeframe) and stores the
-- LLM's plain-text analysis + a coarse hold/add/trim/cut signal it
-- extracted. fetched_at drives the 24h TTL on the API side.

CREATE TABLE IF NOT EXISTS catalyst_cache (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol VARCHAR(10) NOT NULL,
  timeframe VARCHAR(2) NOT NULL CHECK (timeframe IN ('1d', '1w', '1m')),
  change_pct NUMERIC,
  analysis TEXT,
  signal VARCHAR(10),
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (symbol, timeframe)
);

CREATE INDEX IF NOT EXISTS idx_catalyst_cache_fetched_at
  ON catalyst_cache (fetched_at DESC);

-- Digest cache: one row per (week, symbol-bucket) keying the
-- aggregated weekly digest so we don't hit Perplexity on every load.
CREATE TABLE IF NOT EXISTS longterm_digest_cache (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cache_key VARCHAR(64) NOT NULL UNIQUE,
  payload JSONB NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

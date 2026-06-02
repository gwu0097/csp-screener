-- 2026-06-01 — long-term portfolio watchlist.
-- One row per symbol with an allocation bucket the user maintains
-- alongside live Yahoo quote data on the page. Symbol is unique so
-- the POST path can rely on the constraint for duplicate detection.
--
-- Run in Supabase SQL editor before deploying. The /api/longterm/watchlist
-- route and the /longterm/watchlist page both expect this table.

CREATE TABLE IF NOT EXISTS long_term_watchlist (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol VARCHAR(10) NOT NULL UNIQUE,
  allocation VARCHAR(10) NOT NULL
    CHECK (allocation IN ('Large', 'Medium', 'Small')),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_long_term_watchlist_allocation
  ON long_term_watchlist (allocation);

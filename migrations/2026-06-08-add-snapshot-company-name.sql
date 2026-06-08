-- Phase 2: the long-term watchlist renders a company-name column, so the
-- snapshot needs to carry it (the cache replaces the per-row Yahoo quote
-- that previously supplied companyName). Nullable — existing rows fill it
-- on their next refresh.
ALTER TABLE symbol_market_snapshot
  ADD COLUMN IF NOT EXISTS company_name TEXT;

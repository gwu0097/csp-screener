-- Multi-tenancy: user_id on every personal-data table, backfilled to
-- the admin user (the pre-multi-tenant owner) so nothing is lost.
-- Shared market/research tables are untouched. Constraint rebuilds:
-- watchlist's PK was (symbol) and two symbol-unique keys must become
-- per-user.
--
-- Admin user id: abfe5a91-6b34-4227-a60d-71c9249b372d

DO $$
DECLARE
  admin_id UUID := 'abfe5a91-6b34-4227-a60d-71c9249b372d';
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'positions', 'fills', 'position_snapshots', 'watchlist',
    'tracked_tickers', 'swing_ideas', 'swing_trades',
    'screener_results', 'swing_screen_results', 'long_term_watchlist',
    'longterm_ideas', 'filing_notes', 'post_earnings_recommendations'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS user_id UUID', t);
    EXECUTE format('UPDATE %I SET user_id = %L WHERE user_id IS NULL', t, admin_id);
    EXECUTE format('ALTER TABLE %I ALTER COLUMN user_id SET NOT NULL', t);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_%s_user_id ON %I (user_id)', t, t);
  END LOOP;
END $$;

-- watchlist: PK was (symbol) — one row per symbol globally. Per-user now.
ALTER TABLE watchlist DROP CONSTRAINT IF EXISTS watchlist_pkey;
ALTER TABLE watchlist ADD PRIMARY KEY (user_id, symbol);

-- long_term_watchlist: UNIQUE(symbol) → UNIQUE(user_id, symbol).
ALTER TABLE long_term_watchlist
  DROP CONSTRAINT IF EXISTS long_term_watchlist_symbol_key;
ALTER TABLE long_term_watchlist
  ADD CONSTRAINT long_term_watchlist_user_symbol_key UNIQUE (user_id, symbol);

-- tracked_tickers: UNIQUE(symbol, expiry, screened_date) → + user_id.
ALTER TABLE tracked_tickers
  DROP CONSTRAINT IF EXISTS tracked_tickers_symbol_expiry_screened_date_key;
ALTER TABLE tracked_tickers
  ADD CONSTRAINT tracked_tickers_user_symbol_expiry_screened_date_key
  UNIQUE (user_id, symbol, expiry, screened_date);

-- post_earnings_recommendations UNIQUE(position_id, analysis_day) is
-- already user-scoped transitively through positions — unchanged.

-- Multiple named watchlists per user. The existing single
-- long_term_watchlist becomes each user's "Portfolio" watchlist —
-- special: non-deletable, keeps allocation/flags/action/catalyst/
-- digest. New watchlists are simpler (symbol + thesis note + Buy
-- Zone only, no allocation).
--
-- Additive + backfill only — no existing long_term_watchlist rows
-- are dropped or altered beyond gaining a watchlist_id pointer.

CREATE TABLE IF NOT EXISTS watchlists (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  name VARCHAR(100) NOT NULL,
  is_portfolio BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_watchlists_user_id ON watchlists (user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_watchlists_user_name
  ON watchlists (user_id, lower(name));
-- At most one Portfolio watchlist per user.
CREATE UNIQUE INDEX IF NOT EXISTS idx_watchlists_one_portfolio
  ON watchlists (user_id) WHERE is_portfolio;

-- Backfill: one Portfolio watchlist for every user who already has
-- long_term_watchlist rows.
INSERT INTO watchlists (user_id, name, is_portfolio)
SELECT DISTINCT user_id, 'Portfolio', TRUE
FROM long_term_watchlist
ON CONFLICT DO NOTHING;

ALTER TABLE long_term_watchlist ADD COLUMN IF NOT EXISTS watchlist_id UUID;

UPDATE long_term_watchlist ltw
SET watchlist_id = w.id
FROM watchlists w
WHERE w.user_id = ltw.user_id AND w.is_portfolio
  AND ltw.watchlist_id IS NULL;

ALTER TABLE long_term_watchlist ALTER COLUMN watchlist_id SET NOT NULL;
ALTER TABLE long_term_watchlist
  DROP CONSTRAINT IF EXISTS long_term_watchlist_watchlist_id_fkey;
ALTER TABLE long_term_watchlist
  ADD CONSTRAINT long_term_watchlist_watchlist_id_fkey
  FOREIGN KEY (watchlist_id) REFERENCES watchlists(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_long_term_watchlist_watchlist_id
  ON long_term_watchlist (watchlist_id);

-- Allocation only applies to Portfolio items now — custom watchlists
-- don't set it. Existing CHECK already passes NULL through.
ALTER TABLE long_term_watchlist ALTER COLUMN allocation DROP NOT NULL;

-- Symbol uniqueness is now per-watchlist, not per-user — the same
-- symbol can live in Portfolio AND a custom watchlist.
ALTER TABLE long_term_watchlist
  DROP CONSTRAINT IF EXISTS long_term_watchlist_user_symbol_key;
ALTER TABLE long_term_watchlist
  ADD CONSTRAINT long_term_watchlist_watchlist_symbol_key
  UNIQUE (watchlist_id, symbol);

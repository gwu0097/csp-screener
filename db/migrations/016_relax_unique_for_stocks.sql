-- Phase B follow-up to migration 015. The unique constraint
-- positions_symbol_strike_expiry_broker_key was added when only
-- option rows lived in the table — strike+expiry made sense as
-- part of the natural key. After 015 the table also holds stock
-- rows where strike and expiry don't apply, and stock rows with the
-- same (symbol, broker) would collide.
--
-- Replace the constraint with a partial unique index that scopes
-- only to option rows. Stock rows are free to share keys.

ALTER TABLE positions
  DROP CONSTRAINT IF EXISTS positions_symbol_strike_expiry_broker_key;

CREATE UNIQUE INDEX IF NOT EXISTS positions_options_unique_idx
  ON positions (symbol, strike, expiry, broker)
  WHERE position_type IS NULL OR position_type = 'option';

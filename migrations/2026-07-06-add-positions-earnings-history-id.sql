-- Trade→event spine: link a position to the earnings event it was
-- traded around. Stamped by the T0 capture cron (lib/earnings-capture)
-- on every open option position whose expiry spans the event. Nullable
-- — manual trades with no matching event simply stay unlinked.
ALTER TABLE positions
  ADD COLUMN IF NOT EXISTS earnings_history_id uuid
  REFERENCES earnings_history(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS positions_earnings_history_id_idx
  ON positions (earnings_history_id)
  WHERE earnings_history_id IS NOT NULL;

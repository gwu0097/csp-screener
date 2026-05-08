-- Assignment-flow support + stock-position rows.
--
-- position_type lets the positions table hold both option rows
-- (default, all existing rows) and stock rows created from option
-- assignment ('stock_long' / 'stock_short'). assignment_source_id
-- backlinks an assigned-out stock position to the option it came
-- from so the UI can show that lineage.

ALTER TABLE positions
  ADD COLUMN IF NOT EXISTS position_type text DEFAULT 'option';
-- values: 'option' | 'stock_long' | 'stock_short'

ALTER TABLE positions
  ADD COLUMN IF NOT EXISTS assignment_source_id uuid REFERENCES positions(id);

CREATE INDEX IF NOT EXISTS positions_type_idx
  ON positions (position_type);

-- Per-import grouping for the "Undo last import" feature on the
-- Positions page. bulk-create stamps every NEW position and every
-- fill (always — fills are always fresh rows in a bulk-create call)
-- with a single batch_id so the user can undo recent imports cleanly.
--
-- Nullable: existing rows aren't backfilled and undo only covers
-- imports made after this migration runs. Pre-existing positions are
-- invisible to the import-batches API.

ALTER TABLE positions
  ADD COLUMN IF NOT EXISTS import_batch_id uuid;

ALTER TABLE fills
  ADD COLUMN IF NOT EXISTS import_batch_id uuid;

CREATE INDEX IF NOT EXISTS positions_import_batch_idx
  ON positions (import_batch_id);

CREATE INDEX IF NOT EXISTS fills_import_batch_idx
  ON fills (import_batch_id);

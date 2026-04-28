-- Run in Supabase SQL editor.
-- Adds a `graded` flag to screener_results so the cross-device
-- hydration UI can distinguish a Screen-Today snapshot (Stage 1+2
-- only — fast filters, no analysis) from a Run-Analysis snapshot
-- (Stage 3 + 4 grades attached). The hydration banner needs to
-- tell the user "Run Analysis to grade" when the latest row is
-- ungraded.
--
-- Defaults to false so existing rows (saved before this column
-- existed) read as ungraded — safe; the next Run Analysis will
-- re-save with graded=true.

alter table screener_results
  add column if not exists graded boolean default false;

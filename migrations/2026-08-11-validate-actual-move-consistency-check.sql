-- The 22 rows that violated earnings_history_actual_move_consistency_check
-- when it was added NOT VALID (migrations/2026-08-11-add-actual-move-
-- consistency-check.sql) have all been repaired: their price_before/
-- price_after were same-session phantom snapshots from the pre-
-- 2026-07-30 T0/T1 session-gate bug (commits 6baeb63, 1fa74dc),
-- recomputed from bars using each row's own confirmed timing;
-- actual_move_pct was already correct on every one and was left
-- untouched. A fresh table-wide scan after the repair found zero
-- remaining mismatches.
--
-- Validates the constraint against the full table now that nothing
-- violates it, so it's enforced everywhere, not just on writes from
-- the moment it was added.
alter table earnings_history
  validate constraint earnings_history_actual_move_consistency_check;

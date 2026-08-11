-- Guards against price_before/price_after and actual_move_pct silently
-- diverging on the same row. Every write path that computes both
-- together (captureEarningsT1, updateEncyclopedia, the manual-move
-- backfill scripts) derives actual_move_pct as exactly
-- (price_after - price_before) / price_before in the same statement,
-- so the only way they disagree is a PARTIAL write -- something
-- updates one without the other. That's exactly what happened to
-- TXRH@2025-11-06 (audit: 2026-08-11): the manual-update route
-- (app/api/screener/earnings-history/update/route.ts) only ever writes
-- implied_move_pct/actual_move_pct/move_ratio/implied_move_source/
-- is_complete -- never price fields -- so a hand-typed correction
-- silently orphaned itself from whatever prices the row already had.
-- Found by accident; this constraint would have caught it at write
-- time instead.
--
-- Added NOT VALID: 22 existing rows (1 sign-flip, 21 magnitude
-- mismatches concentrated in schwab/schwab_t0 implied_move_source,
-- likely stale same-session price snapshots rather than a real
-- disagreement -- under separate diagnosis) currently violate this.
-- NOT VALID skips checking those on add, but still enforces on every
-- INSERT/UPDATE from this point forward -- new writes are protected
-- immediately without blocking on the backlog. Run `alter table
-- earnings_history validate constraint
-- earnings_history_actual_move_consistency_check;` once the 22 rows
-- are resolved one way or the other.
alter table earnings_history
  add constraint earnings_history_actual_move_consistency_check
  check (
    price_before is null or price_after is null or actual_move_pct is null or price_before = 0
    or abs((price_after - price_before) / price_before - actual_move_pct) < 0.005
  ) not valid;

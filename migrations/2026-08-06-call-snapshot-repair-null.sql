-- Repairs the corrupted covered-call position_snapshots rows backed up
-- in 2026-08-06-call-snapshot-repair-backup.sql. Nulls only the fields
-- that were derived from the (wrong-side) option contract lookup:
-- option_price, current_delta, current_iv, current_theta,
-- pct_premium_remaining, pnl_pct, pnl_dollars. stock_price,
-- actual_move_pct, move_ratio, days_since_entry, and close_snapshot are
-- untouched — none of them depend on which side of the chain was read,
-- so they were always correct.
--
-- Nulled rather than recomputed: there is no way to re-fetch the
-- options chain AS IT WAS at each historical snapshot_time. Recomputing
-- against a CURRENT chain quote would pair a stale stock_price with a
-- live option price/delta — internally inconsistent and worse than
-- leaving it blank. Nulling lets the fixed writer (option_type now
-- selected, contractType="ALL", strikeCount=200) recompute these
-- correctly on its next scheduled run.
update position_snapshots ps
set option_price = null,
    current_delta = null,
    current_iv = null,
    current_theta = null,
    pct_premium_remaining = null,
    pnl_pct = null,
    pnl_dollars = null
from positions p
where p.id = ps.position_id
  and p.option_type = 'call'
  and ps.current_delta is not null
  and ps.current_delta < 0;

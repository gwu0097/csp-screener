-- Drift-study exclusion marker distinct from price_repair_status: this
-- one is about TIMING confidence, not price provenance. Set on rows
-- where the price repair's alternate-interpretation check found a
-- materially bigger move under the unassigned BMO/AMC reading but not
-- big/clear enough to auto-flip (medium confidence, 5-15x ratio) — the
-- assigned timing was left as-is, but a drift study may want to treat
-- it as uncertain rather than silently trust it.
alter table earnings_history
  add column if not exists timing_review_status text;

alter table earnings_history
  add constraint earnings_history_timing_review_status_check
  check (timing_review_status is null or timing_review_status in (
    'flagged_uncertain'
  ));

-- Backup before flipping the 16 high-confidence timing rows.
create table if not exists backup_20260803_earnings_history_timing_flip as
select * from earnings_history where false;

-- One-time backfill ahead of widening the "unresolved" panel into a
-- general Schwab activity review feed (successes + errors, not just
-- errors). Without this, every already-known success the poller has
-- ever recorded (dismissed defaults to false) would flood the panel
-- on first load. Error rows and skipped_duplicate rows are left
-- untouched — those are still genuinely unresolved and should surface
-- exactly as they did before this change.
update schwab_account_transactions
set dismissed = true,
    dismissed_reason = 'backfill_predates_review_feature'
where processed = true
  and dismissed = false
  and process_outcome in (
    'submitted',
    'submitted_manually', -- legacy: hand-set via SQL before this dismiss mechanism existed
    'expired',
    'assigned',
    'skipped_no_leg',
    'skipped_unhandled_leg',
    'skipped_unhandled',
    'skipped_irrelevant_type'
  );

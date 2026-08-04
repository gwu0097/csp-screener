-- Drift-study exclusion marker for the earnings_history price repair.
-- null = untouched by this migration (out of scope, or no timing
-- assigned to determine which trading-day offsets to use).
-- 'repaired' = price_before/price_after re-derived from
-- earnings_price_paths and written.
-- 'excluded_wild_divergence' = re-derived price differs from the
-- stored value by more than the 50% threshold (justified against the
-- full dataset's one-trading-day-return distribution, max 40.4%,
-- p99.9 36.5%, n=5178) — not explainable by BMO/AMC ambiguity alone,
-- so left unchanged rather than guessed at.
-- 'excluded_no_coverage' = earnings_price_paths has no row at the
-- offset(s) the assigned timing needs.
alter table earnings_history
  add column if not exists price_repair_status text;

alter table earnings_history
  add constraint earnings_history_price_repair_status_check
  check (price_repair_status is null or price_repair_status in (
    'repaired',
    'excluded_wild_divergence',
    'excluded_no_coverage'
  ));

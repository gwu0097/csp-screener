-- Two structural fixes to the eps-sweep pipeline, grounded in the
-- 2026-09-02 early-capture audit (EDGAR_EARNINGS_DATE_SPEC.md's companion
-- follow-up, see repo root):
--
-- 1. last_verified_at closes the 518-row permanent-freeze guard problem:
--    today, eps_surprise_pct IS NULL is the ONLY signal eps-sweep uses to
--    decide a row needs (re)checking, so once any value lands there --
--    right or wrong -- the row becomes permanently invisible to the sweep,
--    even after fiscal_quarter is later corrected (confirmed: 518 of the
--    713 EDGAR-resolved rows have never had a single eps-sweep attempt
--    logged, because their eps_surprise_pct was already non-null before
--    the fiscal-period repair ran). last_verified_at records the last time
--    eps-sweep actually completed a check against available Finnhub data
--    for a row (captured or no_period_match -- not finnhub_empty, which
--    means there was nothing to check yet). The sweep can then compare
--    this against when fiscal_quarter was last (re)resolved and re-check
--    only rows that changed underneath a stale verification, instead of
--    rebuilding the same freeze this migration is meant to close.
alter table earnings_history add column if not exists last_verified_at timestamptz;

comment on column earnings_history.last_verified_at is
  'Last time eps-sweep completed a real check (captured a match, or '
  'confirmed no_period_match) against available Finnhub data for this row. '
  'NULL means never checked under this regime -- distinct from '
  'eps_surprise_pct being null, which only means no value was ever '
  'written and misses rows whose fiscal_quarter was corrected after an '
  'early value already landed. See lib/eps-sweep.ts.';

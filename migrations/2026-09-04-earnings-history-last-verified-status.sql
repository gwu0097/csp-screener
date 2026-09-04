-- last_verified_at (2026-09-02) records WHEN eps-sweep last completed a
-- check, but not WHAT it concluded: "captured" (Finnhub matched, the row's
-- eps_estimate/eps_actual/eps_surprise_pct were written or rewritten) and
-- "no_period_match" (Finnhub had data but nothing matched this row's
-- fiscal_quarter/fiscal_year or period_end -- a completed, inconclusive
-- check, not a confirmation either way) both stamp last_verified_at
-- identically. Anyone reading last_verified_at alone as "this row's EPS
-- data is trustworthy" can't tell those apart -- a no_period_match row
-- was checked and left exactly as it was before, right or wrong.
--
-- last_verified_status carries that distinction on earnings_history
-- itself, mirroring earnings_capture_attempts.outcome's own vocabulary at
-- the two sites that stamp last_verified_at (lib/eps-sweep.ts) rather than
-- requiring a join to earnings_capture_attempts to answer "was this row
-- actually corrected, or just checked and left alone."
alter table earnings_history add column if not exists last_verified_status text
  check (last_verified_status is null or last_verified_status in ('captured', 'no_period_match'));

comment on column earnings_history.last_verified_status is
  'What the last_verified_at check concluded: ''captured'' (Finnhub '
  'matched, eps_estimate/eps_actual/eps_surprise_pct written) or '
  '''no_period_match'' (Finnhub had data but nothing matched this row''s '
  'fiscal identifiers -- checked, left unchanged). NULL whenever '
  'last_verified_at is NULL. See lib/eps-sweep.ts.';

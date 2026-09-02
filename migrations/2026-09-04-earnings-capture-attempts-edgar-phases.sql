-- Adds the two EDGAR-integration phases to earnings_capture_attempts'
-- capture_phase CHECK constraint, so lib/edgar-client.ts's
-- recordEdgarAttempt can log attempts the same way T0/T1/eps-sweep
-- already do. Needed by both the fiscal_quarter backfill
-- (edgar-fiscal-period) and the queued earnings-date-resolution work
-- (edgar-earnings-date) sharing this one client module.
alter table earnings_capture_attempts drop constraint earnings_capture_attempts_capture_phase_check;
alter table earnings_capture_attempts
  add constraint earnings_capture_attempts_capture_phase_check
  check (capture_phase = any (array['t0', 't1', 'em-seed', 'eps-sweep', 'edgar-fiscal-period', 'edgar-earnings-date']));

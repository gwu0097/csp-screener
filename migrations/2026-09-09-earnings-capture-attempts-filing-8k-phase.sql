-- Adds the Earnings Reports Stage A phase to earnings_capture_attempts'
-- capture_phase CHECK constraint, same pattern as
-- 2026-09-04-earnings-capture-attempts-edgar-phases.sql. Caught live
-- (2026-09-09): the AncillaryPhase TS union alone isn't enough --
-- recordAncillaryAttempt's insert failed with a check-constraint
-- violation on the very first real run because this DB-level
-- constraint wasn't updated alongside the type.
alter table earnings_capture_attempts drop constraint earnings_capture_attempts_capture_phase_check;
alter table earnings_capture_attempts
  add constraint earnings_capture_attempts_capture_phase_check
  check (capture_phase = any (array['t0', 't1', 'em-seed', 'eps-sweep', 'edgar-fiscal-period', 'edgar-earnings-date', 'filing-8k']));

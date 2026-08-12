-- Two new scheduled jobs extend the earnings_capture_attempts audit
-- trail beyond T0/T1:
--
--   em-seed    -- daily sweep that seeds earnings_history stub rows
--                 (symbol, earnings_date, timing only) for the chosen
--                 universe, ahead of each print. It never calls Schwab
--                 itself -- the existing captureEarningsT0/T1 pick a
--                 seeded row up automatically via selectT0Candidates()'s
--                 source 2 (any earnings_history row dated today/
--                 tomorrow with iv_before IS NULL, no relevance filter).
--                 So "captured" is never a possible outcome for this
--                 phase -- only "seeded" / "already_exists" / skip
--                 reasons. The actual Schwab capture success/failure
--                 continues to show up under phase='t0'/'t1' as today.
--
--   eps-sweep  -- daily backward-looking sweep that backfills
--                 eps_surprise_pct (Finnhub actual vs estimate, via the
--                 same pctChange() formula updateEncyclopedia already
--                 uses) on existing earnings_history rows within the
--                 trailing T1_RETRY_CUTOFF_DAYS window. No print-timing
--                 constraint -- can run any time after the print.
--
-- Deliberately logged through the SAME table as T0/T1, per the
-- capture-attempts audit's own principle: a symbol failing repeatedly
-- should be visible, not silent. recordAncillaryAttempt() (new,
-- lib/earnings-capture-attempts.ts) only inserts here -- it does NOT
-- patch earnings_history.t0_*/t1_* columns, since those are T0/T1-
-- specific bookkeeping and neither new phase performs a T0/T1 capture.
alter table earnings_capture_attempts
  drop constraint earnings_capture_attempts_capture_phase_check;
alter table earnings_capture_attempts
  add constraint earnings_capture_attempts_capture_phase_check
  check (capture_phase in ('t0', 't1', 'em-seed', 'eps-sweep'));

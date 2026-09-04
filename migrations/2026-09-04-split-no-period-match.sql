-- "no_period_match" conflated two opposite findings under one label:
--   1. Finnhub's response didn't cover this row's fiscal period at all
--      (Finnhub's /stock/earnings returns ~4 most recent quarters
--      regardless of the requested window -- an old row's quarter is
--      simply outside what came back). A source limitation: retrying
--      gains nothing, since Finnhub's "recent" window is always anchored
--      to now, never to the row's own period.
--   2. Finnhub's response DID cover this row's fiscal period, but nothing
--      in it matched the row's fiscal_quarter/fiscal_year or period_end.
--      A real disagreement worth investigating -- our stamped fiscal
--      identifiers may be wrong, or Finnhub's own labeling is inconsistent
--      for this row.
--
-- Split into 'out_of_window' (case 1) and 'unmatched' (case 2), written
-- at check time by lib/eps-sweep.ts comparing the row's target period
-- against the actual date range Finnhub returned. 'no_period_match'
-- stays valid for historical rows where that comparison can't be made
-- retroactively (no persisted record of what Finnhub actually returned)
-- and age alone doesn't make the answer clear -- see the accompanying
-- backfill, which deliberately leaves those rows alone rather than guess.
alter table earnings_history drop constraint if exists earnings_history_last_verified_status_check;
alter table earnings_history add constraint earnings_history_last_verified_status_check
  check (last_verified_status is null or last_verified_status in (
    'captured', 'no_period_match', 'out_of_window', 'unmatched'
  ));

comment on column earnings_history.last_verified_status is
  'What the last_verified_at check concluded. ''captured'': Finnhub '
  'matched, eps_estimate/eps_actual/eps_surprise_pct written. '
  '''out_of_window'': Finnhub''s response didn''t cover this row''s '
  'fiscal period at all -- a source limitation (Finnhub only returns '
  '~4 recent quarters), not a data disagreement; retrying won''t help. '
  '''unmatched'': Finnhub''s response covered the period but nothing '
  'matched -- a real disagreement worth investigating. ''no_period_match'': '
  'legacy value, predates the out_of_window/unmatched split, left as-is '
  'where it can''t be reclassified retroactively. NULL whenever '
  'last_verified_at is NULL. See lib/eps-sweep.ts.';

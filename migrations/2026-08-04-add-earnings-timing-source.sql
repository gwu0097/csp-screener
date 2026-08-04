-- Provenance for earnings_history.timing. Never store a BMO/AMC guess
-- without recording how it was determined — the fifth instance in this
-- codebase of instrumentation (Yahoo reportedDate heuristic) being
-- computed and used internally but never persisted alongside the value
-- it produced.
alter table earnings_history
  add column if not exists timing_source text;

alter table earnings_history
  add constraint earnings_history_timing_source_check
  check (timing_source is null or timing_source in (
    'yahoo_timestamp_heuristic',
    'finnhub_hour',
    'manual'
  ));

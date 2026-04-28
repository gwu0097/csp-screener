-- Run in Supabase SQL editor.
-- CSP screener results — persisted server-side so a scan on one
-- device shows up on another. Previously the screener wrote only
-- to browser localStorage (key "screener_results"), which is what
-- broke cross-device hydration.
--
-- Single-row pattern: /api/screener/results/save truncates before
-- inserting, so this table only ever holds the most-recent run.
-- The PK + screened_at index are here so retention can switch to
-- multi-row history later without a schema change.

create table if not exists screener_results (
  id              uuid default gen_random_uuid() primary key,
  screened_at     timestamptz default now(),
  vix             numeric(8, 2),
  pass1_count     int,
  pass2_count     int,
  candidates      jsonb not null,
  prices          jsonb,
  created_at      timestamptz default now()
);

create index if not exists idx_screener_results_screened_at
  on screener_results(screened_at desc);

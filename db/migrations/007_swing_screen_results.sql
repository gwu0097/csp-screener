-- Run in Supabase SQL editor.
-- Cache table for the swing setup screener result. Only the most-recent
-- run is kept (the API truncates before insert), but rows have a primary
-- key + timestamp anyway so we can move to retention later.

create table if not exists swing_screen_results (
  id uuid default gen_random_uuid() primary key,
  screened_at timestamptz default now(),
  screened int,
  pass1_survivors int,
  pass2_results int,
  duration_ms int,
  candidates jsonb not null
);

create index if not exists idx_swing_screen_results_screened_at
  on swing_screen_results(screened_at desc);

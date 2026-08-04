-- Per-symbol, per-run chain-verification outcomes for Screen Today's
-- Stream C (weekly-chain check). Previously unlogged and unpersisted —
-- the client silently dropped anything that didn't come back
-- "present," so a transient Schwab failure and a genuine "no weekly
-- options for this name" were indistinguishable after the fact (see
-- the AMD/DIS audit: both cleared every other gate and were dropped
-- here with zero trace). run_id groups every batch from one Screen
-- Today click together.
create table if not exists chain_verification_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  run_id uuid not null,
  symbol text not null,
  earnings_date date,
  expiry date,
  status text not null check (status in ('verified', 'no_weekly_chain', 'fetch_failed')),
  error_detail text,
  attempts integer not null default 1,
  created_at timestamptz not null default now()
);

create index if not exists chain_verification_log_run_id_idx on chain_verification_log (run_id);
create index if not exists chain_verification_log_symbol_idx on chain_verification_log (symbol);
create index if not exists chain_verification_log_user_id_idx on chain_verification_log (user_id);

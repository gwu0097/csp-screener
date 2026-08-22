-- Robinhood option-fill auto-import: raw execution landing + per-run
-- health log. Mirrors migrations/2026-08-21-schwab-account-transactions.sql
-- in spirit, but the dedup key is different: Robinhood orders accrete
-- executions over time (a partial fill today, more tomorrow), so the
-- unit of dedup is the EXECUTION, not the order. One row per fill.
--
-- Source is a local "courier" (headless `claude -p` calling the
-- Robinhood MCP's get_option_orders), not a server-side Schwab-style
-- OAuth poll — see lib/robinhood-account-import.ts for why there's no
-- window_start/window_end cursor here: the courier always submits a
-- rolling lookback, and idempotency comes entirely from
-- execution_id's uniqueness.
--
-- dismissed/dismissed_reason ship from day 1 (unlike the Schwab table,
-- which grew them in a later migration) since the review-panel pattern
-- is already proven and there's no reason to re-litigate it here.
create table if not exists robinhood_account_transactions (
  id uuid primary key default gen_random_uuid(),
  execution_id text not null unique,
  order_id text not null,
  account_number text not null,
  broker text not null default 'robinhood',
  symbol text not null,
  strike numeric,
  expiry date,
  option_type text,
  side text,              -- 'buy' | 'sell', from the leg
  position_effect text,   -- 'open' | 'close', from the leg
  contracts numeric not null,
  price numeric not null, -- per-share execution price
  trade_date date not null,
  execution_timestamp timestamptz, -- exact fill time, for timePlaced
  raw jsonb not null,     -- the order/leg/execution slice, for audit
  processed boolean not null default false,
  processed_at timestamptz,
  process_outcome text,
  process_detail text,
  dismissed boolean not null default false,
  dismissed_reason text,
  created_at timestamptz not null default now()
);

create index if not exists robinhood_account_transactions_time_idx
  on robinhood_account_transactions (trade_date desc);

create index if not exists robinhood_account_transactions_unprocessed_idx
  on robinhood_account_transactions (processed) where not processed;

-- One row per courier submission — a health/audit log, not a cursor
-- (there's no window to resume from; every run re-submits a rolling
-- lookback and relies on execution_id dedup).
create table if not exists robinhood_account_poll_runs (
  id uuid primary key default gen_random_uuid(),
  account_number text,
  broker text not null default 'robinhood',
  lookback_since timestamptz,
  orders_seen int not null default 0,
  executions_seen int not null default 0,
  executions_landed int not null default 0,
  fills_created int not null default 0,
  skipped_count int not null default 0,
  error_count int not null default 0,
  errors jsonb,
  ok boolean not null default true,
  run_started_at timestamptz not null default now(),
  run_finished_at timestamptz
);

create index if not exists robinhood_account_poll_runs_time_idx
  on robinhood_account_poll_runs (run_started_at desc);

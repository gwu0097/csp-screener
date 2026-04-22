-- Run in Supabase SQL editor.
-- Additive: safe to re-run; no columns are dropped or renamed.

-- 1. Extend `trades` for multi-broker + open/close linking + entry context.
alter table trades add column if not exists broker text default 'schwab';
alter table trades add column if not exists contracts integer default 1;
alter table trades add column if not exists action text default 'open'
  check (action in ('open', 'close'));
alter table trades add column if not exists parent_trade_id uuid references trades(id);
alter table trades add column if not exists stock_price_at_entry numeric(10,2);
alter table trades add column if not exists stock_price_at_close numeric(10,2);
alter table trades add column if not exists delta_at_entry numeric(8,4);
alter table trades add column if not exists em_pct_at_entry numeric(8,4);
-- strike distance as multiple of expected move (1.5, 2.0, etc).
alter table trades add column if not exists strike_multiple numeric(8,4);

-- 2. Daily market context snapshot (VIX / SPY / regime).
create table if not exists market_context (
  id uuid default gen_random_uuid() primary key,
  date date not null unique,
  vix numeric(8,2),
  spy_price numeric(10,2),
  market_regime text,  -- 'calm' | 'elevated' | 'panic'
  created_at timestamptz default now()
);

-- Run in Supabase SQL editor.
-- Permanent log of every candidate that has appeared in a Discover scan,
-- one row per (symbol, category, scan). Drives the SEEN indicator.

create table if not exists swing_scan_history (
  id uuid default gen_random_uuid() primary key,
  symbol text not null,
  category text not null,
  scanned_at timestamptz default now(),
  confidence text,
  signal_basis text
);

create index if not exists idx_scan_history_symbol_category
  on swing_scan_history(symbol, category, scanned_at);

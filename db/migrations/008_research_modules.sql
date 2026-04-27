-- Run in Supabase SQL editor.
-- Deep Research storage: per-symbol research metadata + per-module
-- timestamped output. Modules accumulate (history is preserved); the
-- API queries by (symbol, module_type) ordered by run_at desc to get
-- the latest. Cache expiry is per-module-type and computed at insert.

create table if not exists research_stocks (
  symbol text primary key,
  company_name text,
  sector text,
  industry text,
  market_cap numeric(20, 2),
  overall_grade text,        -- 'A' | 'B' | 'C' | 'D' | null
  grade_reasoning text,
  last_researched_at timestamptz,
  created_at timestamptz default now()
);

create index if not exists idx_research_stocks_last_researched
  on research_stocks(last_researched_at desc nulls last);

create table if not exists research_modules (
  id uuid default gen_random_uuid() primary key,
  symbol text not null,
  module_type text not null,
  -- Free-form output payload — every module shape lives in the route
  -- handler, the table just stores the JSON.
  output jsonb not null,
  -- True for modules a user has hand-edited (Phase 2+ valuation model);
  -- the UI keeps customised rows separate from auto-generated runs.
  is_customized boolean default false,
  run_at timestamptz default now(),
  expires_at timestamptz
);

create index if not exists idx_research_modules_symbol_type_run
  on research_modules(symbol, module_type, run_at desc);

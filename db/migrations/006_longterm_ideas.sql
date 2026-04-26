-- Run in Supabase SQL editor.
--
-- (1) New table for long-term research ideas — kept separate from
--     swing_ideas so the two workflows can evolve independently. The
--     /longterm/research page POSTs here when "Add to Ideas" is clicked.
-- (2) Backfills swing_ideas.status: collapses the old WATCHING and
--     CONVICTION stages into a single SETUP_READY stage, since swings
--     no longer use a conviction gate.

create table if not exists longterm_ideas (
  id uuid default gen_random_uuid() primary key,
  symbol text not null,
  catalyst text,
  thesis text,
  ai_summary text,
  analyst_sentiment text,
  analyst_target numeric(10, 2),
  forward_pe numeric(8, 2),
  week_52_low numeric(10, 2),
  week_52_high numeric(10, 2),
  price_at_discovery numeric(10, 2),
  user_thesis text,
  exit_condition text,
  timeframe text,
  conviction int,
  status text default 'watching',
  discovered_at timestamptz default now(),
  updated_at timestamptz default now(),
  created_at timestamptz default now()
);

create index if not exists idx_longterm_ideas_symbol on longterm_ideas(symbol);
create index if not exists idx_longterm_ideas_status on longterm_ideas(status);

-- Collapse swing_ideas WATCHING and CONVICTION rows into SETUP_READY.
-- Existing ENTERED / EXITED rows are untouched.
update swing_ideas set status = 'setup_ready' where status in ('watching', 'conviction');

-- Append-only capture history for implied_move_pct.
--
-- earnings_history.implied_move_pct is a single mutable column, upserted
-- by every write path that measures it (ad-hoc analyze passes, the T0
-- cron, manual entry). Each upsert silently destroys whatever value was
-- there before — including a T0 capture: the EM audit found 121 of 279
-- rows that ever had a T0 read (43%) had it overwritten by a later
-- ad-hoc pass, with the original number unrecoverable. This table stops
-- the destruction: every write path appends a row here in ADDITION to
-- whatever it does to earnings_history, so the full capture history
-- survives regardless of what earnings_history.implied_move_pct ends up
-- holding. earnings_history's own column and every consumer of it are
-- UNCHANGED by this migration — this is purely additive, a foundation
-- for choosing a selection rule later once real capture history exists
-- to choose from.
create table if not exists implied_move_captures (
  id uuid primary key default gen_random_uuid(),
  symbol text not null,
  earnings_date date not null,
  captured_at timestamptz not null default now(),
  implied_move_pct numeric not null,
  source text not null check (source in ('schwab', 'schwab_t0', 'manual', 'perplexity')),
  -- Spot at capture — null for manual entries (no live read behind a
  -- hand-typed value). Populated for schwab/schwab_t0 from the same
  -- price the straddle itself was priced against.
  spot_price numeric,
  created_at timestamptz not null default now()
);

create index if not exists idx_implied_move_captures_symbol_date
  on implied_move_captures (symbol, earnings_date, captured_at);

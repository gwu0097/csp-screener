-- Swing journal partial-sell fix: fill-level model.
--
-- The prior swing_trades shape (rebuilt 2026-08-08) had exactly one
-- exit_price/exit_date/realized_pnl/r_multiple column set per row — it
-- could not represent a scaled exit. Selling part of a position always
-- closed the whole row at the full share count, discarded the remainder,
-- and a second sell against an already-"closed" row silently vanished
-- (returned in an API response, never persisted). Confirmed swing_trades
-- had 0 rows immediately before this migration (again, same as the 8/8
-- rebuild) — a destructive drop+recreate carries no data-loss cost.
--
-- New model: swing_trades holds the position and its plan (entry,
-- INITIAL stop, target, thesis) — one row per position, same as before.
-- swing_trade_fills holds every entry and exit with its own price, date,
-- quantity, and reason — many rows per position. A partial sell inserts
-- one exit fill and reduces the position; the position closes only when
-- its fills sum to zero open shares.
--
-- Position-level columns (open_shares, realized_pnl, r_multiple,
-- return_pct, exit_date/price/reason, days_held, status) are a CACHE,
-- always recomputed from the complete fill set — never an independent
-- source of truth. This is what makes the matcher self-healing: if a
-- position-row update fails after its fill already wrote successfully,
-- the next write still derives open shares from the real fills, not the
-- stale cache, and repairs the row.
--
-- Not touched by this migration: swing_ideas, swing_scan_history,
-- swing_scan_results, anything under /longterm, or the options/CSP
-- positions+fills path (app/api/positions/[id]/fills/*) — unrelated
-- systems that happen to share table-name-prefix conventions.

drop table if exists swing_trades;

create table swing_trades (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  swing_idea_id uuid references swing_ideas(id) on delete set null,
  symbol text not null,
  broker text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- ---- Plan — required at entry ----
  setup_name text,
  thesis text not null,
  entry_date date not null,
  entry_price numeric not null,
  -- Total ever entered (sum of 'entry' fills — today always exactly one,
  -- since this app has no scale-in feature; the fill model is still
  -- built to be correct if that changes later).
  shares numeric not null,
  -- Cache of (entry fills' shares) - (exit fills' shares), recomputed
  -- from swing_trade_fills after every exit. Never write this directly.
  open_shares numeric not null,
  -- IMMUTABLE — set once at entry, never updated. The fixed denominator
  -- every fill's r_multiple (and the position's blended r_multiple) is
  -- expressed against, so trailing the stop can never move an
  -- already-recorded R.
  initial_stop numeric not null,
  -- The live/trailing stop — mutable, defaults to initial_stop. Used for
  -- "distance to stop" display, NOT for any R math.
  current_stop numeric not null,
  planned_target numeric,
  -- Fixed at entry: (entry_price - initial_stop) x shares (the TOTAL
  -- original position size, not open_shares). Every fill's r_multiple
  -- divides into this same number, which is exactly what makes the
  -- position's blended r_multiple a plain sum of the fills' r_multiples
  -- rather than a naive average — see lib/swing-trade-fills.ts.
  initial_risk_dollars numeric not null,
  risk_pct_of_portfolio numeric,
  portfolio_value_at_entry numeric,
  risk_limit_overridden boolean not null default false,

  -- ---- Context at entry ----
  atr_at_entry numeric,
  adr_pct_at_entry numeric,
  conviction int,
  market_regime text,

  -- ---- Exit — cached from the MOST RECENT exit fill, not a blended
  -- average. exit_date/exit_price/exit_reason describe "what happened
  -- last," useful for display (including while still partially open,
  -- e.g. "last trimmed at $X on $DATE"). realized_pnl and r_multiple ARE
  -- blended (summed across every exit fill so far) — see comment above.
  -- While status='open' with no exits yet, all of these are null.
  exit_date date,
  exit_price numeric,
  exit_reason text,
  realized_pnl numeric,
  r_multiple numeric,
  return_pct numeric,
  -- Only set once status flips to 'closed' — entry_date to the final
  -- exit fill's date. Null while any shares remain open.
  days_held int,

  -- ---- Excursion (populated by a daily job / on-demand refresh while open) ----
  max_favorable_excursion_r numeric,
  max_adverse_excursion_r numeric,

  -- ---- Post-exit follow-up ----
  price_two_weeks_after_exit numeric,
  exit_quality_note text,

  -- ---- Status ----
  status text not null default 'open',

  constraint swing_trades_status_check check (status in ('open', 'closed')),
  constraint swing_trades_exit_reason_check check (
    exit_reason is null or exit_reason in (
      'stop_hit', 'target_hit', 'time_stop', 'trailing_stop', 'discretionary_override'
    )
  ),
  constraint swing_trades_conviction_check check (
    conviction is null or conviction between 1 and 5
  ),
  constraint swing_trades_open_shares_check check (open_shares >= 0 and open_shares <= shares)
);

comment on column swing_trades.initial_stop is
  'IMMUTABLE. Set once at entry, never updated after. The fixed R denominator — see initial_risk_dollars.';
comment on column swing_trades.current_stop is
  'Mutable — trails as the trade evolves. Distance-to-stop display only, never used in R math.';
comment on column swing_trades.open_shares is
  'Cache recomputed from swing_trade_fills after every exit fill. Not an independent source of truth.';
comment on column swing_trades.initial_risk_dollars is
  'Computed once at entry: (entry_price - initial_stop) x shares (the total original size). Every fill r_multiple and the position blended r_multiple divide into this same fixed number.';
comment on column swing_trades.exit_date is 'Most recent exit fill''s date — a cache, not a blended value.';
comment on column swing_trades.exit_price is 'Most recent exit fill''s price — a cache, not a blended average.';
comment on column swing_trades.exit_reason is 'Most recent exit fill''s reason — a cache, not blended.';
comment on column swing_trades.realized_pnl is 'SUM of realized_pnl across every exit fill so far. Blended, updates on every partial exit.';
comment on column swing_trades.r_multiple is
  'realized_pnl / initial_risk_dollars — the blended R across every exit fill so far, against the FIXED initial-risk denominator. While open with partial exits recorded, this reads as "realized-so-far R against full initial risk," not a final number.';
comment on table swing_trades is
  'planned_stop from the prior shape is gone — replaced by initial_stop (immutable) and current_stop (trailing). See migrations/2026-08-16-swing-trade-fills.sql.';

create index idx_swing_trades_user_id on swing_trades (user_id);
create index idx_swing_trades_status on swing_trades (user_id, status);
create index idx_swing_trades_swing_idea_id on swing_trades (swing_idea_id);
create index idx_swing_trades_symbol on swing_trades (user_id, symbol);

-- Every entry and exit fill for a position, each with its own price,
-- date, quantity, and reason. No allocation/lot-tracking table alongside
-- this — FIFO matching against a position's entry fills is fully
-- deterministic from the ordered fill rows themselves (oldest entry
-- consumed first), so it's recomputed in memory on each exit rather than
-- persisted as a separate join table that would just duplicate what's
-- already derivable. See lib/swing-trade-fills.ts.
create table swing_trade_fills (
  id uuid primary key default gen_random_uuid(),
  trade_id uuid not null references swing_trades(id) on delete cascade,
  user_id uuid not null,
  fill_type text not null,
  fill_date date not null,
  price numeric not null,
  shares numeric not null,
  broker text,
  -- ---- Exit fills only (null on entry fills) ----
  exit_reason text,
  -- This fill's own realized P&L against its FIFO-matched entry
  -- lot(s) — (price - cost_basis) x shares.
  realized_pnl numeric,
  -- This fill's own R-multiple: realized_pnl / the POSITION's
  -- initial_risk_dollars (the fixed, full-original-size denominator —
  -- never this fill's own shares x risk-per-share). Immutable once
  -- written; never reads current_stop, so trailing the stop later
  -- cannot change it.
  r_multiple numeric,
  return_pct numeric,
  -- FIFO-matched weighted-average entry price for this fill's shares.
  -- Today always equal to the position's single entry_price (this app
  -- has no scale-in feature yet, so every position has exactly one
  -- entry fill) — computed via real FIFO walking regardless, so it's
  -- already correct if scale-in is ever added.
  cost_basis numeric,
  created_at timestamptz not null default now(),
  constraint swing_trade_fills_type_check check (fill_type in ('entry', 'exit')),
  constraint swing_trade_fills_shares_check check (shares > 0),
  constraint swing_trade_fills_exit_reason_check check (
    exit_reason is null or exit_reason in (
      'stop_hit', 'target_hit', 'time_stop', 'trailing_stop', 'discretionary_override'
    )
  ),
  constraint swing_trade_fills_exit_fields_check check (
    (fill_type = 'entry' and exit_reason is null and realized_pnl is null and r_multiple is null and cost_basis is null)
    or
    (fill_type = 'exit' and exit_reason is not null)
  )
);
create index idx_swing_trade_fills_trade_id on swing_trade_fills (trade_id, fill_date, created_at);
create index idx_swing_trade_fills_user_id on swing_trade_fills (user_id);

comment on table swing_trade_fills is
  'Every entry and exit fill for a swing_trades position. Position-level columns (open_shares, realized_pnl, r_multiple, ...) are always recomputed from this table, never written independently — see lib/swing-trade-fills.ts recomputeTradeRollup.';

-- A sell that matches no open position (or exceeds the open shares
-- available across every open position for that symbol) is a real event
-- that must be reviewable later — not silently dropped. Previously this
-- was returned in the bulk-create API response only, discarded the
-- moment the request completed unless the user happened to record it
-- elsewhere themselves.
create table swing_trade_orphan_sells (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  symbol text not null,
  fill_date date not null,
  price numeric not null,
  shares numeric not null,
  exit_reason text,
  broker text,
  -- How it arose — 'import' (bulk-create found no/insufficient open
  -- position for this symbol) is the only source today.
  source text not null default 'import',
  reviewed boolean not null default false,
  created_at timestamptz not null default now(),
  constraint swing_trade_orphan_sells_shares_check check (shares > 0)
);
create index idx_swing_trade_orphan_sells_user_id on swing_trade_orphan_sells (user_id, reviewed);

comment on table swing_trade_orphan_sells is
  'Sell fills (from import) that found no open position to match, or exceeded available open shares across every open position for that symbol — persisted for manual review, never silently discarded.';

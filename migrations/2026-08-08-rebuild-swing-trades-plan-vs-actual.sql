-- Rebuilds swing_trades for plan-vs-actual tracking. The prior shape
-- (entry_price, exit_price, shares, realized_pnl, return_pct) had no
-- stop, no target, and no R-multiple — it could record what happened but
-- never whether the trade was any good relative to plan. swing_trades had
-- zero rows at the time of this migration (confirmed 2026-08-08), so a
-- destructive drop+recreate carries no data-loss cost. See
-- SWING-JOURNAL-AUDIT (2026-08-08 conversation) for the full inventory
-- that motivated this rebuild.
--
-- Not touched by this migration: swing_ideas, swing_scan_history,
-- swing_scan_results, or anything under /longterm — those are separate,
-- actively-used systems that happen to share the "swing" name prefix.

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
  shares numeric not null,
  planned_stop numeric not null,
  planned_target numeric,
  initial_risk_dollars numeric not null,
  risk_pct_of_portfolio numeric,
  portfolio_value_at_entry numeric,
  risk_limit_overridden boolean not null default false,

  -- ---- Context at entry ----
  atr_at_entry numeric,
  adr_pct_at_entry numeric,
  conviction int,
  market_regime text,

  -- ---- Exit ----
  exit_date date,
  exit_price numeric,
  exit_reason text,
  realized_pnl numeric,
  r_multiple numeric,
  -- Kept alongside r_multiple (not in the original field list) purely so
  -- /api/swings/ideas and swing-ideas-board.tsx's ExitedCard — which read
  -- a per-symbol %-return today and are out of scope for this rebuild —
  -- keep working unmodified. r_multiple is the number that actually
  -- matters for review; return_pct is legacy display compat only.
  return_pct numeric,
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
  )
);

comment on column swing_trades.planned_stop is
  'Required at entry — without it there is no R, and without R no trade is comparable to any other. The trade cannot be logged without one.';
comment on column swing_trades.initial_risk_dollars is
  'Computed at entry: (entry_price - planned_stop) x shares. The dollar denominator every r_multiple is expressed against.';
comment on column swing_trades.exit_reason is
  'The highest-value field in the table. It is how you learn whether discretionary overrides beat the rules — "exited a winner early" and "widened a stop" are invisible without it. Must be a deliberate selection, never defaulted.';
comment on column swing_trades.max_adverse_excursion_r is
  'Worst unrealized R reached while open. Tells you whether stops are too tight (winners routinely dip near -1R) or too loose (winners never go below -0.3R, so size could be larger).';
comment on column swing_trades.max_favorable_excursion_r is
  'Best unrealized R reached while open. Tells you whether exits are premature (trades reach +3R and you exit at +1.5R).';
comment on column swing_trades.price_two_weeks_after_exit is
  'The only way to learn whether exits were early, late, or right — captured via the follow-up prompt 14+ days after exit_date.';
comment on column swing_trades.risk_limit_overridden is
  'True when this trade''s risk_pct_of_portfolio exceeded swing_journal_settings.max_risk_pct and the user explicitly confirmed anyway. Lets oversized trades be analyzed separately later.';

create index idx_swing_trades_user_id on swing_trades (user_id);
create index idx_swing_trades_status on swing_trades (user_id, status);
create index idx_swing_trades_swing_idea_id on swing_trades (swing_idea_id);

-- Per-user journal settings. Minimal on purpose — just the two knobs the
-- entry form needs (risk-limit warning threshold, portfolio value for
-- computing risk_pct_of_portfolio).
create table if not exists swing_journal_settings (
  user_id uuid primary key,
  max_risk_pct numeric not null default 0.5,
  portfolio_value numeric,
  updated_at timestamptz not null default now()
);

comment on table swing_journal_settings is
  'Per-user swing journal config: max_risk_pct is the warn threshold (%, e.g. 0.5 = 0.5%) checked against a new trade''s risk_pct_of_portfolio; portfolio_value is used to compute that %% and stamped onto each trade as portfolio_value_at_entry.';

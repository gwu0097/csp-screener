-- Campaign layer: groups trade chains that share one earnings decision.
--
-- A trade CHAIN (lib/trade-chains.ts) is roll-adjacency within one
-- (symbol, broker): sequential re-entries at the SAME strike lineage.
-- It does not group deliberate same-session scale-ins at DIFFERENT
-- strikes against the same print (CRWV 2026-08-11: five opens at
-- 71/70/69/68 across the morning — one decision, five chains today).
-- A CAMPAIGN sits above chains, keyed on (symbol, earnings_date) — the
-- same key that already joins research_analyses and earnings_history.
--
-- Deliberately thin: only identity/resolution fields are cached here.
-- Every reporting field (blended entry, strike ladder, timing spread,
-- breach, exit reason, days held) is computed at read time in
-- lib/campaigns.ts, same rationale as the 754d546 chain-P&L fix —
-- caching an aggregate that changes when a later fill lands (a new
-- scale-in, a late close) just reintroduces the staleness bug that fix
-- existed to remove. Resolution (which earnings event a campaign
-- belongs to) does NOT go stale the same way, so it's fine to cache.
create table if not exists campaigns (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  symbol text not null,
  earnings_date date not null,
  resolution_method text not null check (resolution_method in ('fk', 'range', 'lookback')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, symbol, earnings_date)
);

create index if not exists idx_campaigns_user_symbol on campaigns (user_id, symbol);

-- Membership. Nullable and on delete set null: a position with no
-- resolvable earnings event (15 of 269 chains in the first backfill
-- pass) simply has no campaign — personalStats falls back to
-- trade_chain_id, same as before this feature existed.
alter table positions add column if not exists campaign_id uuid references campaigns(id) on delete set null;
create index if not exists idx_positions_campaign_id on positions (campaign_id) where campaign_id is not null;

-- Input snapshot at analysis-save time. spot_at_analysis/em_pct_at_analysis/
-- numeric_grade/crush_grade already exist and already serve as the
-- spot/EM/tradable-grade snapshot; these fill the rest of what the
-- decision was actually made on (POP, delta, yield, fill quality, VIX,
-- crush sub-scores) so it stops being recomputed against later-changed
-- data. First-write-wins on re-save (research-analysis/route.ts):
-- these freeze the moment of the FIRST save for a given (symbol,
-- earnings_date), not whatever the numbers read at the most recent
-- save — otherwise a re-save reproduces the exact "22 rows overwritten
-- this week" failure this column set exists to prevent.
alter table research_analyses add column if not exists implied_move_source_at_analysis text;
alter table research_analyses add column if not exists pop_at_analysis numeric;
alter table research_analyses add column if not exists delta_at_analysis numeric;
alter table research_analyses add column if not exists yield_at_analysis numeric;
alter table research_analyses add column if not exists premium_bid_at_analysis numeric;
alter table research_analyses add column if not exists premium_ask_at_analysis numeric;
alter table research_analyses add column if not exists spread_pct_at_analysis numeric;
alter table research_analyses add column if not exists oi_at_analysis integer;
alter table research_analyses add column if not exists volume_at_analysis integer;
alter table research_analyses add column if not exists vix_at_analysis numeric;
alter table research_analyses add column if not exists vix_regime_at_analysis text;
-- {historicalMoveScore, consistencyScore, termStructureScore, ivEdgeScore, surpriseScore}
alter table research_analyses add column if not exists crush_subscores_at_analysis jsonb;
alter table research_analyses add column if not exists snapshot_saved_at timestamptz;

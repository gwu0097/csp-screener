-- Decision context: the third piece of the capture layer (campaign
-- grouping + input snapshot shipped in 03559d3). Unlike the campaign
-- table's identity/resolution fields, these ARE recomputed and
-- overwritten every time lib/campaigns.ts's buildAndPersistCampaigns
-- runs for a campaign (bulk-create Phase 2b, or the backfill script) —
-- they reflect current fill/position state, not a frozen snapshot like
-- research_analyses' *_at_analysis columns. That's a deliberate,
-- narrower exception to the "don't cache what goes stale" rule the
-- 754d546 chain-P&L fix established: these are cheap DB-only
-- recomputes (no market-data fetch), always kept in sync on write,
-- never trusted as stale at read time the way chain_pnl was.
alter table campaigns add column if not exists strike_deviation_dollars numeric;
alter table campaigns add column if not exists strike_deviation_x_em numeric;
alter table campaigns add column if not exists analysis_saved_before_first_fill boolean;
alter table campaigns add column if not exists exit_reason text
  check (exit_reason in ('assigned', 'expired', 'closed_early', 'rolled', 'open'));
alter table campaigns add column if not exists days_held_sessions integer;
-- True when ANY contributing fill's fill_time is indistinguishable
-- from its own created_at (the pre-03559d3 bug signature: bulk-create
-- stamped fill_time = import wall-clock instead of the parsed broker
-- "Time Placed" value) — so days_held_sessions/exit timing for that
-- campaign is only as precise as fill_date (reliable), not fill_time.
alter table campaigns add column if not exists days_held_is_estimated boolean;

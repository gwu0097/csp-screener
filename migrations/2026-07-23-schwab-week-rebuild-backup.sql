-- Mandatory rollback path before wiping and rebuilding this week's
-- Schwab option data (broker='schwab' strictly — schwab2 and robinhood
-- untouched) from a hand-transcribed authoritative ledger. Snapshots
-- every row about to be deleted, verbatim, before any DELETE runs.
--
-- Scope: broker='schwab' positions with opened_date, closed_date, or
-- any fill fill_date >= 2026-07-20 (16 positions, 71 fills, 76
-- position_snapshots, 2 post_earnings_recommendations — every
-- trade_chain_id involved is single-member and self-contained, so no
-- chain spans outside this window; verified before this migration was
-- written).
create table if not exists schwab_backup_20260723_positions as
select * from positions
where broker = 'schwab'
  and (
    opened_date >= '2026-07-20'
    or closed_date >= '2026-07-20'
    or id in (select position_id from fills where fill_date >= '2026-07-20')
  );

create table if not exists schwab_backup_20260723_fills as
select * from fills
where position_id in (select id from schwab_backup_20260723_positions);

create table if not exists schwab_backup_20260723_position_snapshots as
select * from position_snapshots
where position_id in (select id from schwab_backup_20260723_positions);

create table if not exists schwab_backup_20260723_post_earnings_recommendations as
select * from post_earnings_recommendations
where position_id in (select id from schwab_backup_20260723_positions);

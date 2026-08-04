-- Mandatory rollback path before re-deriving price_before/price_after
-- from earnings_price_paths for rows flagged by two independent
-- signatures (the timing-reconciliation "unverifiable" set and the
-- implausibly-small-move sweep — see prior diagnostic in this thread).
-- Snapshots every row in the repair candidate set, verbatim, before any
-- UPDATE runs. Scope: data_source IN (finnhub, finnhub+calendar-rekey)
-- (encyclopedia-live rows use live intraday Schwab quotes, out of
-- scope entirely), timing IN (bmo, amc) (rows with no assigned timing
-- have no basis to pick offsets from, left untouched), and flagged by
-- either abs(actual_move_pct) < 0.005 or membership in the 264-row
-- timing-unverifiable set from backfill-earnings-timing-report.json.
create table if not exists backup_20260805_earnings_history_price_repair as
select * from earnings_history where false;

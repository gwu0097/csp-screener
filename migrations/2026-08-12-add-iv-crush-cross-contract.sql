-- Flags T1 captures whose IV measurement is a cross-contract comparison:
-- T0 measured IV on the earnings-week expiry; if T1 ran late enough that
-- expiry had already rolled off Schwab's chain, T1 measured a different,
-- later-dated contract instead. price_after/actual_move_pct are unaffected
-- (the underlying quote doesn't depend on which expiry was queried) --
-- only iv_after/iv_crushed/iv_crush_magnitude are contaminated.
--
-- No stored contract identifier exists for either T0 or T1 (neither ever
-- persisted the expiry it measured), and Schwab's chains endpoint 400s on
-- expired-date ranges, so the true T0 contract can't be reconstructed
-- retroactively. Proxy: T0 and T1 apply the identical minExpiryIso formula
-- (nextWeekdayOnOrAfter(earnings_date + 1)), so a T1 that completed on or
-- before that date is virtually certain to have hit the same still-listed
-- expiry T0 did; a T1 that completed after it may have (weeklies roll off
-- fastest for liquid names) and cannot be assumed safe. Conservative by
-- design per the 2026-08-12 audit's explicit direction ("a wrong number in
-- the data is worse than a gap") -- flags when in doubt rather than only
-- when certain.
alter table earnings_history add column if not exists iv_crush_cross_contract boolean not null default false;

-- Denormalized copy on the recommendation row itself (mirrors how
-- move_ratio/iv_crushed/iv_crush_magnitude are already denormalized here
-- from earnings_history at write time) so the position-facing UI can
-- render the flag without an extra join.
alter table post_earnings_recommendations add column if not exists iv_crush_cross_contract boolean not null default false;

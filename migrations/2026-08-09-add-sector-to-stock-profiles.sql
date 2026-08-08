-- Adds sector to stock_profiles (already keyed by symbol; already carries
-- industry, industry_pass, market_cap_billions from lib/classification.ts).
-- Purely additive — existing readers/writers of stock_profiles are
-- untouched. Backs the Swing Setups table's new Sector column: the data
-- is available from Yahoo (lib/yahoo.ts getSectorIndustry, already
-- exported but previously unused anywhere) — this just gives it a place
-- to be cached instead of re-fetching on every screen run.
alter table stock_profiles add column if not exists sector text;

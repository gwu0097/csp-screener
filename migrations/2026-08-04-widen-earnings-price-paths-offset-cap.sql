-- Extends earnings_price_paths.trading_day_offset from -5..20 to -5..25
-- so AMC-timed events (reaction bar at offset+1) can reach a true +20
-- trading-day drift horizon (needs offset+21). Existing -5..20 rows are
-- untouched; scripts/extend-earnings-price-paths-25.ts adds +21..+25
-- additively.
alter table earnings_price_paths
  drop constraint earnings_price_paths_trading_day_offset_check;

alter table earnings_price_paths
  add constraint earnings_price_paths_trading_day_offset_check
  check (trading_day_offset >= -5 and trading_day_offset <= 25);

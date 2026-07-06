-- Entry-context columns stamped on every option position at creation
-- (lib/entry-context.ts, called from trades/bulk-create Phase 2b).
-- Complements the existing tracked_tickers merge fields (entry_vix,
-- entry_stock_price, entry_em_pct, entry_*_grade) which only cover
-- screener-sourced trades.
ALTER TABLE positions ADD COLUMN IF NOT EXISTS entry_iv numeric;
ALTER TABLE positions ADD COLUMN IF NOT EXISTS entry_delta numeric;
ALTER TABLE positions ADD COLUMN IF NOT EXISTS entry_dte integer;
ALTER TABLE positions ADD COLUMN IF NOT EXISTS entry_market_cap numeric;

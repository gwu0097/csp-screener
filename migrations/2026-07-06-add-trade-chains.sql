-- Trade chain classification (lib/trade-chains.ts). A chain groups the
-- positions of one campaign: sequential rolls (close→open within 2
-- trading days, same symbol+broker) plus assignment stock lots. Every
-- member carries the chain-level aggregates so reads stay one-table.
--   trade_type: 'clean' | 'rolled' | 'recovery_play' (NULL = unclassified)
--   trade_type_source: 'auto' (detected, awaiting user confirmation)
--                    | 'user' (confirmed/overridden)
ALTER TABLE positions ADD COLUMN IF NOT EXISTS trade_chain_id uuid;
ALTER TABLE positions ADD COLUMN IF NOT EXISTS trade_type text;
ALTER TABLE positions ADD COLUMN IF NOT EXISTS trade_type_source text;
ALTER TABLE positions ADD COLUMN IF NOT EXISTS chain_pnl numeric;
ALTER TABLE positions ADD COLUMN IF NOT EXISTS peak_capital numeric;

CREATE INDEX IF NOT EXISTS positions_trade_chain_idx
  ON positions (trade_chain_id)
  WHERE trade_chain_id IS NOT NULL;

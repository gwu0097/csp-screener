-- 2026-05-30 — add `direction` to positions so realized_pnl computes
-- with the correct sign for long calls / long puts. All existing rows
-- default to 'short' (the historical CSP-only assumption); long
-- positions get stamped 'long' going forward via bulk-create's new
-- TradeInput.direction field, the manual-add modal's direction
-- toggle, and the parse-screenshot `side` detection.
--
-- Run this in the Supabase SQL editor BEFORE redeploying — code that
-- writes 'direction' will fail until the column exists. Reads are
-- already defensive (?? 'short').

ALTER TABLE positions
  ADD COLUMN IF NOT EXISTS direction VARCHAR(5) NOT NULL DEFAULT 'short'
    CHECK (direction IN ('long', 'short'));

-- After applying, run scripts/fix-rh-zs-long-calls.ts to flip the two
-- known-long ZS calls (f3467714 = $135C, fadd08c6 = $138C) and
-- recompute their realized_pnl with the corrected sign.

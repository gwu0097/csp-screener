-- Freezes the Discover screener's setup context onto swing_ideas at
-- "Track" time — entry/target/stop/R-R, the tab that surfaced it, that
-- tab's score, tier-1/tier-2 signals, red flags, and catalyst
-- confidence. Nullable/defaulted so existing manually-created ideas are
-- unaffected (source defaults to 'manual', signal arrays default to
-- empty, everything else stays NULL).
--
-- No FK back to swing_screen_results: that table is truncate-and-replace
-- per run (see app/api/swings/screen/save/route.ts), so a live reference
-- would go stale/dangling. The setup snapshot is denormalized onto the
-- idea row instead, the same way positions carry entry_iv/entry_delta
-- directly rather than pointing at a scan row that may no longer exist.
--
-- Levels are a record of what was seen at track time and are NEVER
-- recomputed as the stock moves — see components/swing-ideas-board.tsx
-- for how current price is compared against these frozen levels.

ALTER TABLE swing_ideas
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS source_tab text,
  ADD COLUMN IF NOT EXISTS source_score integer,
  ADD COLUMN IF NOT EXISTS entry_price numeric,
  ADD COLUMN IF NOT EXISTS target_price numeric,
  ADD COLUMN IF NOT EXISTS stop_price numeric,
  ADD COLUMN IF NOT EXISTS rr numeric,
  ADD COLUMN IF NOT EXISTS atr14 numeric,
  ADD COLUMN IF NOT EXISTS tier1_signals jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS tier2_signals jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS red_flags jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS catalyst_type text,
  ADD COLUMN IF NOT EXISTS catalyst_confidence text;

ALTER TABLE swing_ideas
  ADD CONSTRAINT swing_ideas_source_check
    CHECK (source IN ('manual', 'screener_track'));

ALTER TABLE swing_ideas
  ADD CONSTRAINT swing_ideas_source_tab_check
    CHECK (source_tab IS NULL OR source_tab IN ('capitulation', 'pullback', 'insider', 'options_flow'));

ALTER TABLE swing_ideas
  ADD CONSTRAINT swing_ideas_catalyst_confidence_check
    CHECK (catalyst_confidence IS NULL OR catalyst_confidence IN ('high', 'medium', 'low', 'none'));

-- Grading queries ("which tab/signal combo actually predicts outcome")
-- will group/filter by tab and source — index the common case.
CREATE INDEX IF NOT EXISTS swing_ideas_source_tab_idx
  ON swing_ideas (source_tab)
  WHERE source_tab IS NOT NULL;

COMMENT ON COLUMN swing_ideas.source IS 'manual = created via the Add Idea dialog; screener_track = created via Track on a Discover screener row';
COMMENT ON COLUMN swing_ideas.source_tab IS 'Which Discover screener tab surfaced this idea (capitulation/pullback/insider/options_flow). NULL for manual ideas.';
COMMENT ON COLUMN swing_ideas.source_score IS 'That tab''s 0-10 score at track time. NULL for manual ideas.';
COMMENT ON COLUMN swing_ideas.entry_price IS 'Frozen at track time from the screener candidate. Never recomputed as price moves.';
COMMENT ON COLUMN swing_ideas.target_price IS 'Frozen at track time.';
COMMENT ON COLUMN swing_ideas.stop_price IS 'Frozen at track time.';
COMMENT ON COLUMN swing_ideas.rr IS 'Risk/reward at track time — trade-geometry sanity check, not a ranking input.';
COMMENT ON COLUMN swing_ideas.atr14 IS '14-day ATR at track time — the volatility basis for stop_price. Audit/display only.';
COMMENT ON COLUMN swing_ideas.tier1_signals IS 'Tier-1 signals present at track time (e.g. INSIDER_BUYING, UNUSUAL_OPTIONS, VOLUME_SPIKE).';
COMMENT ON COLUMN swing_ideas.tier2_signals IS 'Tier-2 technical signals present at track time (e.g. AT_SUPPORT, PULLBACK_TO_MA).';
COMMENT ON COLUMN swing_ideas.red_flags IS 'Red flags present at track time (e.g. INSIDER_SELLING, HIGH_SHORT_45%).';
COMMENT ON COLUMN swing_ideas.catalyst_type IS 'Perplexity catalyst type at track time, if any.';
COMMENT ON COLUMN swing_ideas.catalyst_confidence IS 'Perplexity catalyst confidence at track time (high/medium/low/none).';

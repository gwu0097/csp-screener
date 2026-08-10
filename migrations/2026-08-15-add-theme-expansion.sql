-- Universe & Themes, Phase C: Perplexity-assisted expansion with human
-- curation.
--
-- review_status distinguishes a name Perplexity suggested but nobody has
-- decided on yet ('pending') from a name that's actually in the theme
-- ('approved'). This is orthogonal to is_active (which tracks whether an
-- approved member is currently participating vs. soft-deleted) — a
-- pending row's is_active value is irrelevant until it's approved or
-- rejected. Existing rows default/backfill to 'approved' so every
-- Phase A/B member (manual adds, anchors) is unaffected.
--
-- resolveUniverseSymbols (lib/universe.ts) must filter on review_status =
-- 'approved' in addition to is_active = true — a pending suggestion must
-- never reach the screener. Rejecting a pending suggestion deletes its
-- theme_members row (after writing to theme_rejections) rather than
-- setting a third status — theme_rejections is already the single source
-- of truth for "don't resuggest," so a rejected row shouldn't linger in
-- theme_members in any state.
alter table theme_members add column if not exists review_status text not null default 'approved'
  check (review_status in ('pending', 'approved'));
create index if not exists idx_theme_members_review_status on theme_members (theme_id, review_status);

-- Per-theme editable override of the theme_type's default expansion
-- prompt template — null means "use the theme_type default." Set
-- whenever the user runs expansion with edited text, so refinements
-- persist across runs.
alter table themes add column if not exists expansion_prompt text;

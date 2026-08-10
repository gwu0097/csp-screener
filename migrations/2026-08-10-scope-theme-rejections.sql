-- Scopes theme_rejections to the question that produced them. Previously
-- a rejection suppressed a suggestion for as long as the theme existed,
-- regardless of theme_type or expansion prompt changing underneath it —
-- a rejection made answering "who supplies these" silently kept
-- suppressing names under a later, unrelated "who competes with these"
-- question. Permanence within a stable question is correct; permanence
-- across a changed question is not.
--
-- theme_type: the theme_type in effect when the rejection was written.
-- prompt_hash: sha256 hex of the EFFECTIVE prompt TEMPLATE text (the
--   theme_type's default, or the theme's expansion_prompt override if
--   set) — not the fully-interpolated per-run prompt sent to Perplexity,
--   which embeds the anchor list and "already a member" exclusions and
--   would change on every membership edit, making it useless as a
--   stable question identity. See lib/theme-expansion.ts
--   effectiveExpansionPrompt/hashPromptText.
--
-- Both nullable: existing rows predate this column and are stamped by a
-- one-time backfill (scripts/backfill-theme-rejection-scope.ts), not by
-- this migration — this migration only adds the columns/index.
alter table theme_rejections add column if not exists theme_type text;
alter table theme_rejections add column if not exists prompt_hash text;

-- Speeds the scope-match query in filterAndQueueSuggestions (an .in()
-- over symbols plus an exact theme_type/prompt_hash match, run on every
-- expansion filter chunk).
create index if not exists idx_theme_rejections_scope
  on theme_rejections (theme_id, theme_type, prompt_hash);

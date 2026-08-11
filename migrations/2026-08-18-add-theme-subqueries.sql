-- Universe & Themes, Phase C follow-up: multi-query fan-out.
--
-- A single expansion run asks one question once, capped at 40
-- suggestions -- Perplexity returns the most-documented names for that
-- one framing (semicap/EMS every time for "AI Infrastructure" as a
-- supply_chain question) and the rest of a hundreds-strong universe is
-- never reached. theme_subqueries lets a theme define several named
-- angles ("power and cooling infrastructure", "networking, optical, and
-- interconnect", ...), each run as its own sequential Perplexity call
-- with its own 40-suggestion cap and (optionally) its own anchor subset.
--
-- No FK-enforced anchor reference: anchor_symbols is a plain text[] of
-- tickers, resolved against the theme's CURRENT anchor members at
-- prompt-build time (not at subquery-creation time) -- anchors can
-- change over time, and a symbol no longer an anchor just drops out of
-- the interpolation rather than needing referential cleanup here.
-- Empty/null means "use all of the theme's anchors," identical to
-- today's single-question behavior.
--
-- No is_active / soft-delete: unlike theme_type or expansion_prompt,
-- a subquery carries no rejection-scope history to preserve (rejections
-- stay scoped at the theme level -- see lib/theme-expansion.ts), so a
-- plain hard delete is enough.
create table if not exists theme_subqueries (
  id uuid primary key default gen_random_uuid(),
  theme_id uuid not null references themes(id) on delete cascade,
  user_id uuid not null,
  name text not null,
  query_text text not null,
  anchor_symbols text[],
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_theme_subqueries_theme on theme_subqueries (theme_id, sort_order);

-- Which subquery (by name, not id -- survives the subquery row later
-- being deleted, same "freeze the label, not the reference" choice as
-- theme_rejections.theme_type) produced a Perplexity-sourced pending
-- row. Null for manual adds and legacy/no-subquery runs.
alter table theme_members add column if not exists expansion_subquery text;

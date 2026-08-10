-- Universe & Themes, Phase A: storage for theme-based universes the user
-- curates directly, replacing the hardcoded S&P500+Nasdaq100 universe's
-- role for setups like RS Pullback where the real names (second/third-tier
-- suppliers) aren't in either index. Phase A is schema + manual curation
-- UI only — the screener doesn't read these yet (Phase B), there's no
-- Perplexity expansion yet (Phase C), and no within-theme RS calc yet
-- (Phase D).
--
-- All three tables are user_id-scoped directly (not just via theme_id),
-- matching the swing_trades/swing_ideas/swing_screen_results convention —
-- the app's Supabase wrapper doesn't support embedded-resource joins, so
-- direct user_id filtering on every table keeps authorization checks a
-- single .eq() rather than a join through themes.

create table themes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  name text not null,
  description text,
  -- Free text for now (e.g. "supply_chain", "sector_comparable") — Phase
  -- C's expansion prompts will branch on this ("who supplies these" vs
  -- "who competes with these"), but Phase A just stores it.
  theme_type text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_themes_user_id on themes (user_id);

create table theme_members (
  id uuid primary key default gen_random_uuid(),
  theme_id uuid not null references themes(id) on delete cascade,
  user_id uuid not null,
  symbol text not null,
  -- Anchors matter beyond labeling: Phase D computes relative strength
  -- against a theme's anchors rather than against SPY, so this needs to
  -- be explicit and the anchor set needs to stay small.
  is_anchor boolean not null default false,
  source text not null default 'manual',
  added_at timestamptz not null default now(),
  -- Soft-delete — removing a name keeps the record instead of losing when
  -- and why it was added.
  is_active boolean not null default true,
  notes text,
  constraint theme_members_source_check check (source in ('manual', 'perplexity')),
  -- One row per (theme, symbol) — re-adding a previously-deactivated
  -- member reactivates its existing row (preserving added_at/notes/
  -- source history) rather than creating a duplicate.
  constraint theme_members_unique unique (theme_id, symbol)
);
create index idx_theme_members_theme_id on theme_members (theme_id);
create index idx_theme_members_user_id on theme_members (user_id);

-- Not used in Phase A — created now so Phase C's accept/reject expansion
-- flow has somewhere to write, and a rejected name doesn't resurface on
-- every subsequent expansion run for the same theme.
create table theme_rejections (
  id uuid primary key default gen_random_uuid(),
  theme_id uuid not null references themes(id) on delete cascade,
  user_id uuid not null,
  symbol text not null,
  rejected_at timestamptz not null default now(),
  reason text
);
create index idx_theme_rejections_theme_id on theme_rejections (theme_id);
create index idx_theme_rejections_user_id on theme_rejections (user_id);

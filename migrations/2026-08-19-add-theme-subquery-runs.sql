-- Multi-query fan-out follow-up: persist each sub-query's yield per run.
--
-- Without this, a chronically unproductive angle ("power semiconductors
-- and analog" returning 0 raw suggestions two runs in a row) is only
-- visible if the user happens to remember the last run's numbers -- the
-- in-memory report (lastRun.bySubQuery) disappears the moment the page
-- reloads or a new run starts. One row per (sub-query, run).
--
-- subquery_id is nullable + ON DELETE SET NULL, not a hard dependency:
-- subquery_name is the frozen label a run's history stays keyed on (same
-- "freeze the label, not the reference" choice as theme_members.
-- expansion_subquery and theme_rejections.theme_type) -- deleting a
-- sub-query definition later must not delete or orphan its run history.
create table if not exists theme_subquery_runs (
  id uuid primary key default gen_random_uuid(),
  theme_id uuid not null references themes(id) on delete cascade,
  subquery_id uuid references theme_subqueries(id) on delete set null,
  subquery_name text not null,
  user_id uuid not null,
  ran_at timestamptz not null default now(),
  raw_count integer not null default 0,
  truncated boolean not null default false,
  cross_dup_count integer not null default 0,
  queued_count integer not null default 0,
  error text
);
create index if not exists idx_theme_subquery_runs_theme_subq
  on theme_subquery_runs (theme_id, subquery_name, ran_at desc);

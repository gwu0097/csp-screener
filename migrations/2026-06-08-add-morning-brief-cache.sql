-- Morning Dashboard AI brief cache. One row per market day; the brief
-- is regenerated when the cached row is older than 4 hours (TTL enforced
-- in app/api/dashboard/morning-brief). cache_date is UNIQUE so an upsert
-- on conflict replaces the day's row.
create table if not exists morning_brief_cache (
  id uuid primary key default gen_random_uuid(),
  cache_date date unique not null,
  brief text not null,
  fetched_at timestamptz not null default now()
);

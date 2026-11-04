-- Robinhood earnings calendar, pulled by the local courier
-- (scripts/robinhood-earnings-courier.ts → app/api/robinhood-calendar/
-- ingest) so Screen Today can union it with Finnhub's calendar and flag
-- where the two disagree (lib/earnings-source-merge.ts).
--
-- One batch per successful courier run; Screen Today reads the newest
-- batch only. The ingest route prunes batches older than 30 days
-- (rows go with them via ON DELETE CASCADE).
--
-- RLS on with no policies, same as screener_traded_marks: only the
-- service-role server client (bypasses RLS) touches these. The anon
-- browser key gets nothing.

create table if not exists robinhood_earnings_batches (
  id uuid primary key default gen_random_uuid(),
  fetched_at timestamptz not null default now(),
  window_start date not null,
  window_end date not null,
  row_count integer not null check (row_count >= 0),
  source text not null default 'courier'
);
create index if not exists robinhood_earnings_batches_fetched_at_idx
  on robinhood_earnings_batches (fetched_at desc);

create table if not exists robinhood_earnings_rows (
  batch_id uuid not null references robinhood_earnings_batches (id) on delete cascade,
  symbol text not null,
  report_date date not null,
  -- 'am' | 'pm' as Robinhood reports it; null = Robinhood has no timing.
  timing text null check (timing in ('am', 'pm')),
  verified boolean not null,
  primary key (batch_id, symbol, report_date)
);

-- The user's answer to "which source is right?" for one conflict.
-- conflict_key encodes both sources' date+timing as seen when the user
-- chose (lib/earnings-source-merge.ts conflictKey), so a choice only
-- applies to that exact disagreement: if either source later changes
-- its date or timing, the key changes and the row is flagged again.
create table if not exists earnings_source_choices (
  user_id uuid not null,
  symbol text not null,
  conflict_key text not null,
  chosen_source text not null check (chosen_source in ('finnhub', 'robinhood', 'user')),
  chosen_date date not null,
  chosen_timing text not null check (chosen_timing in ('BMO', 'AMC')),
  created_at timestamptz not null default now(),
  primary key (user_id, symbol, conflict_key)
);

alter table robinhood_earnings_batches enable row level security;
alter table robinhood_earnings_rows enable row level security;
alter table earnings_source_choices enable row level security;

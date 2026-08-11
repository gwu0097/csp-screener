-- T0/T1 capture retry backstop (audit: 27 earnings_history rows
-- permanently orphaned by selectT1Candidates()'s fixed 4-day window --
-- one Schwab failure inside that window meant no retry, ever).
--
-- earnings_capture_attempts is the full audit trail: one row per call
-- to captureEarningsT0/captureEarningsT1, success or failure, so "failed
-- six times for the same reason" is directly queryable rather than
-- inferred from a single denormalized counter. Not a growth concern
-- like the chain-capture Parquet split (lib/local-chain-store.ts) was --
-- this is a few hundred earnings events/year at up to ~10 attempts
-- each, timestamp+outcome+reason only.
create table if not exists earnings_capture_attempts (
  id uuid primary key default gen_random_uuid(),
  earnings_history_id uuid references earnings_history(id) on delete cascade,
  symbol text not null,
  earnings_date date not null,
  capture_phase text not null check (capture_phase in ('t0', 't1')),
  attempted_at timestamptz not null default now(),
  outcome text not null,
  error_message text
);
create index if not exists idx_earnings_capture_attempts_lookup
  on earnings_capture_attempts (symbol, earnings_date, capture_phase, attempted_at desc);

-- T1 retry-until-cutoff bookkeeping. t1_unrecoverable is the explicit
-- "we stopped trying and here's why" marker the audit asked for --
-- selectT1Candidates() excludes unrecoverable rows so the cutoff sweep
-- and the candidate query never disagree. No t0_unrecoverable: T0's
-- candidate window (today/tomorrow only, see selectT0Candidates) is
-- inherently tight and time-sensitive -- capturing a stale "before"
-- price days late would be worse than not capturing at all, so T0 gets
-- attempt logging and a same-day retry pass, not an extended window.
alter table earnings_history add column if not exists t1_last_attempt_at timestamptz;
alter table earnings_history add column if not exists t1_last_failure_reason text;
alter table earnings_history add column if not exists t1_unrecoverable boolean not null default false;
alter table earnings_history add column if not exists t1_unrecoverable_reason text;

alter table earnings_history add column if not exists t0_last_attempt_at timestamptz;
alter table earnings_history add column if not exists t0_last_failure_reason text;

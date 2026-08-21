-- Schwab Account Data auto-import: raw transaction landing, fills
-- traceability, and per-run checkpoint/health log. Additive only —
-- nothing here touches positions/campaigns/fills' existing columns
-- except the one new nullable column noted below.

-- Layer-1 dedup: every transaction Schwab returns lands here exactly
-- once, keyed by its own activity_id. A re-poll of an overlapping
-- window is a no-op against this table regardless of what happens
-- downstream. `processed`/`process_outcome` track what the translator
-- decided to do with it (or that it hasn't run yet) — this table is
-- insert-only for the raw column, update-only for the processing
-- columns, and is the audit trail for "why did/didn't this become a
-- position."
create table if not exists schwab_account_transactions (
  id uuid primary key default gen_random_uuid(),
  account_number text not null,
  broker text not null,
  activity_id bigint not null unique,
  type text not null,
  transaction_time timestamptz not null,
  raw jsonb not null,
  processed boolean not null default false,
  processed_at timestamptz,
  process_outcome text,
  process_detail text,
  created_at timestamptz not null default now()
);

create index if not exists schwab_account_transactions_broker_time_idx
  on schwab_account_transactions (broker, transaction_time desc);

create index if not exists schwab_account_transactions_unprocessed_idx
  on schwab_account_transactions (processed) where not processed;

-- Layer-2 dedup + traceability: which Schwab record (if any) produced
-- this fill. Nullable — manual/screenshot/CSV fills never set it.
-- Checked before creating a fill so a re-poll (or a poll racing a
-- manual entry of the same event) can recognize it was already
-- turned into a fill without relying on bulk-create's fuzzy
-- amount/date match alone.
alter table fills add column if not exists schwab_activity_id bigint unique;

-- Checkpoint + health log, one row per poll run per account. The next
-- run's startDate is the most recent successful row's window_end for
-- that account — no separate cursor table needed.
create table if not exists schwab_account_poll_runs (
  id uuid primary key default gen_random_uuid(),
  account_number text not null,
  broker text not null,
  window_start timestamptz not null,
  window_end timestamptz not null,
  transactions_seen int not null default 0,
  transactions_landed int not null default 0,
  fills_created int not null default 0,
  positions_created int not null default 0,
  expirations_recorded int not null default 0,
  assignments_recorded int not null default 0,
  skipped_count int not null default 0,
  error_count int not null default 0,
  errors jsonb,
  ok boolean not null default true,
  run_started_at timestamptz not null default now(),
  run_finished_at timestamptz
);

create index if not exists schwab_account_poll_runs_broker_window_idx
  on schwab_account_poll_runs (broker, window_end desc);

-- Capture-health rollup for the local post-earnings/T0/T1 chain capture.
-- One row per (capture_date, capture_phase) — a small aggregate the
-- Vercel-hosted dashboard can read, since it can't reach the local
-- Parquet outcome log directly. Raw per-symbol detail stays local.
create table if not exists capture_health_daily (
  capture_date date not null,
  capture_phase text not null,
  due integer not null default 0,
  fired integer not null default 0,
  errored integer not null default 0,
  suppressed integer not null default 0,
  missed integer not null default 0,
  schwab_disconnected integer not null default 0,
  outstanding jsonb not null default '[]'::jsonb,
  run_started_at timestamptz,
  run_finished_at timestamptz,
  reconciled_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (capture_date, capture_phase)
);

create index if not exists capture_health_daily_date_idx on capture_health_daily (capture_date);

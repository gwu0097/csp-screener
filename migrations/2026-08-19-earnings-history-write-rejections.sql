-- Phase B (single writer + precedence): rejection log table.
--
-- Applied ahead of the precedence trigger (migrations/2026-08-19-earnings-
-- history-precedence-trigger.sql), which is a SEPARATE, later deploy —
-- this table must exist before the trigger can ever produce a P0001 for
-- the single writer (lib/earnings-history-writer.ts) to catch and log.
-- No FK to earnings_history: a rejected write's target row may not exist
-- yet (an insert-shaped call that turned into a downgrade attempt on an
-- existing row is the only way to reach P0001, so the row does exist in
-- practice, but keeping this table dependency-free avoids ever blocking
-- an earnings_history delete/migration on rejection-log history).
create table if not exists earnings_history_write_rejections (
  id uuid primary key default gen_random_uuid(),
  symbol text not null,
  earnings_date date not null,
  quarter_label text,
  attempted_by text not null,
  attempted_tier text not null,
  attempted_data_source text,
  attempted_timing text,
  stored_tier text not null,
  stored_data_source text not null,
  stored_earnings_date date not null,
  stored_timing text,
  created_at timestamptz not null default now()
);

create index if not exists earnings_history_write_rejections_created_at_idx
  on earnings_history_write_rejections (created_at desc);

create index if not exists earnings_history_write_rejections_symbol_date_idx
  on earnings_history_write_rejections (symbol, earnings_date);

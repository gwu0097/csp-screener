-- Lets the "Aged out permanently" list on the T0/T1 crush-capture
-- health panel be reviewed once and dismissed, instead of flagging
-- "attention needed" indefinitely for rows that, by definition
-- (t1_unrecoverable=true), will never be retried.
alter table earnings_history
  add column if not exists t1_unrecoverable_dismissed boolean not null default false,
  add column if not exists t1_unrecoverable_dismissed_at timestamptz;

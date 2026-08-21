-- Dismiss flag for schwab_account_transactions rows the auto-import
-- poller couldn't apply. Set by the user (explicit "Dismiss" click) or
-- by the app itself once the same activity has been logged manually
-- via the "Import" action. Dismissed rows drop out of
-- /api/schwab-account/unresolved and are never re-surfaced — the
-- poller only re-touches processed=false rows, so this needs no
-- change on that side.
alter table schwab_account_transactions
  add column if not exists dismissed boolean not null default false;

alter table schwab_account_transactions
  add column if not exists dismissed_reason text;

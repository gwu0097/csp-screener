-- Isolated OAuth token storage for the "Account Data" Schwab app
-- (Accounts and Trading Production), separate from schwab_tokens (the
-- "Earnings Research Engine" market-data app's token). Same shape,
-- deliberately its own table rather than a discriminator column on
-- schwab_tokens: market data depends on schwab_tokens's "latest row"
-- read pattern (lib/schwab.ts::loadLatestTokenRow, ORDER BY updated_at
-- DESC LIMIT 1) — a shared table risks that query picking up this
-- app's token on a refresh race, and any invalidation path here must
-- be structurally unable to touch that row.
create table if not exists schwab_account_tokens (
  id uuid primary key default gen_random_uuid(),
  access_token text not null,
  refresh_token text not null,
  access_token_expires_at timestamptz not null,
  refresh_token_expires_at timestamptz not null,
  updated_at timestamptz default now()
);

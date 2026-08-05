-- Warn-only findings from the weekly price-date-mismatch detection
-- scan (scripts/detect-price-date-mismatch.ts). Flags earnings_history
-- rows whose price_before/price_after exactly match real Yahoo closes
-- on a chronologically-ordered, adjacent-day pair more than ~10 days
-- from earnings_date — the signature of the report-window-gap bug that
-- corrupted 13 rows found and repaired on 2026-08-05 (see
-- lib/encyclopedia.ts's isQuarterEndDate guard in fetchYahooPriceAction).
-- The scan never writes to earnings_history itself; repair stays a
-- deliberate, backed-up, reviewed action.
create table if not exists price_integrity_flags (
  id uuid primary key default gen_random_uuid(),
  symbol text not null,
  earnings_date date not null,
  stored_price_before numeric,
  stored_price_after numeric,
  stored_actual_move_pct numeric,
  matched_before_date date not null,
  matched_after_date date not null,
  gap_from_earnings_days integer not null,
  detected_at timestamptz not null default now(),
  last_confirmed_at timestamptz not null default now(),
  resolved_at timestamptz,
  unique (symbol, earnings_date)
);

create index if not exists price_integrity_flags_unresolved_idx
  on price_integrity_flags (symbol, earnings_date)
  where resolved_at is null;

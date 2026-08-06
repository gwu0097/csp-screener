-- Fiscal period data for earnings_history. Already fetched on every
-- ingest and discarded: Finnhub /stock/earnings returns `quarter`/
-- `year` (fiscal, used only as a lookup key into the Yahoo-backed
-- calendar match — lib/encyclopedia.ts) and `period` (fiscal
-- quarter-end date, used only as an earnings_date fallback). The
-- Yahoo-backed calendar fetch (misleadingly named
-- fetchFinnhubEarningsCalendar) parses `fiscalQuarter` ("NQYYYY",
-- explicitly distinct from calendarQuarter in the same payload) for
-- the same lookup-key purpose, and types `periodEndDate` without ever
-- reading it. This is additive: earnings_date semantics (the
-- announcement date) are unchanged.
alter table earnings_history add column if not exists fiscal_quarter integer;
alter table earnings_history add column if not exists fiscal_year integer;
alter table earnings_history add column if not exists period_end date;

-- Static per-company attribute (SEC EDGAR submissions.fiscalYearEnd,
-- MMDD format on the wire — stored here as just the month, 1-12).
-- Ticker-level, not per-event, so it lives on stock_encyclopedia
-- (one row per symbol, symbol UNIQUE) rather than earnings_history.
alter table stock_encyclopedia add column if not exists fiscal_year_end_month integer;

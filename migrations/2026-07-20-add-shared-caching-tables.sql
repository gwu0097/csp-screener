-- Three new caches identified by the Run Screen / Run Analysis caching
-- audit. Every reader of these tables must accept a force-fresh flag
-- that skips the read (but still writes the fresh result back) — see
-- lib/swing-screener.ts and lib/screener.ts call sites for the actual
-- bypass logic. No TTL is enforced at the database level; every table
-- just stamps last_refreshed_at and the reader decides staleness, so
-- the same row can be read with different freshness tolerances by
-- different callers if that's ever needed.

-- ---------------------------------------------------------------
-- 1. swing_quote_cache — the swing screener's Pass-1 quote sweep
-- (price, MA50/MA200, 52-week range, market cap, analyst target/
-- count, volume, revenue growth, short float). Fetched and cached as
-- ONE row per symbol deliberately — price must never be read fresher
-- than the MA/52w-range fields it's compared against, or the
-- qualification gates (vsMA50, vsMA200, pctFromHigh) silently go
-- incoherent. Application-level TTL: ~7 minutes.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS swing_quote_cache (
  symbol text PRIMARY KEY,
  company_name text,
  current_price numeric NOT NULL,
  price_change_1d numeric NOT NULL DEFAULT 0,
  ma50 numeric NOT NULL,
  ma200 numeric NOT NULL,
  week52_low numeric NOT NULL,
  week52_high numeric NOT NULL,
  analyst_target numeric,
  num_analysts integer NOT NULL DEFAULT 0,
  avg_volume_10d numeric NOT NULL,
  today_volume numeric NOT NULL,
  market_cap numeric NOT NULL,
  short_percent_float numeric,
  revenue_growth numeric,
  last_refreshed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS swing_quote_cache_refreshed_idx
  ON swing_quote_cache (last_refreshed_at);

-- ---------------------------------------------------------------
-- 2. finnhub_cache — generic response cache for Finnhub endpoints
-- that are effectively static intraday (insider transactions, next
-- earnings date, analyst recommendation counts, earnings-surprise
-- history). Shared by both screeners. Keyed on (symbol, endpoint)
-- only, not a params hash — every current call site uses a fixed
-- parameter shape per symbol, so this is deliberately not a general
-- HTTP cache. Application-level TTL: ~8 hours.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS finnhub_cache (
  symbol text NOT NULL,
  endpoint text NOT NULL,
  response jsonb NOT NULL,
  last_refreshed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (symbol, endpoint)
);

CREATE INDEX IF NOT EXISTS finnhub_cache_refreshed_idx
  ON finnhub_cache (last_refreshed_at);

-- ---------------------------------------------------------------
-- 3. daily_bars_cache — raw daily OHLCV bars, shared by the swing
-- screener's ATR14 (lib/swing-screener.ts fetchAtr14) and the CSP
-- screener's Stage 3 realized-vol proxy (lib/screener.ts
-- runStageThree). Both need "recent daily bars ending today"; caching
-- the raw bars once lets whichever screener runs first in a day warm
-- the cache for the other, rather than each keeping a separate
-- derived-value cache. Keyed by trading_day (the calendar date of the
-- most recent close in the array) so a stale read is a simple
-- date/timestamp check, not a market-calendar computation.
--
-- Callers MUST fall back to a live fetch if last_refreshed_at is more
-- than ~30 hours old (comfortably covers a normal overnight gap,
-- catches genuine multi-day staleness) — this fallback is NOT gated
-- by force-fresh, it's unconditional. See DAILY_BARS_STALE_MS in
-- lib/daily-bars-cache.ts.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS daily_bars_cache (
  symbol text NOT NULL,
  trading_day date NOT NULL,
  bars jsonb NOT NULL,
  last_refreshed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (symbol, trading_day)
);

CREATE INDEX IF NOT EXISTS daily_bars_cache_refreshed_idx
  ON daily_bars_cache (last_refreshed_at);

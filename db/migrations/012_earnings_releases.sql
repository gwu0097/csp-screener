-- Earnings releases extracted from 8-K filings.
-- Backed by /api/research/{symbol}/fetch-8k which finds the most recent
-- 8-K, fetches the 99.1 exhibit, asks Perplexity to pull structured
-- numbers (revenue / net income / EPS / op income / guidance), and
-- upserts a row keyed on (symbol, quarter).
--
-- raw_metrics holds anything the press release surfaced that's
-- company-specific (Adj EBITDA, segment cuts, KPI deltas) so the UI
-- can render extra rows without a schema change.

CREATE TABLE IF NOT EXISTS earnings_releases (
  id uuid default gen_random_uuid() primary key,
  symbol text not null,
  quarter text not null,
  period_end date not null,
  reported_date date not null,
  accession_number text,
  revenue numeric,
  revenue_growth_pct numeric,
  op_income numeric,
  op_margin_pct numeric,
  net_income numeric,
  net_margin_pct numeric,
  eps_diluted numeric,
  guidance_notes text,
  raw_metrics jsonb,
  source text default '8-K',
  created_at timestamptz default now(),
  UNIQUE(symbol, quarter)
);

CREATE INDEX IF NOT EXISTS earnings_releases_symbol_idx
  ON earnings_releases (symbol, reported_date DESC);

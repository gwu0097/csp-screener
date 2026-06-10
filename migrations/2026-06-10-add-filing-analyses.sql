-- Pasted Claude analyses per SEC filing (10-K tab on Deep Research).
-- One row per reviewed filing; (symbol, filing_type, period) is the
-- lookup key the UI uses to badge rows. filing_date + period keep the
-- row useful as a cross-stock research log for Intelligence queries.
CREATE TABLE IF NOT EXISTS filing_analyses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol VARCHAR(10) NOT NULL,
  filing_type VARCHAR(10) NOT NULL,
    -- '8-K', '10-Q', '10-K'
  period VARCHAR(20) NOT NULL,
    -- e.g. 'Q1 2026', 'FY2025'
  filing_date DATE,
    -- date of the filing
  analysis_text TEXT NOT NULL,
    -- pasted Claude response
  reviewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notes TEXT
    -- optional user notes added later
);

CREATE INDEX IF NOT EXISTS idx_filing_analyses_symbol
  ON filing_analyses (symbol);

CREATE INDEX IF NOT EXISTS idx_filing_analyses_symbol_period
  ON filing_analyses (symbol, filing_type, period);

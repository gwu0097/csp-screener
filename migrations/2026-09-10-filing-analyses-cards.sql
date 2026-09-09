-- Structured signal-card output for the Earnings Reports Stage A
-- analysis, alongside the existing free-text analysis_text (unchanged,
-- NOT NULL -- the manual "paste an analysis" flow stays prose-only and
-- populates only analysis_text; automated runs populate both: cards
-- with the real structured payload, analysis_text with a flattened
-- plain-text rendering generated from the same cards in code, purely
-- so the existing AnalysisViewPanel/AiSummaryBadge UI keeps showing
-- something readable until it's updated to render cards natively).
alter table filing_analyses add column if not exists cards jsonb;

-- Uniqueness on (symbol, filing_type, period): a re-run (automated
-- retry, or a manual re-paste of a corrected analysis) should replace
-- the existing row, not accumulate a duplicate. Caught live 2026-09-09
-- when two manual --force-symbol=NFLX diagnostic runs produced two
-- filing_analyses rows for the same (symbol, filing_type, period) --
-- harmless today only because the UI's analysisFor() happens to read a
-- recency-sorted list and .find()s the first (newest) match, silently
-- masking the duplicate rather than the schema preventing it.
alter table filing_analyses
  add constraint filing_analyses_symbol_type_period_key
  unique (symbol, filing_type, period);

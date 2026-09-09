-- Adds accession_number-based identity alongside the existing
-- (symbol, quarter) / (symbol, filing_type, period) uniqueness, so a
-- write can no longer silently overwrite a DIFFERENT correct quarter's
-- row just because a derived quarter label collided with it (the
-- 2026-09-10 HOOD Rule-606-decoy-filing incident: a wrong document, fed
-- to Perplexity, returned a plausible-but-wrong quarter label that
-- upserted over a different real quarter's row via the (symbol,quarter)
-- key alone). This migration adds the column/constraint; it does not by
-- itself prevent the mislabeling — see the write-time period_end guard
-- in lib/earnings-release-capture.ts (quarter_mismatch) for that half.

-- filing_analyses had no way to record which filing a card set came
-- from at all.
alter table filing_analyses add column if not exists accession_number text;

-- Backfill from earnings_releases via the (symbol, quarter) pairs that
-- are known-correct today (both known-corrupted HOOD rows are excluded
-- by name — they get the real accession_number once repaired through
-- the fixed pipeline, not backfilled from their current wrong state).
update filing_analyses fa
set accession_number = er.accession_number
from earnings_releases er
where fa.symbol = er.symbol
  and fa.period = er.quarter
  and fa.accession_number is null
  and not (fa.symbol = 'HOOD' and fa.period in ('Q4 2025', 'Q1 2026'));

-- NULLs are allowed to co-exist (standard unique-index behavior treats
-- each NULL as distinct) — rows never re-backfilled here just don't
-- participate in this identity check yet.
create unique index if not exists earnings_releases_symbol_accession_key
  on earnings_releases (symbol, accession_number);

create unique index if not exists filing_analyses_symbol_accession_key
  on filing_analyses (symbol, accession_number);

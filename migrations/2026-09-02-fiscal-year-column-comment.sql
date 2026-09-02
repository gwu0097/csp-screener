-- Documents what fiscal_year actually means after the 2026-09-04
-- eps-quarter repair, where DG proved it isn't purely "the company's own
-- SEC-filed fiscal year." See migrations/2026-08-06-add-fiscal-period-fields.sql
-- for the original column addition (no comment written there at the time).
--
-- fiscal_quarter/fiscal_year are written by lib/edgar-fiscal-period.ts from
-- SEC EDGAR's XBRL fp/fy tags — that's the company's own, authoritative
-- fiscal-period identity. But the whole reason these columns exist is to
-- serve as an exact-match key against Finnhub's quarter/year fields in
-- lib/eps-sweep.ts, and Finnhub's own numbering for a company's fiscal year
-- does not always agree with EDGAR's for the same real-world quarter
-- (confirmed for DG: EDGAR fy=2026, Finnhub year=2027, same Aug 2026
-- quarter — DG's fiscal_year was manually overwritten to 2027, Finnhub's
-- convention, specifically so the exact-match would work).
--
-- So: fiscal_year is EDGAR's convention by default, EXCEPT on rows where it
-- was deliberately overwritten to match Finnhub's convention instead,
-- purely to make matching possible. There is no column that records which
-- convention a given row's fiscal_year actually follows — reader beware.
-- The 2026-09-02 audit (EDGAR_EARNINGS_DATE_SPEC.md's companion follow-up,
-- see repo root) found this is not confined to null-outcome rows: OKTA's
-- 2026-08-26 row resolved and matched successfully, but to the WRONG
-- quarter, because eps-sweep captured it next-day (2026-08-27) before
-- Finnhub's own labels for the freshly-reported quarter had settled. A
-- "resolved"/"captured" outcome does not guarantee fiscal_year reflects
-- either convention correctly for that specific row.
comment on column earnings_history.fiscal_year is
  'Fiscal year identifier, EDGAR (us-gaap XBRL fy) convention by default. '
  'On some rows, deliberately overwritten to match Finnhub''s own '
  '(sometimes different) numbering for the same real quarter, so that '
  'lib/eps-sweep.ts''s exact-match against Finnhub can succeed -- see DG, '
  'manually corrected 2026-09-04. No column records which convention a '
  'given row follows. A non-null value here does not guarantee the row is '
  'correct -- see OKTA 2026-08-26 in the 2026-09-02 follow-up audit for a '
  'confirmed case of a successfully "resolved" row matching the wrong '
  'quarter''s data.';

comment on column earnings_history.fiscal_quarter is
  'Fiscal quarter (1-4), paired with fiscal_year -- see that column''s '
  'comment for the EDGAR-vs-Finnhub convention caveat, which applies '
  'identically here since the two are always written and matched together.';

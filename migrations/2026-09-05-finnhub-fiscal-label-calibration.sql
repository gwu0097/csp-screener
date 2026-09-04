-- Per-symbol calibration for translating Finnhub's synthetic fiscal
-- quarter/year labels back to the issuer's real ones, for off-calendar
-- fiscal-year companies where Finnhub's own quarter/year numbering
-- doesn't match the company's SEC filings (confirmed cases: BOX, HD,
-- LOW, TGT, ULTA, WSM all show quarter-1/year+1; DG shows quarter-
-- unchanged/year+1 -- two different transforms among closely
-- comparable off-calendar-FY companies, which is why this is a
-- per-symbol table, not a formula computed from fiscal_year_end_month).
--
-- Append-only in spirit: quarter_delta/year_delta are never edited in
-- place once calibrated. confirmed_count/last_confirmed_at DO update in
-- place -- they're bookkeeping on the SAME calibration event, not a new
-- one. When a calibration goes stale (see below) and is re-derived, a
-- NEW row is inserted rather than overwriting the old one's deltas, so
-- the full history of "this symbol used calibration A, then B" survives.
--
-- Read path: "the active calibration for a symbol" is the latest row
-- with invalidated_at IS NULL. See lib/finnhub-fiscal-calibration.ts.
create table finnhub_fiscal_label_calibration (
  id uuid primary key default gen_random_uuid(),
  symbol text not null,
  -- finnhub_quarter = our fiscal_quarter + quarter_delta (same for year)
  quarter_delta int not null,
  year_delta int not null,
  -- Informational only -- finnhub_period minus our period_end, in days.
  -- Not used to gate matching (quarter_delta/year_delta do that); kept
  -- as a secondary sanity signal for whoever reviews a calibration.
  period_delta_days int,
  calibrated_from_id uuid references earnings_history(id),
  calibrated_at timestamptz not null default now(),
  -- Incremented every time this calibration's predicted label is found
  -- and used again on a later quarter. A calibration confirmed_count=1
  -- has only ever worked once; confirmed_count=5 has held for 5
  -- quarters running -- a natural, visible confidence gradient.
  confirmed_count int not null default 1,
  last_confirmed_at timestamptz not null default now(),
  last_confirmed_row_id uuid references earnings_history(id),
  -- Set the moment a predicted label (our fiscal_quarter+quarter_delta,
  -- fiscal_year+year_delta) is NOT found anywhere in Finnhub's actual
  -- response for that symbol -- an unambiguous signal Finnhub's
  -- labeling for this ticker changed, not a guess. Once set, this row
  -- is no longer "the active calibration" and eps-sweep falls back to
  -- its normal out_of_window/unmatched classification rather than
  -- guessing with a stale delta.
  invalidated_at timestamptz,
  invalidated_reason text
);

create index finnhub_fiscal_label_calibration_symbol_idx
  on finnhub_fiscal_label_calibration (symbol, invalidated_at);

comment on table finnhub_fiscal_label_calibration is
  'Per-symbol delta translating our (issuer-correct) fiscal_quarter/'
  'fiscal_year to Finnhub''s own labeling for the same real quarter. '
  'Populated lazily, one symbol at a time, by auditing rows that show '
  'up in the unmatched/out_of_window queue -- never pre-calibrated in '
  'bulk. See lib/finnhub-fiscal-calibration.ts and lib/eps-sweep.ts.';

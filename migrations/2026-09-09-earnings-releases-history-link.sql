-- Links earnings_releases back to the earnings_history row that
-- triggered its capture. Proposed instead of relying on a nearest-date
-- join at read time (earnings_releases.reported_date to
-- earnings_history.earnings_date): verified clean today (zero
-- same-symbol earnings_history pairs within 10 days across all 3,050
-- rows; all 5 existing earnings_releases rows match their
-- earnings_history counterpart exactly, day_diff=0) -- but the
-- automated Stage A capture (lib/filing-analysis-capture.ts) already
-- knows the exact earnings_history_id from its own trigger, so
-- stamping it at write time is nearly free and removes the risk class
-- entirely rather than depending on quarterly-cadence behavior staying
-- clean (the EDGAR client's own comments already document a Finnhub
-- calendar-drift failure mode for earnings_date elsewhere in this
-- codebase). Nullable: existing rows and the manual "Fetch latest 8-K"
-- UI path (which has no earnings_history_id in hand) both leave it
-- null; only Stage A's automated writes populate it.
alter table earnings_releases add column if not exists earnings_history_id uuid references earnings_history(id);
create index if not exists idx_earnings_releases_history_id on earnings_releases (earnings_history_id);

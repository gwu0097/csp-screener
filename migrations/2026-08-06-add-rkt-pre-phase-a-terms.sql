-- Backfills the two terms found missing from observation_dictionary by
-- the coverage audit: acquisition_driven_growth and
-- commission_drag_low_premium, both from RKT / 2026-08-06
-- (checklist_version v2, predates the Phase A dictionary and its
-- curated 32-term seed). RKT's stored research_analyses row is
-- untouched — its candidate_flags already contains these terms; this
-- migration only backfills the dictionary + usage back-reference.
insert into observation_dictionary (term, definition, kind, use_count, first_used_at, last_used_at)
values
  (
    'acquisition_driven_growth',
    'Headline growth is driven by acquisitions rather than organic performance, so year-over-year comparisons are not like-for-like and integration commentary becomes a channel for disappointment that organic results would not have.',
    'setup_observation',
    1,
    '2026-08-06 15:32:47.257361+00',
    '2026-08-06 15:32:47.257361+00'
  ),
  (
    'commission_drag_low_premium',
    'On a low-priced underlying the absolute premium per contract is small enough that fixed per-leg commissions consume a material fraction of it, so a healthy-looking yield% overstates the realized return.',
    'setup_observation',
    1,
    '2026-08-06 15:32:47.257361+00',
    '2026-08-06 15:32:47.257361+00'
  )
on conflict (term) do nothing;

insert into observation_usages (term, symbol, earnings_date, created_at)
values
  ('acquisition_driven_growth', 'RKT', '2026-08-06', '2026-08-06 15:32:47.257361+00'),
  ('commission_drag_low_premium', 'RKT', '2026-08-06', '2026-08-06 15:32:47.257361+00')
on conflict (term, symbol, earnings_date) do nothing;

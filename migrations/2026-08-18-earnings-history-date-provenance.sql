-- Step 1 of the earnings_history write-layer fix (2026-08-18 audit): make
-- date_confidence and data_source honest. Both columns currently have a
-- silent DEFAULT that masks the fact that 6+ of the 11 live write paths
-- never state a value explicitly — a row's "confirmed" or "finnhub" label
-- today means "nothing downgraded it," not "something verified it."
--
-- NOT APPLIED YET. Written for review against 2,980 existing rows before
-- running. Do not run this without also being ready to update the ~6 write
-- paths that currently omit these columns (lib/earnings-history-table.ts's
-- persistLiveImpliedMove/persistFlowSnapshot, lib/encyclopedia.ts's
-- upsertHistoryStub/captureEarningsT0, app/api/screener/earnings-history/
-- update/route.ts's non-placeholder branch, app/api/screener/
-- fetch-em-history/route.ts's Yahoo fallback) — once the NOT NULL
-- constraints below land, every one of those INSERT/UPSERT calls starts
-- failing on its next write until it explicitly supplies both columns.
-- That write-path consolidation is Step 2, out of scope for this file.
--
-- ============================================================
-- PART 1 — date_confidence: trust tier for the earnings_date/timing pair
-- ============================================================
--
-- Old domain: 'confirmed' | 'low', nullable, DEFAULT 'confirmed'.
-- New domain: 'human_verified' | 'edgar_derived' | 'vendor_derived' |
-- 'inferred' | 'unknown' — compatible with the eventual cross-source
-- precedence (human-verified > EDGAR-derived > vendor-derived > inferred).
-- 'unknown' is a real, load-bearing value, not a placeholder: forcing an
-- unevidenced row into 'inferred' would assert "we know this is weak" when
-- the honest state is "we don't know anything about it."
--
-- Backfill evidence rule (see the accompanying report for full reasoning
-- and per-symbol worked examples):
--   - date_confidence was already 'low' (34 rows) -> inferred. Both origins
--     of 'low' (Phase 1's own quarter-end-fallback tag, and the manual
--     editor's placeholder-date-match flag) are real low-trust signals.
--   - date_confidence was 'confirmed' AND the row carries a fingerprint no
--     silently-defaulted writer can produce -> vendor_derived. The
--     fingerprint is: fiscal_quarter IS NOT NULL (only Phase 1 and Phase 2C
--     ever populate it), OR data_source = 'finnhub+calendar-rekey' (only
--     Phase 2C writes this literal string), OR (data_source =
--     'encyclopedia-live' AND timing_source = 'finnhub_hour') (only
--     upsertHistoryStub/T0 produce this combination), OR data_source =
--     'entry-context' (only linkEarningsEvent), OR timing_source IS NOT
--     NULL (every real value here — 'yahoo_timestamp_heuristic',
--     'finnhub_hour', 'manual' — is written only by Phase 1, Phase 2C, the
--     stub/T0 paths, or a human-reviewed batch script; none of the
--     silently-defaulted ambiguous writers ever touch timing_source).
--     Verified against all 552 orphaned implied_move_source='polygon' rows
--     specifically (19% of the table) as a forcing case: 525 land here,
--     4 in inferred, 23 in unknown — proportionally in line with the whole
--     table, confirming Polygon's removal (it only ever wrote
--     implied_move_pct/implied_move_source, never a date-related field)
--     doesn't need special-case handling in this rule.
--   - Everything else still 'confirmed' -> unknown. This is the largest
--     bucket (779 rows) precisely because the bare literal 'finnhub' is
--     structurally ambiguous — Phase 1 writes it deliberately, but so does
--     every silently-defaulted writer that never set data_source at all,
--     and the two are indistinguishable after the fact.
--   - human_verified: 0 rows today, and stays 0 after this migration. No
--     stored field distinguishes "a human typed this date into the
--     placeholder-resolve dialog" from "this date already existed and a
--     human only edited EM/Actual, never touching the date" — both hit the
--     identical upsert payload shape. Closing this gap is Step 2's job (a
--     real flag written at the moment of confirmation), not retroactively
--     assignable now. Per instruction, no row is promoted into this tier
--     without that evidence, regardless of implied_move_source='manual'.
--   - edgar_derived: 0 rows, reserved for Step 4.

-- Full pre-migration snapshot of both columns, keyed by id, before
-- either UPDATE below runs. Without this, collapsing 'finnhub' (2,573
-- rows, 86% of the table) into 'unknown_legacy_write' is a one-way
-- loss — 'finnhub' is itself an ambiguous label (see PART 2's own
-- comment), but ambiguous-but-present is still more than gone. Fully
-- reversible via: UPDATE earnings_history e SET data_source =
-- b.data_source, date_confidence = b.date_confidence FROM
-- backup_20260819_earnings_history_provenance_migration b WHERE
-- e.id = b.id. Matches this repo's existing convention for a
-- destructive rewrite (backup_20260803_earnings_history_timing_flip,
-- backup_20260805_earnings_history_price_repair).
create table backup_20260819_earnings_history_provenance_migration as
select id, symbol, earnings_date, data_source, date_confidence
from earnings_history;

alter table earnings_history drop constraint earnings_history_date_confidence_check;

-- Interim default so no in-flight insert can land mid-backfill claiming a
-- stale 'confirmed' before the real backfill below runs.
alter table earnings_history alter column date_confidence set default 'unknown';

update earnings_history
set date_confidence = 'inferred'
where date_confidence = 'low';

update earnings_history
set date_confidence = 'vendor_derived'
where date_confidence = 'confirmed'
  and (
    fiscal_quarter is not null
    or data_source = 'finnhub+calendar-rekey'
    or (data_source = 'encyclopedia-live' and timing_source = 'finnhub_hour')
    or data_source = 'entry-context'
    or timing_source is not null
  );

update earnings_history
set date_confidence = 'unknown'
where date_confidence = 'confirmed';

alter table earnings_history
  add constraint earnings_history_date_confidence_check
  check (date_confidence in ('human_verified', 'edgar_derived', 'vendor_derived', 'inferred', 'unknown'));

alter table earnings_history alter column date_confidence set not null;

-- ============================================================
-- PART 2 — data_source: which write path produced this row
-- ============================================================
--
-- Same silent-default bug (DEFAULT 'finnhub'::text), same treatment. This
-- column already serves the "which write path" role a brand-new column
-- would otherwise have duplicated — hardening it in place instead of
-- adding a parallel `date_source` column avoids two overlapping provenance
-- fields with no clear precedence between them.
--
-- New domain: one value per live write path (11 today, confirmed via a
-- fresh grep of every `.from("earnings_history")` call chained to
-- .upsert/.update/.insert across lib/, app/api/, scripts/ — re-verified,
-- not reused from a prior pass), plus two catch-alls:
--   - 'manual_repair_script': every one-off audit/repair/backfill script
--     (30+ files in scripts/, an open-ended and still-growing set — not
--     given individual enum values, since most run exactly once and a new
--     CHECK-constraint migration for every future throwaway script isn't
--     worth it; if a script becomes a recurring job it should earn its own
--     value then, same as any production writer). Also covers the KEYS
--     data_source='schwab' rows (2024-11-19, 2025-02-25, 2026-05-19) — no
--     live code path writes that literal string; those 3 rows were a
--     direct SQL UPDATE run in-session at the user's explicit request,
--     the same category as a one-off script.
--   - 'unknown_legacy_write': the bare literal 'finnhub' (2,573 rows,
--     86% of the table) is NOT reclassified more specifically than this.
--     Unlike the date_confidence fingerprint rule above (which only needs
--     to ask "is there ANY evidence of vendor involvement," a question
--     fiscal_quarter's mere presence can answer even under ambiguity),
--     attributing a row to a SPECIFIC path requires the stored value to be
--     unique to that path — and 'finnhub' is written both deliberately by
--     Phase 1 AND by coincidence by every silently-defaulted writer that
--     never set data_source at all. Splitting this bucket by fiscal_quarter
--     presence was considered and rejected: Phase 1 can legitimately
--     produce fiscal_quarter=null too (when Finnhub's own data is
--     incomplete), so absence doesn't prove a different writer produced
--     it. No split of this literal string is honest without guessing.
--
-- Reserved-for-Step-2 values (0 rows today, added now so Step 2's writer
-- updates don't need another migration): 'encyclopedia_phase1_finnhub',
-- 'live_em_tracker', 'live_flow_snapshot', 't0_capture', 'manual_em_editor'.

alter table earnings_history alter column data_source drop default;

update earnings_history set data_source = 'encyclopedia_phase2c_rekey' where data_source = 'finnhub+calendar-rekey';
update earnings_history set data_source = 'encyclopedia_live_stub' where data_source = 'encyclopedia-live';
update earnings_history set data_source = 'entry_context_stub' where data_source = 'entry-context';
update earnings_history set data_source = 'manual_repair_script' where data_source = 'schwab';
update earnings_history set data_source = 'fetch_em_yahoo_seed' where data_source = 'yahoo';
update earnings_history set data_source = 'unknown_legacy_write' where data_source = 'finnhub';

alter table earnings_history
  add constraint earnings_history_data_source_check
  check (data_source in (
    'entry_context_stub',
    'live_em_tracker',
    'live_flow_snapshot',
    'encyclopedia_phase1_finnhub',
    'encyclopedia_phase2c_rekey',
    'encyclopedia_live_stub',
    't0_capture',
    'manual_em_editor',
    'fetch_em_yahoo_seed',
    'manual_repair_script',
    'unknown_legacy_write'
  ));

alter table earnings_history alter column data_source set not null;

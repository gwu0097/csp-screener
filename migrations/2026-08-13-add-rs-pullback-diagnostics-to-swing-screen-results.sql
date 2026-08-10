-- A zero-candidate RS Pullback run is now saved (see app/api/swings/screen/
-- save/route.ts) instead of being silently skipped — "this universe
-- produced nothing today" is itself an observation worth keeping in the
-- append-only history. This column carries the pregate/enrichment funnel
-- counts (pregatedCount, needsEnrichmentCount, excludedBySectorPrefilter,
-- excludedBySma50RisingPrefilter, excludedBySma50RisingEnrichment,
-- insufficientData, degradedCount) so a zero-candidate row still explains
-- why: nothing pregated, vs. pregated-but-excluded, vs. evaluated-and-
-- disqualified. Nullable — legacy rows and rows saved before this column
-- existed simply don't have it. Only meaningful for kind='rs_pullback'.

alter table swing_screen_results add column if not exists rs_pullback_diagnostics jsonb;

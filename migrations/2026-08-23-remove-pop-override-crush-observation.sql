-- Tradable Grade restructure: crush leaves the finalGrade cascade
-- entirely (lib/tradable-grade.ts), so pop_override_on_failing_crush
-- ("Rule B lets POP >= 95% override a failing crush grade") no longer
-- describes a live defect — there is no crush term left in the
-- cascade for POP to override. The grade audit that flagged this term
-- also found crush graded F on DDOG/SNDK/ELF, all three profitable —
-- crush wasn't a defect being incorrectly overridden, it was a
-- non-predictive component the cascade was correctly routing around.
--
-- usages deleted first — observation_usages.term has no ON DELETE
-- CASCADE (see migrations/2026-08-06-add-observation-dictionary.sql),
-- so deleting the dictionary row first would fail on the FK. Stored
-- research_analyses.candidate_flags arrays are left untouched — this
-- only removes the dictionary definition and its usage back-references,
-- matching the flag_vocabulary_mapping precedent of never rewriting a
-- stored row.
delete from observation_usages where term = 'pop_override_on_failing_crush';
delete from observation_dictionary where term = 'pop_override_on_failing_crush';

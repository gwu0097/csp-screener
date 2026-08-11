-- Maps a checklist flag's stored (version-specific) string to its
-- canonical term, so a scoring query can group occurrences across
-- template versions without rewriting any stored research_analyses row.
-- The raw strings in flags_fired/flags_na/flags_unknown stay exactly as
-- written — this table is a read-side lookup, not a rename.
--
-- Rows exist ONLY for terms whose stored string differs from the
-- current canonical name. A term never renamed (the common case) has
-- no row here; a scoring query does
--   coalesce(m.canonical_term, raw_term) as canonical
-- via a left join, so an unmapped term is trivially its own canonical
-- form. Do not add identity rows (term mapped to itself) for unchanged
-- terms — that's redundant with the coalesce and would need upkeep
-- every time a new checklist version ships without a rename.
--
-- Scoped to the fixed Part-1 checklist vocabulary (7 items,
-- lib/research-analysis-parser.ts's KNOWN_FLAG_VOCABULARY) — the
-- freeform candidate-flags/candidate-observations vocabulary already
-- has its own alias mechanism (observation_dictionary.aliases).
create table if not exists flag_vocabulary_mapping (
  canonical_term text not null,
  alias_term text not null,
  checklist_version text not null,
  note text,
  primary key (alias_term, checklist_version)
);

create index if not exists flag_vocabulary_mapping_canonical_idx
  on flag_vocabulary_mapping (canonical_term);

-- The one rename lib/research-analysis-parser.ts's own comments
-- document: v1/v2 called this item guidance_streak_extrapolated; v3
-- renamed it to guidance_beat_streak. Not renamed in place — the v1/v2
-- framing ("extrapolated from a streak") and the v3+ framing ("beaten
-- the streak") genuinely differ and that difference stays visible on
-- the stored row; this mapping only lets a scoring query treat them as
-- the same underlying checklist item.
insert into flag_vocabulary_mapping (canonical_term, alias_term, checklist_version, note)
values (
  'guidance_beat_streak',
  'guidance_streak_extrapolated',
  'v1',
  'v1/v2 name for the same checklist item, renamed to guidance_beat_streak in v3 — see lib/research-analysis-parser.ts KNOWN_FLAG_VOCABULARY comment'
)
on conflict (alias_term, checklist_version) do nothing;

insert into flag_vocabulary_mapping (canonical_term, alias_term, checklist_version, note)
values (
  'guidance_beat_streak',
  'guidance_streak_extrapolated',
  'v2',
  'v1/v2 name for the same checklist item, renamed to guidance_beat_streak in v3 — see lib/research-analysis-parser.ts KNOWN_FLAG_VOCABULARY comment'
)
on conflict (alias_term, checklist_version) do nothing;

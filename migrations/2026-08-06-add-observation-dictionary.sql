-- Observation dictionary: CANDIDATE_FLAGS (research analysis template v1-v3)
-- was a bare comma-separated list with term meaning living only in prose.
-- v4 replaces it with a CANDIDATE_OBSERVATIONS block that requires a
-- definition on first use of a term; this table is that dictionary.
--
-- term is the natural primary key (snake_case, unique), matching the
-- research_analyses(symbol, earnings_date) natural-key precedent rather
-- than a surrogate uuid. `on update cascade` lets a future Phase C merge
-- rename a term in place without a manual usages rewrite.
create table if not exists observation_dictionary (
  term text primary key,
  definition text not null,
  kind text not null check (kind in ('setup_observation', 'app_defect')),
  use_count integer not null default 0,
  first_used_at timestamptz,
  last_used_at timestamptz,
  aliases text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Back-reference from term to the analyses that used it. Required so a
-- future Phase C merge (rewriting affected records) knows which analyses
-- to touch instead of scanning every raw_paste. Intentionally has no FK
-- to research_analyses: some cited usages (seed fallback citations, or a
-- term used in a paste that was never saved) may not correspond to a
-- stored research_analyses row.
create table if not exists observation_usages (
  term text not null references observation_dictionary(term) on update cascade,
  symbol text not null,
  earnings_date date not null,
  created_at timestamptz not null default now(),
  unique (term, symbol, earnings_date)
);
create index if not exists observation_usages_term_idx on observation_usages (term);
create index if not exists observation_usages_symbol_earnings_idx on observation_usages (symbol, earnings_date);

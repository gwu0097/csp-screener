-- Advisory-only research analysis captured from an external LLM
-- conversation (see lib/analysis-dump-template.ts's ANALYSIS_TEMPLATE,
-- appended to the Analysis Dump's Copy Dump output). This table never
-- feeds the numeric grade, never vetoes a trade, and is never joined
-- into any scoring path — it exists purely to be read back by a human.
--
-- Keyed by (symbol, earnings_date): one analysis per ticker per
-- quarter, editable and re-saveable (a re-paste for the same quarter
-- overwrites, not duplicates).
--
-- Setup values are snapshotted at analysis time, not joined to live
-- data later — spot/EM/grade all change after the fact, and the point
-- of this table is "what did the setup look like when this analysis
-- was written," not "what does it look like now."
--
-- No traded/skipped field by design — that's inferable by joining to
-- positions on symbol + earnings_date when needed.
create table if not exists research_analyses (
  symbol text not null,
  earnings_date date not null,

  -- Parsed from the pasted response's metadata block. Strings, not
  -- enums — flags_unknown and candidate_flags always originate from
  -- v1's fixed checklist vocabulary or freeform LLM proposals, but
  -- flags_fired can too as the vocabulary grows across template
  -- versions; enumerating them here would mean a migration every time
  -- the checklist changes.
  flags_fired text[] not null default '{}',
  flags_unknown text[] not null default '{}',
  candidate_flags text[] not null default '{}',
  checklist_version text,
  template_version text,

  analysis_prose text,
  raw_paste text not null,
  parse_status text not null check (parse_status in ('parsed', 'prose_only', 'partial')),

  reference_strike numeric,
  spot_at_analysis numeric,
  em_pct_at_analysis numeric,
  numeric_grade text,
  crush_grade text,
  max_downside_ratio numeric,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  primary key (symbol, earnings_date)
);

create index if not exists research_analyses_symbol_idx on research_analyses (symbol);

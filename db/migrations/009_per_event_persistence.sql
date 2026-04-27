-- Run in Supabase SQL editor.
-- Two persistence fixes that prepare the encyclopedia CSP History tab.
--
-- (1) screener_crush_context rows are tied to the calendar day the
--     Perplexity call ran (UNIQUE(symbol, analyzed_date)). When SPOT
--     reports next quarter the Q1 2026 trade-decision context is
--     overwritten by the new run on a different day. We need rows
--     keyed by the earnings event so historical context persists.
--
-- (2) earnings_history rows already store implied_move_pct for an
--     upcoming event, but no positioning snapshot. Adding per-event
--     options-flow fields lets future quarters compare what flow
--     looked like before a print to what actually happened.
--
-- Additive — safe to re-run.

-- ---------- 1) screener_crush_context: per-event keying ----------

alter table screener_crush_context
  add column if not exists earnings_date date;

-- Drop the old (symbol, analyzed_date) unique constraint. Default
-- autoname from `unique(symbol, analyzed_date)` is below; the DO block
-- catches any non-default name as a fallback.
alter table screener_crush_context
  drop constraint if exists screener_crush_context_symbol_analyzed_date_key;

do $$
declare cn text;
begin
  select c.conname into cn
  from pg_constraint c
  where c.conrelid = 'public.screener_crush_context'::regclass
    and c.contype = 'u'
    and (
      select array_agg(att.attname order by att.attname)
      from unnest(c.conkey) col(num)
      join pg_attribute att
        on att.attrelid = c.conrelid and att.attnum = col.num
    ) = array['analyzed_date', 'symbol']::text[]
  limit 1;
  if cn is not null then
    execute format(
      'alter table public.screener_crush_context drop constraint %I',
      cn
    );
  end if;
end $$;

-- Add the new (symbol, earnings_date) unique constraint.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'screener_crush_context_symbol_earnings_date_key'
  ) then
    alter table screener_crush_context
      add constraint screener_crush_context_symbol_earnings_date_key
      unique (symbol, earnings_date);
  end if;
end $$;

-- ---------- 2) earnings_history: options flow snapshot ----------

alter table earnings_history
  add column if not exists flow_pc_ratio numeric(5, 3),
  add column if not exists flow_bias text
    check (flow_bias is null or flow_bias in ('bullish', 'neutral', 'bearish')),
  add column if not exists flow_deep_otm_put_pct numeric(5, 2),
  add column if not exists flow_unusual_top3 jsonb,
  add column if not exists flow_captured_at timestamptz;

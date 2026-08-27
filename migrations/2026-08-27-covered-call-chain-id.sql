-- Roll-chain linking for covered calls, tracked separately from
-- trade_chain_id. lib/trade-chains.ts's CSP chain builder deliberately
-- excludes covered calls (option_type='call' AND direction='short')
-- from classification entirely (2026-08-27 fix — that classifier's
-- deep-ITM/wheel-sweep logic is CSP-put-specific and mislabeled a
-- normal covered-call roll as "rolled recovery"). This is a fresh,
-- dedicated column rather than reusing trade_chain_id so a covered
-- call can never accidentally show up to the CSP-only readers that
-- already explicitly exclude broker='covered_calls'
-- (app/api/intelligence/route.ts, lib/screener.ts).
--
-- See lib/covered-call-chains.ts for the (much simpler than CSP
-- chains) roll-adjacency linking logic: no assignment-wheel sweep
-- needed since the same shares back every leg of a covered-call roll
-- until final assignment.
alter table positions add column if not exists covered_call_chain_id uuid;

create index if not exists positions_covered_call_chain_id_idx
  on positions (covered_call_chain_id) where covered_call_chain_id is not null;

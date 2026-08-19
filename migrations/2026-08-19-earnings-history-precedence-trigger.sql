-- Phase B precedence trigger. DO NOT apply until every writer touching
-- earnings_date/timing/date_confidence/data_source is routed through
-- lib/earnings-history-writer.ts and that deploy has been verified live.
-- Landing this ahead of the writer migration reproduces the 2026-08-18
-- outage: any caller still issuing a raw .upsert()/.update() on these
-- columns would start throwing P0001 with no code able to catch it.
--
-- Rejects an UPDATE that would change any of the 4 protected columns
-- AND move date_confidence to a strictly lower tier than what's stored.
-- Equal tier and higher tier both pass. INSERTs are never evaluated —
-- there's no prior tier to compare against, and the writer only ever
-- inserts with an explicit tier of its own.
create or replace function earnings_history_precedence_guard() returns trigger as $$
declare
  tier_rank text[] := array['unknown','inferred','vendor_derived','edgar_derived','human_verified'];
  old_rank int;
  new_rank int;
begin
  if new.earnings_date is distinct from old.earnings_date
     or new.timing is distinct from old.timing
     or new.date_confidence is distinct from old.date_confidence
     or new.data_source is distinct from old.data_source
  then
    old_rank := array_position(tier_rank, old.date_confidence);
    new_rank := array_position(tier_rank, new.date_confidence);
    if new_rank < old_rank then
      raise exception 'earnings_history_precedence_guard: % % rejected — % (rank %) would downgrade % (rank %)',
        new.symbol, new.earnings_date, new.date_confidence, new_rank, old.date_confidence, old_rank
        using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists earnings_history_precedence_guard_trg on earnings_history;
create trigger earnings_history_precedence_guard_trg
  before update on earnings_history
  for each row
  execute function earnings_history_precedence_guard();

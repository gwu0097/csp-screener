-- Backup before repairing corrupted covered-call position_snapshots rows.
--
-- Root cause: writeOpenPositionSnapshots() (lib/snapshots.ts) and
-- writePositionSnapshots() (app/api/screener/analyze/pass3/route.ts)
-- both queried `positions` without selecting option_type, so
-- buildSnapshotRow() defaulted every position — puts and covered calls
-- alike — to "put", pricing every call position from the PUT side of
-- the chain (the mirror instrument at the same strike: deep OTM as a
-- call is deep ITM as a put). Fixed in the same commit as this
-- migration; this backs up the rows before the option-derived fields
-- on the identified-corrupted rows are nulled so they recompute
-- correctly on the next snapshot run.
--
-- Identification: option_type='call' AND current_delta < 0. This is an
-- unambiguous fingerprint — this app's convention (confirmed against a
-- known-correct historical snapshot) stores call deltas as >= 0 always;
-- a negative delta on a call row is only possible if it was priced
-- against a put contract. 75 rows across 7 positions (CELH x2, FUBO,
-- SHOP x2, MSFT [closed], ZS [closed]) as of 2026-08-06.
create table if not exists backup_20260806_call_snapshot_repair as
select ps.*
from position_snapshots ps
join positions p on p.id = ps.position_id
where p.option_type = 'call'
  and ps.current_delta is not null
  and ps.current_delta < 0;

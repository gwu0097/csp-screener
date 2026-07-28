-- Applies the two data corrections confirmed by the 2026-07-28 import
-- audit. Run only after 2026-07-28-glw-phantom-be-premium-fix-backup.sql
-- has captured both affected positions/fills.

-- 1. Delete the GLW $100P phantom (hallucinated duplicate of the real
--    UPS $100P/3-contract close, position eb0dc8ba — left untouched).
--    No corresponding broker row exists for this GLW position at all.
delete from fills where position_id = '2f771a3d-f134-43e5-bf10-3042575519e4';
delete from positions where id = '2f771a3d-f134-43e5-bf10-3042575519e4';

-- 2. Correct the three BE $90P close fills that were stored at $0.0000
--    when the ledger prints $0.24 in that leg's own Price column. The
--    4-contract @0.16 close on the same position is correct and is not
--    touched (excluded by the explicit id list below).
update fills
set premium = 0.24
where id in (
  'a2c5f1ac-e3b1-4b5b-a2af-e5097a015a3f', -- close, 2 contracts, 20:04:47.146
  '0a9b6340-1c01-4d61-b7e7-ac4c28546c72', -- close, 1 contract,  20:04:47.566
  '96bb6336-7abf-461c-8f63-254215ceadc4'  -- close, 2 contracts, 20:04:47.958
)
and position_id = 'ded8591e-65e3-4d3a-a7b1-c28481ea8f6c'
and premium = 0.0000;

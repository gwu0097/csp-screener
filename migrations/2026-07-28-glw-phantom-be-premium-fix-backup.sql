-- Mandatory rollback path before correcting the two confirmed 2026-07-28
-- import defects (see DATA-ARCHITECTURE-AUDIT thread same day). Snapshots
-- both affected positions and their fills, verbatim, before any
-- DELETE/UPDATE runs.
--
-- Scope:
--   1. GLW $100P phantom position 2f771a3d-f134-43e5-bf10-3042575519e4
--      (3 contracts, $0.04, opened 2026-07-28) — a hallucinated duplicate
--      of a real UPS $100P/3-contract close (position eb0dc8ba, unaffected).
--      No corresponding broker row exists — to be deleted outright.
--   2. BE $90P position ded8591e-65e3-4d3a-a7b1-c28481ea8f6c — 3 of its 4
--      close fills were stored at premium $0.0000 when the ledger prints
--      $0.24 in that leg's own Price column (CREDIT/DEBIT net-summary bug).
--      To be corrected from 0.0000 to 0.24 (fills at 20:04:47.146 / .566 /
--      .958 UTC, contracts 2 / 1 / 2). The 4-contract @0.16 close is
--      correct and untouched.
create table if not exists backup_20260728_glw_phantom_be_premium_positions as
select * from positions
where id in (
  '2f771a3d-f134-43e5-bf10-3042575519e4',
  'ded8591e-65e3-4d3a-a7b1-c28481ea8f6c'
);

create table if not exists backup_20260728_glw_phantom_be_premium_fills as
select * from fills
where position_id in (
  '2f771a3d-f134-43e5-bf10-3042575519e4',
  'ded8591e-65e3-4d3a-a7b1-c28481ea8f6c'
);

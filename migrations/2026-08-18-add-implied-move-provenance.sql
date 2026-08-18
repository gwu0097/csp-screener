-- Provenance for a manually-entered implied move: which options expiry
-- the ATM straddle % was read from, and the calendar date it was read
-- (distinct from created_at, which only records when the row was saved
-- to this table, not necessarily when the value was looked up on
-- ThinkorSwim). Both nullable — every existing row stays valid with
-- no backfill required, and these are prompted for but not required
-- on new manual entries either (a real vol-regime shift or a quick
-- entry should still be enterable without them).
--
-- Added after a 2026-08-18 audit found 12 of 166 manual implied-move
-- rows statistically implausible against their own symbol's history
-- (see lib/earnings-history-table.ts's checkImpliedMovePlausibility),
-- with zero way to verify any of them after the fact — no capture log
-- entry, no live IV read, and no record of which expiry a straddle
-- came from. Without these two fields, the leading hypothesis for any
-- future flag (e.g. a straddle read from a longer-dated expiry than
-- the front weekly) stays permanently unfalsifiable, exactly as it is
-- for the 12 already flagged.
alter table earnings_history
  add column if not exists implied_move_expiry date,
  add column if not exists implied_move_read_date date;

-- Badge priority fix: MAX_PROFIT now outranks the post-earnings
-- recommendation (see computePositionBadge), but the rec itself never
-- decayed — CLOSE_MEDIUM_MOVE fires off a frozen earnings_history.
-- move_ratio and keeps re-upserting at MEDIUM confidence indefinitely
-- for as long as the position stays open and inside the 4-day
-- findRecentEarningsRow window. computePositionBadge needs to know how
-- many trading sessions have passed since the actual print to expire a
-- stale rec — post_earnings_recommendations doesn't store that date
-- directly (only earnings_history_id, a FK), so this adds it as its
-- own column rather than joining at every badge computation.
alter table post_earnings_recommendations
  add column if not exists earnings_date date;

update post_earnings_recommendations per
set earnings_date = eh.earnings_date
from earnings_history eh
where per.earnings_history_id = eh.id
  and per.earnings_date is null;

create index if not exists post_earnings_recommendations_earnings_date_idx
  on post_earnings_recommendations (earnings_date);

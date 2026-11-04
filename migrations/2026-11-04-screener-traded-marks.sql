-- Manual "already traded" marks for screener rows.
--
-- The screener's Traded chip (components/screener-view.tsx) is normally
-- derived from synced positions (lib/traded-status.ts). This table only
-- holds the user's own marks for trades the broker sync hasn't picked
-- up yet. A row's presence means "marked traded"; unmarking deletes it.
-- Keyed on (symbol, earnings_date), the same event key campaigns and
-- research_analyses use, so a mark applies to one print, not the ticker.
--
-- RLS on with no policies: only the service-role server client (which
-- bypasses RLS) can touch it, and the route scopes every query by
-- requireUserId(). The anon browser key gets nothing.
create table if not exists screener_traded_marks (
  user_id uuid not null,
  symbol text not null,
  earnings_date date not null,
  created_at timestamptz not null default now(),
  primary key (user_id, symbol, earnings_date)
);

alter table screener_traded_marks enable row level security;

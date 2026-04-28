-- Filing journal notes — manual annotations the user pastes from a
-- Claude review session back into the app. Surfaced inside the
-- "Prior Journal Notes" section of every Export for Review markdown
-- so subsequent reviews carry forward prior context without the user
-- re-scrolling the chat.

CREATE TABLE IF NOT EXISTS filing_notes (
  id uuid default gen_random_uuid() primary key,
  symbol text not null,
  quarter text,           -- 'Q1 2026' or 'FY 2025' (optional — free-form journal note may not target a specific filing)
  filing_type text,       -- '8-K' | '10-Q' | '10-K' | null for general notes
  period_end date,
  notes text not null,    -- the journal entry body
  key_risks text[],       -- bullet list of risk takeaways
  key_tailwinds text[],   -- bullet list of tailwind takeaways
  trade_relevance text,   -- 'bullish' | 'bearish' | 'neutral'
  created_at timestamptz default now()
);

CREATE INDEX IF NOT EXISTS filing_notes_symbol_idx
  ON filing_notes (symbol, created_at DESC);

-- Named screener configurations. Rows mirror the ScreenerConfig shape
-- in lib/screener-config.ts (filters is the Record<string, {value,
-- label}> map). System presets (is_system) are seeded by the app on
-- first read of an empty table and cannot be edited or deleted via
-- the API; users clone them into custom rows instead.
CREATE TABLE IF NOT EXISTS screener_configs (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  filters     JSONB NOT NULL,
  notes       TEXT NOT NULL DEFAULT '',
  is_system   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

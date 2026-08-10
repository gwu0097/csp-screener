-- Universe & Themes, Phase B: record which universe a saved screen run was
-- screened against. Nullable — existing rows predate universe selection
-- and are simply "unknown" rather than backfilled with an assumption.
--
-- Shape (set by app/api/swings/screen/save/route.ts):
--   {
--     includeIndex: boolean,
--     themeIds: string[],
--     allThemes: boolean,
--     themeNames: string[],   -- snapshot at run time, survives a later
--                             -- theme rename/delete
--     resolvedCount: number,
--     label: string           -- e.g. "S&P 500 + Nasdaq 100 + AI Infrastructure"
--   }

alter table swing_screen_results add column if not exists universe jsonb;

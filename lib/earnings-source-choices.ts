// The user's "which calendar is right?" answers
// (earnings_source_choices, migrations/2026-11-04-robinhood-earnings-
// calendar.sql). Personal data: every query is scoped by user_id.
import { createServerClient } from "@/lib/supabase";
import type { SourceChoice } from "@/lib/earnings-source-merge";

// Only recent choices can match a current conflict (a conflict key
// carries both sources' dates, which are today/tomorrow-ish).
const CHOICE_LOOKBACK_DAYS = 14;

export async function loadSourceChoices(userId: string): Promise<SourceChoice[]> {
  const sb = createServerClient();
  const since = new Date(Date.now() - CHOICE_LOOKBACK_DAYS * 86_400_000).toISOString();
  const res = await sb
    .from("earnings_source_choices")
    .select("symbol,conflict_key,chosen_source,chosen_date,chosen_timing")
    .eq("user_id", userId)
    .gte("created_at", since)
    .limit(1000);
  if (res.error) throw new Error(`earnings_source_choices read failed: ${res.error.message}`);
  return ((res.data ?? []) as Array<{
    symbol: string;
    conflict_key: string;
    chosen_source: SourceChoice["chosenSource"];
    chosen_date: string;
    chosen_timing: SourceChoice["chosenTiming"];
  }>).map((r) => ({
    symbol: r.symbol,
    conflictKey: r.conflict_key,
    chosenSource: r.chosen_source,
    chosenDate: r.chosen_date,
    chosenTiming: r.chosen_timing,
  }));
}

export async function saveSourceChoice(userId: string, c: SourceChoice): Promise<void> {
  const sb = createServerClient();
  const res = await sb.from("earnings_source_choices").upsert(
    {
      user_id: userId,
      symbol: c.symbol,
      conflict_key: c.conflictKey,
      chosen_source: c.chosenSource,
      chosen_date: c.chosenDate,
      chosen_timing: c.chosenTiming,
      created_at: new Date().toISOString(),
    },
    { onConflict: "user_id,symbol,conflict_key" },
  );
  if (res.error) throw new Error(res.error.message);
}

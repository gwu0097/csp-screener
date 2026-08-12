import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import {
  buildChecklistItemsView,
  type ObservationDictionaryEntry,
  type ObservationUsage,
} from "@/lib/observation-dictionary";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// Read-only dictionary of CANDIDATE_OBSERVATIONS terms (research
// analysis template v4+, see lib/analysis-dump-template.ts and
// lib/research-analysis-parser.ts). Two callers:
//   - components/research-analysis-paste.tsx fetches this on mount to
//     classify a freshly-parsed paste's observations against known
//     terms before the user can save (new+undefined blocks save, an
//     existing term redefined surfaces a warning).
//   - app/screener/dictionary/page.tsx renders the whole table.
// Writes happen only through POST /api/screener/research-analysis (a
// save upserts terms it introduces or reuses) and the one-time seed
// script — there is no direct write route for this table.
//
// Both entries and usages are returned in full, unpaginated. Fine at
// Phase A's scale (~240 analyses/year, a few observations each); once
// observation_usages nears the wrapper's ~1000-row read cap, switch to
// the cursor-pagination pattern used elsewhere for large tables (see
// scripts/*.ts backfills) rather than this single .select("*").
//
// checklistItems is a THIRD, separate section for the dictionary page
// only (research-analysis-paste.tsx ignores it) — the fixed 7-item
// Part 1 checklist, sourced from the template + research_analyses.
// flags_fired, not from observation_dictionary/observation_usages
// (those only ever held freeform CANDIDATE_OBSERVATIONS terms). Same
// unpaginated caveat applies once research_analyses nears the cap.
export async function GET() {
  const sb = createServerClient();

  const [entriesRes, usagesRes, analysesRes] = await Promise.all([
    sb.from("observation_dictionary").select("*").order("term", { ascending: true }),
    sb.from("observation_usages").select("*").order("created_at", { ascending: false }),
    sb.from("research_analyses").select("symbol,earnings_date,flags_fired"),
  ]);

  if (entriesRes.error) {
    return NextResponse.json({ error: entriesRes.error.message }, { status: 500 });
  }
  if (usagesRes.error) {
    return NextResponse.json({ error: usagesRes.error.message }, { status: 500 });
  }
  if (analysesRes.error) {
    return NextResponse.json({ error: analysesRes.error.message }, { status: 500 });
  }

  const analyses = (analysesRes.data ?? []) as Array<{
    symbol: string;
    earnings_date: string;
    flags_fired: string[] | null;
  }>;

  return NextResponse.json({
    entries: (entriesRes.data ?? []) as ObservationDictionaryEntry[],
    usages: (usagesRes.data ?? []) as ObservationUsage[],
    checklistItems: buildChecklistItemsView(
      analyses.map((a) => ({ symbol: a.symbol, earnings_date: a.earnings_date, flags_fired: a.flags_fired ?? [] })),
    ),
  });
}

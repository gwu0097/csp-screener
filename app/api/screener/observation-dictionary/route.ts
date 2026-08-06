import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import type { ObservationDictionaryEntry, ObservationUsage } from "@/lib/observation-dictionary";

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
export async function GET() {
  const sb = createServerClient();

  const [entriesRes, usagesRes] = await Promise.all([
    sb.from("observation_dictionary").select("*").order("term", { ascending: true }),
    sb.from("observation_usages").select("*").order("created_at", { ascending: false }),
  ]);

  if (entriesRes.error) {
    return NextResponse.json({ error: entriesRes.error.message }, { status: 500 });
  }
  if (usagesRes.error) {
    return NextResponse.json({ error: usagesRes.error.message }, { status: 500 });
  }

  return NextResponse.json({
    entries: (entriesRes.data ?? []) as ObservationDictionaryEntry[],
    usages: (usagesRes.data ?? []) as ObservationUsage[],
  });
}

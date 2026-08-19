import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { requireAdmin, authErrorResponse } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// GET /api/capture-health/earnings-history-rejections
//
// Reads earnings_history_write_rejections — every write the precedence
// trigger (migrations/2026-08-19-earnings-history-precedence-trigger.sql)
// rejected because the incoming date_confidence tier ranked below the
// stored one. Populated by lib/earnings-history-writer.ts's P0001 catch.
// A persistent panel, not a toast: a rejection can happen from a
// background cron with nobody watching, so it has to be visible on the
// next page load, same convention as CaptureHealthPanel/
// CrushCaptureHealthPanel/PriceIntegrityFlagsPanel.
const LOOKBACK_DAYS = 30;
const ROW_LIMIT = 200;

type RejectionRow = {
  id: string;
  symbol: string;
  earnings_date: string;
  quarter_label: string | null;
  attempted_by: string;
  attempted_tier: string;
  attempted_data_source: string | null;
  attempted_timing: string | null;
  stored_tier: string;
  stored_data_source: string;
  stored_earnings_date: string;
  stored_timing: string | null;
  created_at: string;
};

export async function GET() {
  try {
    await requireAdmin();
  } catch (e) {
    return authErrorResponse(e);
  }

  const sb = createServerClient();
  const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const res = await sb
    .from("earnings_history_write_rejections")
    .select(
      "id,symbol,earnings_date,quarter_label,attempted_by,attempted_tier,attempted_data_source,attempted_timing,stored_tier,stored_data_source,stored_earnings_date,stored_timing,created_at",
    )
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(ROW_LIMIT);
  if (res.error) {
    return NextResponse.json({ error: res.error.message }, { status: 500 });
  }

  return NextResponse.json({ rejections: (res.data ?? []) as RejectionRow[] });
}

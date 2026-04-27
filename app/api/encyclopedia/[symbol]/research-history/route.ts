import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// All historical runs of every research module for a single symbol —
// grouped by module_type, newest first within each group. Drives the
// Research tab on /encyclopedia/[symbol], which surfaces a per-module
// version timeline (not just the latest digest).
//
// DB column "valuation_model" is exposed under the friendlier
// "valuation" key in the response so the UI doesn't need to know the
// internal name. The other module types are passed through unchanged.

const DB_TO_KEY: Record<string, string> = {
  business_overview: "business_overview",
  fundamental_health: "fundamental_health",
  catalyst_scanner: "catalyst_scanner",
  valuation_model: "valuation",
  sentiment: "sentiment",
  risk_assessment: "risk_assessment",
};

const RESPONSE_KEYS = [
  "business_overview",
  "fundamental_health",
  "catalyst_scanner",
  "valuation",
  "sentiment",
  "risk_assessment",
] as const;

type ModuleRunRow = {
  id: string;
  symbol: string;
  module_type: string;
  output: unknown;
  is_customized: boolean | null;
  run_at: string;
  expires_at: string | null;
};

type RunView = {
  id: string;
  createdAt: string;
  output: unknown;
  isLatest: boolean;
  isExpired: boolean;
  isCustomized: boolean;
};

export async function GET(
  _req: NextRequest,
  { params }: { params: { symbol: string } },
): Promise<NextResponse> {
  const symbol = (params.symbol ?? "").trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol)) {
    return NextResponse.json({ error: "Invalid symbol" }, { status: 400 });
  }
  const sb = createServerClient();
  const r = await sb
    .from("research_modules")
    .select("*")
    .eq("symbol", symbol)
    .order("run_at", { ascending: false });
  if (r.error) {
    return NextResponse.json({ error: r.error.message }, { status: 500 });
  }
  const rows = (r.data ?? []) as ModuleRunRow[];

  // Bucket by response key. The first row inserted into each bucket is
  // the most recent (since the SELECT is ordered run_at desc) — flag
  // it isLatest=true so the UI can pin it as the headline render.
  const now = Date.now();
  const buckets: Record<string, RunView[]> = {};
  for (const key of RESPONSE_KEYS) buckets[key] = [];
  for (const row of rows) {
    const key = DB_TO_KEY[row.module_type];
    if (!key) continue; // unknown module_type (e.g. 10k_deep_read, technical) — skip
    const bucket = buckets[key];
    bucket.push({
      id: row.id,
      createdAt: row.run_at,
      output: row.output,
      isLatest: bucket.length === 0,
      isExpired:
        row.expires_at !== null && new Date(row.expires_at).getTime() < now,
      isCustomized: !!row.is_customized,
    });
  }

  return NextResponse.json({ modules: buckets });
}

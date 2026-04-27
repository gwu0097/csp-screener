import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// Per-symbol swing-screener appearances. Powers the Swing History tab
// on /encyclopedia/[symbol]. Source is swing_scan_history (one row
// every time a candidate cleared the swing screener for any category)
// — we just sort and de-noise the duplicates from same-day re-scans.

type ScanRow = {
  symbol: string;
  category: string;
  scanned_at: string;
  confidence: string | null;
  signal_basis: string | null;
};

type ScanView = {
  scannedAt: string;
  category: string;
  confidence: string | null;
  signalBasis: string | null;
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
    .from("swing_scan_history")
    .select("symbol,category,scanned_at,confidence,signal_basis")
    .eq("symbol", symbol)
    .order("scanned_at", { ascending: false });
  if (r.error) {
    return NextResponse.json({ error: r.error.message }, { status: 500 });
  }
  const rows = (r.data ?? []) as ScanRow[];

  const scans: ScanView[] = rows.map((row) => ({
    scannedAt: row.scanned_at,
    category: row.category,
    confidence: row.confidence,
    signalBasis: row.signal_basis,
  }));

  return NextResponse.json({
    scans,
    summary: {
      totalAppearances: scans.length,
      categories: Array.from(new Set(scans.map((s) => s.category))).sort(),
    },
  });
}

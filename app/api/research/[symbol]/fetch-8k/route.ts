import { NextRequest, NextResponse } from "next/server";
import { fetchAndStoreEarningsRelease } from "@/lib/earnings-release-capture";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// POST /api/research/[symbol]/fetch-8k
//
// Pulls the most recent EARNINGS 8-K (item 2.02 — Results of
// Operations) filed in the last 90 days, finds the earnings press
// release exhibit (typically *exhibit991*.htm), strips it to plain
// text, asks Perplexity to extract structured numbers, and upserts a
// row into earnings_releases keyed on (symbol, quarter). The caller
// then reads the latest releases via the GET sibling at
// /earnings-releases.
//
// Thin wrapper — the actual logic lives in
// lib/earnings-release-capture.ts (extracted 2026-09-09) so the
// automated Stage A filing-analysis courier can call the exact same
// function directly instead of drifting a duplicate. This route is
// session-gated (no earningsHistoryId — that's only ever known by the
// automated caller's own trigger).
function validSymbol(s: string): boolean {
  return /^[A-Z][A-Z0-9.-]{0,9}$/.test(s);
}

export async function POST(
  _req: NextRequest,
  { params }: { params: { symbol: string } },
): Promise<NextResponse> {
  const symbol = (params.symbol ?? "").trim().toUpperCase();
  if (!validSymbol(symbol)) {
    return NextResponse.json({ error: "Invalid symbol" }, { status: 400 });
  }
  const result = await fetchAndStoreEarningsRelease(symbol);
  if (!result.ok) {
    return NextResponse.json(
      {
        error: result.error,
        ...(result.scanned !== undefined ? { scanned: result.scanned } : {}),
        ...(result.rawSnippet !== undefined ? { rawSnippet: result.rawSnippet } : {}),
      },
      { status: result.status },
    );
  }
  return NextResponse.json({
    ok: true,
    quarter: result.quarter,
    accessionNumber: result.accessionNumber,
    filingDate: result.filingDate,
    exhibitUrl: result.exhibitUrl,
    archiveUrl: result.archiveUrl,
    row: result.row,
  });
}

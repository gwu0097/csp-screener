import { NextRequest, NextResponse } from "next/server";
import { requireCronSecret } from "@/lib/cron-auth";
import { resolveAdminUserId } from "@/lib/schwab-account-import";
import { runDeferredEnrichment } from "@/lib/import-enrichment";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const maxDuration = 60;

// POST /api/schwab-account/enrich-imports[?symbol=XYZ]
//
// The market-data half of a Schwab Account Data import, split off the
// poll request so the poll stays inside Vercel's 60s limit (two polls
// timed out on 2026-10-20). Finds its own unfinished work — see
// runDeferredEnrichment — so a skipped or failed call is caught up by
// the next one. ?symbol= narrows to one ticker and re-classifies its
// trade chains; without it, sweeps leftovers. Response `remaining` > 0
// means call again.
//
// Auth: Authorization: Bearer $CRON_SECRET, same gate as the poll.
export async function POST(req: NextRequest) {
  const denied = requireCronSecret(req);
  if (denied) return denied;

  const symbolParam = req.nextUrl.searchParams.get("symbol");
  if (symbolParam !== null && !/^[A-Za-z$][A-Za-z0-9.\/\-]{0,11}$/.test(symbolParam)) {
    return NextResponse.json({ ok: false, error: "invalid symbol" }, { status: 400 });
  }

  try {
    const userId = await resolveAdminUserId();
    const startedMs = Date.now();
    const r = await runDeferredEnrichment(userId, { symbol: symbolParam ?? undefined });
    console.log(
      `[enrich-imports] symbol=${symbolParam ?? "*"} stamped=${r.stamped} close_snapshots=${r.closeSnapshots} reclassified=${r.reclassified.join(",") || "-"} remaining=${r.remaining} ms=${Date.now() - startedMs}`,
    );
    return NextResponse.json({ ok: true, ...r });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown";
    console.error("[enrich-imports] fatal:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

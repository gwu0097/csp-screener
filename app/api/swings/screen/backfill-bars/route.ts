import { NextRequest, NextResponse } from "next/server";
import { backfillDailyBars } from "@/lib/swing-screener";

export const dynamic = "force-dynamic";
// Universe & Themes, Phase B — pre-flight bar backfill, called by the
// client before pass1 (see swing-screen-view.tsx's runScreen) for
// whichever universe was selected. No auth: like pass1/pass2/pass3, this
// only touches the shared daily_bars_cache, never user-scoped data.
//
// Processes exactly the `symbols` chunk it's given — the client chunks a
// large resolved universe into sequential calls, same pattern as RS
// Pullback's enrichment, and always runs this phase to completion before
// pass1/pass2/RS Pullback start.
export const maxDuration = 60;

export async function POST(req: NextRequest): Promise<NextResponse> {
  const started = Date.now();
  let body: { symbols?: unknown; forceFresh?: unknown };
  try {
    body = (await req.json()) as { symbols?: unknown; forceFresh?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!Array.isArray(body.symbols)) {
    return NextResponse.json({ error: "Missing symbols array" }, { status: 400 });
  }
  const symbols = body.symbols.filter((s): s is string => typeof s === "string");
  try {
    const result = await backfillDailyBars(symbols, { forceFresh: body.forceFresh === true });
    return NextResponse.json({ ...result, durationMs: Date.now() - started });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "backfill failed";
    console.error("[swings/screen/backfill-bars] failed:", e);
    return NextResponse.json({ error: `Backfill: ${msg}` }, { status: 500 });
  }
}

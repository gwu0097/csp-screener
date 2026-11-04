import { NextRequest, NextResponse } from "next/server";
import { requireUserId, authErrorResponse } from "@/lib/auth";
import { parseSourceChoice } from "@/lib/robinhood-calendar-validate";
import { saveSourceChoice } from "@/lib/earnings-source-choices";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// POST /api/screener/earnings-source
//   { symbol, conflictKey, chosenSource: "finnhub"|"robinhood"|"user",
//     chosenDate: YYYY-MM-DD, chosenTiming: "BMO"|"AMC" }
// Saves the user's answer to a flagged Screen Today row ("Dates differ"
// / "RH only" / "Timing?"). Personal data: scoped by requireUserId()
// and stamped with user_id. The next Screen Today run applies it
// (lib/earnings-source-merge.ts) for as long as the same disagreement
// stands.
export async function POST(req: NextRequest) {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch (e) {
    return authErrorResponse(e);
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = parseSourceChoice(body);
  if ("error" in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });
  try {
    await saveSourceChoice(userId, parsed);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}

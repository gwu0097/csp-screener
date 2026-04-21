import { NextRequest, NextResponse } from "next/server";
import { saveManualTokens } from "@/lib/schwab";

export const dynamic = "force-dynamic";

type Body = { access_token?: unknown; refresh_token?: unknown };

export async function POST(req: NextRequest) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (typeof body.access_token !== "string" || body.access_token.trim().length === 0) {
    return NextResponse.json({ error: "Missing access_token" }, { status: 400 });
  }
  if (typeof body.refresh_token !== "string" || body.refresh_token.trim().length === 0) {
    return NextResponse.json({ error: "Missing refresh_token" }, { status: 400 });
  }
  try {
    await saveManualTokens({
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
    });
    console.log("[schwab-manual] tokens saved");
    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "failed";
    console.error("[schwab-manual] save failed:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

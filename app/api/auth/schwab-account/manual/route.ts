import { NextRequest, NextResponse } from "next/server";
import { saveManualAcctTokens } from "@/lib/schwab-account";
import { authErrorResponse, requireAdmin } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// Manual-paste escape hatch for the Account Data connection — same
// purpose as /api/auth/schwab/manual, for testing this connection
// ahead of/without a working registered callback URL.
type Body = { access_token?: unknown; refresh_token?: unknown };

export async function POST(req: NextRequest) {
  try {
    await requireAdmin();
  } catch (e) {
    return authErrorResponse(e);
  }
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
    await saveManualAcctTokens({
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
    });
    console.log("[schwab-acct-manual] tokens saved");
    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "failed";
    console.error("[schwab-acct-manual] save failed:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

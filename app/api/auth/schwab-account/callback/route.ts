import { NextRequest, NextResponse } from "next/server";
import { exchangeAcctCodeForTokens } from "@/lib/schwab-account";
import { authErrorResponse, requireAdmin } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(req: NextRequest) {
  try {
    await requireAdmin();
  } catch (e) {
    return authErrorResponse(e);
  }
  console.log("[schwab-acct-callback] hit at", new Date().toISOString());
  console.log("[schwab-acct-callback] query keys present:", Object.keys(Object.fromEntries(req.nextUrl.searchParams.entries())));

  const code = req.nextUrl.searchParams.get("code");
  const error = req.nextUrl.searchParams.get("error");
  const errorDescription = req.nextUrl.searchParams.get("error_description");
  const origin = process.env.NEXT_PUBLIC_APP_URL ?? req.nextUrl.origin;

  if (error) {
    console.error("[schwab-acct-callback] Schwab returned error:", error, errorDescription);
    const reason = encodeURIComponent(`${error}: ${errorDescription ?? "no description"}`);
    return NextResponse.redirect(`${origin}/settings?schwabAcct=error&reason=${reason}`);
  }

  if (!code) {
    console.error("[schwab-acct-callback] no code in callback params — redirect_uri mismatch likely");
    return NextResponse.redirect(`${origin}/settings?schwabAcct=error&reason=missing_code`);
  }

  console.log("[schwab-acct-callback] received code (first 8 chars):", code.slice(0, 8) + "…");

  try {
    await exchangeAcctCodeForTokens(code);
    console.log("[schwab-acct-callback] token exchange succeeded");
    return NextResponse.redirect(`${origin}/settings?schwabAcct=connected`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown";
    console.error("[schwab-acct-callback] token exchange failed:", msg);
    return NextResponse.redirect(`${origin}/settings?schwabAcct=error&reason=${encodeURIComponent(msg)}`);
  }
}

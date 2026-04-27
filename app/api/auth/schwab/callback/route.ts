import { NextRequest, NextResponse } from "next/server";
import { exchangeCodeForTokens } from "@/lib/schwab";

export const dynamic = "force-dynamic";
// Single Schwab token-exchange round-trip — fast, but bump above the
// hobby-default safety net just in case Schwab's auth host stalls.
export const maxDuration = 30;

export async function GET(req: NextRequest) {
  const params = Object.fromEntries(req.nextUrl.searchParams.entries());
  console.log("[schwab-callback] hit at", new Date().toISOString());
  console.log("[schwab-callback] url:", req.nextUrl.toString());
  console.log("[schwab-callback] all query params:", params);
  console.log("[schwab-callback] headers:", {
    host: req.headers.get("host"),
    "user-agent": req.headers.get("user-agent"),
    referer: req.headers.get("referer"),
  });

  const code = req.nextUrl.searchParams.get("code");
  const error = req.nextUrl.searchParams.get("error");
  const errorDescription = req.nextUrl.searchParams.get("error_description");
  const origin = process.env.NEXT_PUBLIC_APP_URL ?? req.nextUrl.origin;

  if (error) {
    console.error("[schwab-callback] Schwab returned error:", error, errorDescription);
    const reason = encodeURIComponent(`${error}: ${errorDescription ?? "no description"}`);
    return NextResponse.redirect(`${origin}/settings?schwab=error&reason=${reason}`);
  }

  if (!code) {
    console.error("[schwab-callback] no code in callback params — redirect_uri mismatch likely");
    return NextResponse.redirect(`${origin}/settings?schwab=error&reason=missing_code`);
  }

  console.log("[schwab-callback] received code (first 8 chars):", code.slice(0, 8) + "…");

  try {
    await exchangeCodeForTokens(code);
    console.log("[schwab-callback] token exchange succeeded");
    return NextResponse.redirect(`${origin}/settings?schwab=connected`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown";
    console.error("[schwab-callback] token exchange failed:", msg);
    return NextResponse.redirect(`${origin}/settings?schwab=error&reason=${encodeURIComponent(msg)}`);
  }
}

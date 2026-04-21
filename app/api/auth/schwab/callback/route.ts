import { NextRequest, NextResponse } from "next/server";
import { exchangeCodeForTokens } from "@/lib/schwab";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  const origin = process.env.NEXT_PUBLIC_APP_URL ?? req.nextUrl.origin;
  if (!code) {
    return NextResponse.redirect(`${origin}/settings?schwab=error&reason=missing_code`);
  }
  try {
    await exchangeCodeForTokens(code);
    return NextResponse.redirect(`${origin}/settings?schwab=connected`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown";
    return NextResponse.redirect(`${origin}/settings?schwab=error&reason=${encodeURIComponent(msg)}`);
  }
}

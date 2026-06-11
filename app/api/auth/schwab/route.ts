import { NextResponse } from "next/server";
import { disconnectSchwab, getSchwabAuthUrl } from "@/lib/schwab";
import { authErrorResponse, requireAdmin } from "@/lib/auth";

export const dynamic = "force-dynamic";

// The Schwab connection belongs to the admin — members consume the
// shared market data but can't connect/disconnect/reconnect it.
export async function GET() {
  try {
    await requireAdmin();
  } catch (e) {
    return authErrorResponse(e);
  }
  const url = getSchwabAuthUrl();
  console.log("[schwab-auth] redirecting to authorize URL:", url);
  console.log("[schwab-auth] env check:", {
    clientIdPresent: Boolean(process.env.SCHWAB_CLIENT_ID),
    clientSecretPresent: Boolean(process.env.SCHWAB_CLIENT_SECRET),
    redirectUri: process.env.SCHWAB_REDIRECT_URI,
  });
  return NextResponse.redirect(url);
}

export async function DELETE() {
  try {
    await requireAdmin();
  } catch (e) {
    return authErrorResponse(e);
  }
  try {
    await disconnectSchwab();
    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

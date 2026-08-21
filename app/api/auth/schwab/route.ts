import { NextRequest, NextResponse } from "next/server";
import { disconnectSchwab, getSchwabAuthUrl, CHAIN_BOTH_STATE } from "@/lib/schwab";
import { authErrorResponse, requireAdmin } from "@/lib/auth";

export const dynamic = "force-dynamic";

// The Schwab connection belongs to the admin — members consume the
// shared market data but can't connect/disconnect/reconnect it.
//
// ?chain=1 — entry point for "Reconnect both" (settings-view.tsx):
// tags this leg's authorize request with a state value the callback
// recognizes, so a successful exchange here redirects onward into the
// Account Data app's own authorize flow instead of stopping at
// /settings. Each app still needs its own Schwab consent screen (two
// separate client_ids, no way around that) — this just chains the
// two redirects instead of making the user find two separate buttons.
export async function GET(req: NextRequest) {
  try {
    await requireAdmin();
  } catch (e) {
    return authErrorResponse(e);
  }
  const chained = req.nextUrl.searchParams.get("chain") === "1";
  const url = getSchwabAuthUrl(chained ? CHAIN_BOTH_STATE : undefined);
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
